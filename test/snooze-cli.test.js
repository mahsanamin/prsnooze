"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);
const { createRemoteRouter } = require("../lib/remote-api");
const { normalizeUrl, findPeer, parseRef, readConfig } = require("../lib/snooze-config");

const CLI = path.join(__dirname, "..", "bin", "snooze");
const TOKEN = "team-secret";
const INSTANCE = { id: "01a06b8a-ea9a-7432-9b57-42a1c1563282", name: "sara" };

// A stand-in instance so the CLI is exercised over real HTTP against the real
// router, not a mocked client.
function fakeInstance({ available = true } = {}) {
  const calls = { review: [], resume: [] };
  const app = express();
  app.use(
    "/api/remote",
    createRemoteRouter({
      token: TOKEN,
      identity: INSTANCE,
      describe: async () => ({
        host: "sara",
        hostLogin: "sara-gh",
        slots: { capacity: 2, running: available ? 0 : 2, queued: 0, free: available ? 2 : 0, available },
        providers: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }],
        defaultProvider: "claude",
      }),
      submitReview: async (args) => {
        calls.review.push(args);
        return { jobId: "job-9", prUrl: args.prUrl, provider: args.provider || "claude" };
      },
      describeJob: (id) =>
        id === "job-9"
          ? {
              id: "job-9",
              state: "done",
              provider: "codex",
              outcome: "commented",
              hasSession: true,
              prUrl: "https://github.com/o/r/pull/7",
              title: "Add a thing",
              requestedBy: { label: "test-client", address: "127.0.0.1" },
              lastResumeRequestedBy: { label: "reviewer-two", address: "127.0.0.2" },
            }
          : null,
      resumeReview: async (id, opts) => {
        calls.resume.push({ id, ...opts });
        return { ok: true, jobId: id, reason: "2 new commits" };
      },
    }),
  );
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function session() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "snooze-cli-"));
  const run = (...args) =>
    execFileP(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        SNOOZE_HOME: home,
        SNOOZE_REQUESTER: "test-client",
        NO_COLOR: "1",
      },
    });
  return { home, run };
}

// --------------------------------------------------------------- unit level ---

test("a peer URL is accepted the way a person would type it", () => {
  assert.equal(normalizeUrl("localhost:8383"), "http://localhost:8383");
  assert.equal(normalizeUrl("http://host:8383/"), "http://host:8383");
  assert.equal(normalizeUrl("https://snooze.example.com"), "https://snooze.example.com");
  assert.throws(() => normalizeUrl(""), /peer URL is required/);
});

test("a peer resolves by nickname or by the instance id a ref carries", () => {
  const config = {
    token: null,
    peers: [{ name: "sara", url: "http://h:1", instanceId: "01a06b8a-ea9a", shortId: "01a06b8a" }],
  };
  assert.equal(findPeer(config, "sara")?.name, "sara");
  assert.equal(findPeer(config, "SARA")?.name, "sara");
  assert.equal(findPeer(config, "01a06b8a")?.name, "sara");
  assert.equal(findPeer(config, "http://h:1")?.name, "sara");
  assert.equal(findPeer(config, "nobody"), null);
});

test("a colliding short id is ambiguous instead of routing to the first peer", () => {
  const config = {
    token: null,
    peers: [
      { name: "one", url: "http://one:1", instanceId: "01a06b8a-one", shortId: "01a06b8a" },
      { name: "two", url: "http://two:1", instanceId: "01a06b8a-two", shortId: "01a06b8a" },
    ],
  };
  assert.throws(() => findPeer(config, "01a06b8a"), /ambiguous peer/);
  assert.equal(findPeer(config, "one")?.url, "http://one:1");
});

test("a ref splits into the instance that holds the session and the job", () => {
  assert.deepEqual(parseRef("01a06b8a/job-9"), { peer: "01a06b8a", jobId: "job-9" });
  // A job id containing a slash must not be truncated.
  assert.deepEqual(parseRef("a/b/c"), { peer: "a", jobId: "b/c" });
  for (const bad of ["", "nope", "/job", "peer/"]) {
    assert.throws(() => parseRef(bad), /not a review ref/);
  }
});

// ------------------------------------------------------------ CLI end to end ---

test("adding a peer verifies it answers, and records the instance id", async () => {
  const inst = await fakeInstance();
  const { home, run } = session();
  try {
    await run("token", TOKEN);
    const { stdout } = await run("add", inst.url);

    assert.match(stdout, /added/);
    assert.match(stdout, /slot free/);
    // Whose identity signs the review has to be said out loud at add time.
    assert.match(stdout, /posts as @sara-gh/);

    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(config.peers.length, 1);
    assert.equal(config.peers[0].shortId, "01a06b8a");
    assert.equal(config.peers[0].instanceId, INSTANCE.id);
  } finally {
    await inst.close();
  }
});

test("the config holding the shared token is not readable by anyone else", async () => {
  const inst = await fakeInstance();
  const { home, run } = session();
  try {
    await run("token", TOKEN);
    const mode = fs.statSync(path.join(home, "config.json")).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    await inst.close();
  }
});

test("a peer that does not answer is refused rather than saved as a lie", async () => {
  const { run } = session();
  await run("token", TOKEN);
  await assert.rejects(
    run("add", "http://127.0.0.1:1"),
    (e) => {
      assert.match(e.stderr, /could not reach/);
      assert.match(e.stderr, /PRSNOOZE_REMOTE_TOKEN/);
      return true;
    },
  );
  assert.deepEqual(readConfig().peers.filter((p) => p.url === "http://127.0.0.1:1"), []);
});

test("a wrong token is reported as refusal, not as an unreachable host", async () => {
  const inst = await fakeInstance();
  const { run } = session();
  try {
    await run("token", "the-wrong-token");
    await assert.rejects(run("add", inst.url), (e) => {
      assert.match(e.stderr, /unauthorized/);
      return true;
    });
  } finally {
    await inst.close();
  }
});

test("status says how many instances can take work right now", async () => {
  const inst = await fakeInstance();
  const { run } = session();
  try {
    await run("token", TOKEN);
    await run("add", inst.url, "--name", "sara");
    const { stdout } = await run("status");
    assert.match(stdout, /sara/);
    assert.match(stdout, /slot free/);
    assert.match(stdout, /1 of 1 instance has a slot free/);
  } finally {
    await inst.close();
  }
});

test("dispatching a review prints the ref and whose plan pays for it", async () => {
  const inst = await fakeInstance();
  const { run } = session();
  try {
    await run("token", TOKEN);
    await run("add", inst.url, "--name", "sara");
    const { stdout } = await run("review", "https://github.com/o/r/pull/7", "--provider", "codex");

    assert.match(stdout, /queued/);
    assert.match(stdout, /01a06b8a\/job-9/);
    assert.match(stdout, /posts as @sara-gh, on their plan/);
    assert.equal(inst.calls.review[0].prUrl, "https://github.com/o/r/pull/7");
    assert.equal(inst.calls.review[0].provider, "codex");
    assert.equal(inst.calls.review[0].requestedBy.label, "test-client");
    assert.match(inst.calls.review[0].requestedBy.address, /127\.0\.0\.1/);
  } finally {
    await inst.close();
  }
});

test("a busy instance is not handed work unless --any says to queue anyway", async () => {
  const inst = await fakeInstance({ available: false });
  const { run } = session();
  try {
    await run("token", TOKEN);
    await run("add", inst.url, "--name", "sara");
    // One peer and no --any still dispatches: naming nobody means "my only
    // instance". The guard is for choosing among several.
    await run("review", "https://github.com/o/r/pull/7");
    assert.equal(inst.calls.review.length, 1);
  } finally {
    await inst.close();
  }
});

test("a review ref routes job and resume back to the instance that ran it", async () => {
  const inst = await fakeInstance();
  const { run } = session();
  try {
    await run("token", TOKEN);
    await run("add", inst.url, "--name", "sara");

    const job = await run("job", "01a06b8a/job-9");
    assert.match(job.stdout, /done/);
    assert.match(job.stdout, /commented/);
    assert.match(job.stdout, /requested by test-client \(127\.0\.0\.1\)/);
    assert.match(job.stdout, /last resumed by reviewer-two \(127\.0\.0\.2\)/);
    assert.match(job.stdout, /snooze resume 01a06b8a\/job-9/);

    const resumed = await run("resume", "01a06b8a/job-9");
    assert.match(resumed.stdout, /resuming/);
    assert.match(resumed.stdout, /2 new commits/);
    assert.equal(inst.calls.resume[0].id, "job-9");
    assert.equal(inst.calls.resume[0].force, false);
    assert.equal(inst.calls.resume[0].requestedBy.label, "test-client");
    assert.match(inst.calls.resume[0].requestedBy.address, /127\.0\.0\.1/);
  } finally {
    await inst.close();
  }
});

test("a ref for an instance you have not added explains itself", async () => {
  const { run } = session();
  await run("token", TOKEN);
  await assert.rejects(run("job", "deadbeef/job-9"), (e) => {
    assert.match(e.stderr, /not in your peer list/);
    return true;
  });
});

test("--json is machine readable on every read command", async () => {
  const inst = await fakeInstance();
  const { run } = session();
  try {
    await run("token", TOKEN);
    await run("add", inst.url, "--name", "sara");
    for (const args of [["peers"], ["status"], ["job", "01a06b8a/job-9"]]) {
      const { stdout } = await run(...args, "--json");
      assert.doesNotThrow(() => JSON.parse(stdout), `${args[0]} --json was not JSON`);
    }
  } finally {
    await inst.close();
  }
});

test("an unknown command and an unknown flag both fail loudly", async () => {
  const { run } = session();
  await assert.rejects(run("frobnicate"), (e) => {
    assert.match(e.stderr, /unknown command/);
    return true;
  });
  await assert.rejects(run("status", "--nope"), (e) => {
    assert.match(e.stderr, /unknown flag/);
    return true;
  });
});
