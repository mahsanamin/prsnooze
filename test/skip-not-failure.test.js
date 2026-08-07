"use strict";

// A merged or closed PR is not a failure. Nothing broke; there is just no PR
// left to review, which usually means it merged while the job sat in the queue.
// It used to surface as a red FAILED row with an error code, which reads as
// "something is wrong, go look at this" for a completely normal outcome.
//
// Two halves are pinned here: the error carries the skip markers, and the queue
// turns any skip-marked error into a clean finish rather than a failure.

const test = require("node:test");
const assert = require("node:assert");
const { notOpenError } = require("../lib/github");
const { Queue } = require("../lib/queue");

// Run one job through a real Queue and collect what it emitted.
function runOne(runner) {
  return new Promise((resolve) => {
    const q = new Queue(runner, { concurrency: 1 });
    const events = [];
    const states = [];
    q.on("job", ({ event }) => {
      events.push(event);
      if (event.kind === "done" || event.kind === "failed") {
        setImmediate(() => resolve({ events, states, kinds: events.map((e) => e.kind) }));
      }
    });
    q.on("state", ({ state }) => states.push(state));
    q.enqueue({ id: "j1" });
  });
}

// -------------------------------------------------------- the error shape --

test("a merged PR is marked skippable, not just an error", () => {
  const e = notOpenError("MERGED");
  assert.equal(e.code, "PR_NOT_OPEN");
  assert.equal(e.skip, true);
  assert.equal(e.skipReason, "pr_not_open");
});

test("merged and closed each get their own plain-language message", () => {
  assert.match(notOpenError("MERGED").skipMessage, /already merged/i);
  assert.match(notOpenError("CLOSED").skipMessage, /closed/i);
});

test("the skip message says nothing about failing or refusing", () => {
  // The old copy was "PR is merged, not OPEN. Refusing to review." Both words
  // told the user something had gone wrong when nothing had.
  for (const s of ["MERGED", "CLOSED"]) {
    const e = notOpenError(s);
    assert.doesNotMatch(e.skipMessage, /refus|fail|error/i);
    assert.doesNotMatch(e.message, /refus/i);
  }
});

// ------------------------------------------------------- the queue's call --

test("a skip-marked error finishes the job, it does not fail it", async () => {
  const { kinds, states } = await runOne(async () => {
    throw notOpenError("MERGED");
  });
  assert.ok(kinds.includes("skipped"), "expected a skipped event");
  assert.ok(kinds.includes("done"), "expected the job to finish");
  assert.ok(!kinds.includes("failed"), "a skip must never emit failed");
  assert.equal(states.at(-1), "done");
  assert.ok(!states.includes("failed"));
});

test("the skipped event carries the human message and the machine reason", async () => {
  const { events } = await runOne(async () => {
    throw notOpenError("MERGED");
  });
  const skipped = events.find((e) => e.kind === "skipped");
  assert.equal(skipped.reason, "pr_not_open");
  assert.match(skipped.message, /already merged/i);
});

test("an ordinary error still fails the job", async () => {
  const { kinds, states } = await runOne(async () => {
    const e = new Error("gh blew up");
    e.code = "GH_FAILED";
    throw e;
  });
  assert.ok(kinds.includes("failed"));
  assert.ok(!kinds.includes("skipped"));
  assert.equal(states.at(-1), "failed");
});

test("a job that returns normally is untouched by the skip path", async () => {
  const { kinds } = await runOne(async () => {});
  assert.ok(kinds.includes("done"));
  assert.ok(!kinds.includes("skipped"));
  assert.ok(!kinds.includes("failed"));
});
