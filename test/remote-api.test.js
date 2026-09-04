"use strict";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const http = require("node:http");

const { createRemoteRouter, secretsMatch } = require("../lib/remote-api");

const TOKEN = "team-secret-token";
const IDENTITY = { id: "01a06b8a-ea9a-7432-9b57-42a1c1563282", name: "ahsan" };

function serve({ token = TOKEN, overrides = {} } = {}) {
  const calls = { review: [], resume: [] };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/remote",
    createRemoteRouter({
      token,
      identity: IDENTITY,
      describe: async ({ includeUsage } = {}) => ({
        host: "ahsan",
        hostLogin: "ahsan-amin-wego",
        slots: { capacity: 1, running: 0, queued: 0, free: 1, available: true },
        providers: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }],
        defaultProvider: "claude",
        ...(includeUsage ? { usage: { ok: true, windows: [{ left: 82 }] } } : {}),
      }),
      submitReview: async (args) => {
        calls.review.push(args);
        return { jobId: "job-1", prUrl: args.prUrl, provider: args.provider || "claude" };
      },
      describeJob: (id) =>
        id === "job-1"
          ? { id: "job-1", state: "done", provider: "codex", hasSession: true, prUrl: "https://x/pull/1" }
          : null,
      resumeReview: async (id, opts) => {
        calls.resume.push({ id, ...opts });
        return { ok: true, jobId: id };
      },
      ...overrides,
    }),
  );

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/api/remote`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const call = async (base, path, { token = TOKEN, method = "GET", body = null, header = "Authorization" } = {}) => {
  const headers = {};
  if (token !== null) headers[header] = header === "Authorization" ? `Bearer ${token}` : token;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("an instance with no token configured refuses remote control outright", async () => {
  const s = await serve({ token: "" });
  try {
    const res = await call(s.base, "/status", { token: null });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "REMOTE_DISABLED");
    // The message has to name the switch, or the host cannot act on it.
    assert.match(res.body.error, /PRSNOOZE_REMOTE_TOKEN/);
  } finally {
    await s.close();
  }
});

test("a missing and a wrong token get the same answer, with no detail", async () => {
  const s = await serve();
  try {
    const missing = await call(s.base, "/status", { token: null });
    const wrong = await call(s.base, "/status", { token: "not-the-token" });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(missing.body, wrong.body);
    assert.equal(wrong.body.error, "unauthorized");
  } finally {
    await s.close();
  }
});

test("no route leaks anything before the token is checked", async () => {
  const s = await serve();
  try {
    for (const [method, path] of [["GET", "/status"], ["POST", "/review"], ["GET", "/jobs/job-1"], ["POST", "/jobs/job-1/resume"]]) {
      const res = await call(s.base, path, { token: "wrong", method, body: method === "POST" ? {} : null });
      assert.equal(res.status, 401, `${method} ${path} answered ${res.status}`);
    }
    assert.deepEqual(s.calls.review, [], "an unauthorized request must never reach the queue");
    assert.deepEqual(s.calls.resume, []);
  } finally {
    await s.close();
  }
});

test("either header form carries the token, so a plain curl works too", async () => {
  const s = await serve();
  try {
    const bearer = await call(s.base, "/status");
    const direct = await call(s.base, "/status", { header: "x-prsnooze-token" });
    assert.equal(bearer.status, 200);
    assert.equal(direct.status, 200);
  } finally {
    await s.close();
  }
});

test("status answers the question a colleague is actually asking: is a slot free", async () => {
  const s = await serve();
  try {
    const res = await call(s.base, "/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.slots.available, true);
    assert.equal(res.body.instance.shortId, "01a06b8a");
    assert.equal(res.body.instance.name, "ahsan");
    // Whose identity signs the review is part of the answer, not a footnote.
    assert.equal(res.body.hostLogin, "ahsan-amin-wego");
    assert.deepEqual(res.body.providers.map((p) => p.id), ["claude", "codex"]);
  } finally {
    await s.close();
  }
});

test("plan usage is only read when asked for, because it costs a CLI round trip", async () => {
  const s = await serve();
  try {
    assert.equal((await call(s.base, "/status")).body.usage, undefined);
    assert.equal((await call(s.base, "/status?usage=1")).body.usage.ok, true);
  } finally {
    await s.close();
  }
});

test("a queued review comes back with a portable ref naming the instance", async () => {
  const s = await serve();
  try {
    const res = await call(s.base, "/review", {
      method: "POST",
      body: { prUrl: "https://github.com/o/r/pull/1", provider: "codex" },
    });
    assert.equal(res.status, 202);
    // The ref carries the instance short id, not the caller's nickname, so it
    // means the same review in every colleague's CLI.
    assert.equal(res.body.ref, "01a06b8a/job-1");
    assert.equal(res.body.provider, "codex");
    assert.deepEqual(s.calls.review, [{ prUrl: "https://github.com/o/r/pull/1", provider: "codex" }]);
  } finally {
    await s.close();
  }
});

test("a rejected submission keeps the server's status code and reason", async () => {
  const s = await serve({
    overrides: {
      submitReview: async () => {
        const e = new Error("review provider is not available: gemini");
        e.status = 400;
        e.code = "UNKNOWN_PROVIDER";
        throw e;
      },
    },
  });
  try {
    const res = await call(s.base, "/review", { method: "POST", body: { prUrl: "https://x/pull/1", provider: "gemini" } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "UNKNOWN_PROVIDER");
  } finally {
    await s.close();
  }
});

test("a job report says whether resume is even possible", async () => {
  const s = await serve();
  try {
    const found = await call(s.base, "/jobs/job-1");
    assert.equal(found.status, 200);
    assert.equal(found.body.hasSession, true);
    assert.equal(found.body.ref, "01a06b8a/job-1");
    assert.equal((await call(s.base, "/jobs/nope")).status, 404);
  } finally {
    await s.close();
  }
});

test("resume reaches the same gate the browser uses, and force is passed through", async () => {
  const s = await serve();
  try {
    await call(s.base, "/jobs/job-1/resume", { method: "POST", body: {} });
    await call(s.base, "/jobs/job-1/resume", { method: "POST", body: { force: true } });
    assert.deepEqual(s.calls.resume, [
      { id: "job-1", force: false },
      { id: "job-1", force: true },
    ]);
  } finally {
    await s.close();
  }
});

test("a refused resume hands back what would override it", async () => {
  const s = await serve({
    overrides: {
      resumeReview: async () => {
        const e = new Error("nothing new since the last review");
        e.status = 409;
        e.code = "NOT_RESUMABLE";
        e.forcible = true;
        e.assessment = { resumable: false, code: "UNCHANGED" };
        throw e;
      },
    },
  });
  try {
    const res = await call(s.base, "/jobs/job-1/resume", { method: "POST", body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.forcible, true);
    assert.equal(res.body.assessment.code, "UNCHANGED");
  } finally {
    await s.close();
  }
});

test("token comparison does not depend on length or content shortcuts", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abc", "abd"), false);
  assert.equal(secretsMatch("abc", "abcdef"), false);
  assert.equal(secretsMatch("", ""), false);
  assert.equal(secretsMatch(null, "abc"), false);
  assert.equal(secretsMatch("abc", undefined), false);
});
