"use strict";

// How prsnooze reaches GitHub.
//
// The bug behind these: prsnooze cloned and fetched over SSH, which works when
// a person starts it in a terminal (their ssh-agent holds the unlocked key) and
// fails the moment it runs as a background service, which gets its own empty
// agent. "Permission denied (publickey)" on a machine where `git fetch` by hand
// is fine. So HTTPS with the token gh already holds is the default, there is no
// agent in that path to be missing, and old SSH clones move over on their own.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { transport, remoteUrl, credentialArgs, gitEnv, ensureRemote } = require("../lib/git-ops");

// Async on purpose: the transport is read after the first await inside
// ensureRemote, so a synchronous try/finally would restore the env before the
// code under test ever looked at it.
async function withTransport(value, fn) {
  const saved = process.env.PRSNOOZE_GIT_TRANSPORT;
  if (value === undefined) delete process.env.PRSNOOZE_GIT_TRANSPORT;
  else process.env.PRSNOOZE_GIT_TRANSPORT = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PRSNOOZE_GIT_TRANSPORT;
    else process.env.PRSNOOZE_GIT_TRANSPORT = saved;
  }
}

// A throwaway repo with an origin, so the remote logic can be exercised without
// touching the network.
function repoWithOrigin(url) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-git-")));
  execFileSync("git", ["init", "--quiet", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
  return dir;
}

const originOf = (dir) =>
  execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();

test("https is the default, because a service has no ssh-agent", async () => {
  await withTransport(undefined, () => {
    assert.equal(transport(), "https");
    assert.equal(remoteUrl("acme", "widgets"), "https://github.com/acme/widgets.git");
  });
});

test("a host can still choose ssh explicitly", async () => {
  await withTransport("ssh", () => {
    assert.equal(transport(), "ssh");
    assert.equal(remoteUrl("acme", "widgets"), "git@github.com:acme/widgets.git");
    // Nothing to hand git: ssh carries its own credentials.
    assert.deepEqual(credentialArgs(), []);
  });
});

test("the credential helper is scoped to github.com and resets the inherited chain", async () => {
  await withTransport(undefined, () => {
    const args = credentialArgs();
    // Reset first, then ours: a broken or interactive helper in the host's
    // global config must not get in front of it.
    assert.equal(args[1], "credential.https://github.com.helper=");
    assert.match(args[3], /^credential\.https:\/\/github\.com\.helper=!.*auth git-credential$/);
    assert.ok(!args.some((a) => /credential\.helper=/.test(a)), "never a host-wide helper");
  });
});

test("git is never left waiting for a human", () => {
  const env = gitEnv();
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
});

test("an old SSH clone is moved to https instead of being re-cloned", async () => {
  const dir = repoWithOrigin("git@github.com:acme/widgets.git");
  const logs = [];
  await withTransport(undefined, () =>
    ensureRemote({ repoPath: dir, owner: "acme", repo: "widgets", onLog: (m) => logs.push(m) }),
  );
  assert.equal(originOf(dir), "https://github.com/acme/widgets.git");
  assert.match(logs.join("\n"), /HTTPS/);
});

test("choosing ssh moves the clone back", async () => {
  const dir = repoWithOrigin("https://github.com/acme/widgets.git");
  await withTransport("ssh", () =>
    ensureRemote({ repoPath: dir, owner: "acme", repo: "widgets" }),
  );
  assert.equal(originOf(dir), "git@github.com:acme/widgets.git");
});

test("a remote the host pointed somewhere deliberate is left alone", async () => {
  const mirror = "https://git.internal.example.com/mirrors/acme-widgets.git";
  const dir = repoWithOrigin(mirror);
  await withTransport(undefined, () =>
    ensureRemote({ repoPath: dir, owner: "acme", repo: "widgets" }),
  );
  assert.equal(originOf(dir), mirror);
});
