"use strict";

// Auto-resume spends the host's plan with nobody watching. These tests pin
// that it only follows up on new commits, once per pushed head, and only on
// reviews that left something to fix.

const test = require("node:test");
const assert = require("node:assert");
const { createAutoResumer, pickCandidates } = require("../lib/auto-resume");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function job(over = {}) {
  return {
    id: "job-1",
    prUrl: "https://github.com/acme/app/pull/7",
    state: "done",
    outcome: "commented",
    sessionId: "session-1",
    createdAt: NOW - DAY,
    finishedAt: NOW - DAY + 60_000,
    ...over,
  };
}

const pushed = (head = "bbb") => ({
  resumable: true,
  code: "HAS_UPDATES",
  signals: { newCommitCount: 1, headMoved: true, headRefOid: head },
});

function setup({ jobs = [job()], assessment = pushed(), resume } = {}) {
  const resumed = [];
  const resumer = createAutoResumer({
    listJobs: () => jobs,
    hasSession: (j) => !!j.sessionId,
    assess: async () => (typeof assessment === "function" ? assessment() : assessment),
    resume: resume || (async (id, options) => { resumed.push({ id, options }); }),
    now: () => NOW,
  });
  return { resumer, resumed, jobs };
}

test("new commits after a commented review resume that review", async () => {
  const { resumer, resumed } = setup();
  await resumer.pollOnce();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].id, "job-1");
  assert.equal(resumed[0].options.requestedBy.source, "auto-resume");
  assert.equal(resumer.status().lastError, null);
});

test("each pushed head is followed up once", async () => {
  let head = "bbb";
  const { resumer, resumed } = setup({ assessment: () => pushed(head) });
  await resumer.pollOnce();
  await resumer.pollOnce();
  assert.equal(resumed.length, 1, "the same head must not resume twice");
  head = "ccc";
  await resumer.pollOnce();
  assert.equal(resumed.length, 2, "a later push is followed up again");
});

test("a reply without a push does not resume", async () => {
  const { resumer, resumed } = setup({
    assessment: { resumable: true, code: "HAS_UPDATES", signals: { newCommitCount: 0, headMoved: false, replyCount: 2 } },
  });
  await resumer.pollOnce();
  assert.equal(resumed.length, 0);
});

test("the resume gate still has the last word", async () => {
  const { resumer, resumed } = setup({
    assessment: { resumable: false, code: "APPROVED", signals: { newCommitCount: 3, headMoved: true, headRefOid: "x" } },
  });
  await resumer.pollOnce();
  assert.equal(resumed.length, 0);
});

test("a refused resume is retried on the next check", async () => {
  let refuse = true;
  const resumed = [];
  const { resumer } = setup({
    resume: async (id) => {
      if (refuse) throw new Error("This PRSnooze instance is not accepting new reviews.");
      resumed.push(id);
    },
  });
  await resumer.pollOnce();
  assert.match(resumer.status().lastError, /not accepting new reviews/);
  refuse = false;
  await resumer.pollOnce();
  assert.deepEqual(resumed, ["job-1"]);
  assert.equal(resumer.status().lastError, null);
});

test("only the newest finished review per PR with something to fix is a candidate", () => {
  const prState = (url) => (url.endsWith("/9") ? { state: "MERGED" } : { state: "OPEN" });
  const picked = pickCandidates([
    job({ id: "old", createdAt: NOW - 3 * DAY }),
    job({ id: "new", createdAt: NOW - DAY }),
    job({ id: "approved", prUrl: "https://github.com/acme/app/pull/2", outcome: "approved" }),
    job({ id: "failed", prUrl: "https://github.com/acme/app/pull/3", state: "failed" }),
    job({ id: "skipped", prUrl: "https://github.com/acme/app/pull/4", skipped: true }),
    job({ id: "no-session", prUrl: "https://github.com/acme/app/pull/5", sessionId: null }),
    job({ id: "stale", prUrl: "https://github.com/acme/app/pull/6", finishedAt: NOW - 30 * DAY }),
    job({ id: "running", prUrl: "https://github.com/acme/app/pull/8", state: "running" }),
    job({ id: "merged", prUrl: "https://github.com/acme/app/pull/9" }),
  ], { now: NOW, prState, hasSession: (j) => !!j.sessionId });
  assert.deepEqual(picked.map((j) => j.id), ["new"]);
});
