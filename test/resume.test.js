"use strict";

// Tests for assessResumability — the decision behind "should this finished
// review be resumed?". It's deliberately a pure function taking already-fetched
// GitHub data, so every branch is testable with no gh, no network, no account.

const test = require("node:test");
const assert = require("node:assert");
const { assessResumability } = require("../lib/github");

const HOUR = 3600_000;
const T0 = 1_700_000_000_000; // review ran here
const iso = (ms) => new Date(ms).toISOString();

// A PR that is open, unapproved, and untouched since our review.
function basePr(over = {}) {
  return {
    number: 7,
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    headRefOid: "sha-reviewed",
    author: { login: "author" },
    reviews: [{ author: { login: "us" }, state: "COMMENTED", submittedAt: iso(T0) }],
    comments: [],
    commits: [{ oid: "sha-reviewed", committedDate: iso(T0 - HOUR) }],
    ...over,
  };
}
const assess = (over = {}) =>
  assessResumability({
    pr: basePr(over.pr),
    inlineComments: over.inlineComments || [],
    selfLogin: "us",
    reviewedSha: "reviewed" in over ? over.reviewed : "sha-reviewed",
    reviewedAt: T0,
    hasSession: over.hasSession !== false,
  });

test("no recorded session — nothing to resume", () => {
  const v = assess({ hasSession: false });
  assert.equal(v.resumable, false);
  assert.equal(v.code, "NO_SESSION");
  assert.match(v.reason, /fresh review/);
});

test("GitHub unreachable — refuses rather than guessing", () => {
  const v = assessResumability({ pr: null, selfLogin: "us", hasSession: true });
  assert.equal(v.resumable, false);
  assert.equal(v.code, "UNKNOWN");
});

test("merged or closed PR is not resumable", () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const v = assess({ pr: { state } });
    assert.equal(v.resumable, false, `${state} refused`);
    assert.equal(v.code, "PR_CLOSED");
    assert.match(v.reason, new RegExp(state.toLowerCase()));
  }
});

test("already approved by us is not resumable", () => {
  const v = assess({
    pr: { reviews: [{ author: { login: "us" }, state: "APPROVED", submittedAt: iso(T0) }] },
  });
  assert.equal(v.resumable, false);
  assert.equal(v.code, "APPROVED");
  assert.equal(v.signals.approvedByUs, true);
  assert.match(v.reason, /already approved/i);
});

test("approved by someone else is not resumable either", () => {
  const v = assess({ pr: { reviewDecision: "APPROVED" } });
  assert.equal(v.resumable, false);
  assert.equal(v.code, "APPROVED");
  assert.equal(v.signals.approvedByUs, false);
});

test("nothing new since the review — resume would be a no-op", () => {
  const v = assess();
  assert.equal(v.resumable, false);
  assert.equal(v.code, "NOTHING_NEW");
  assert.match(v.reason, /no new commits and no replies/);
});

test("new commits since the review make it resumable", () => {
  const v = assess({
    pr: {
      headRefOid: "sha-new",
      commits: [
        { oid: "sha-reviewed", committedDate: iso(T0 - HOUR) },
        { oid: "sha-new", committedDate: iso(T0 + HOUR) },
      ],
    },
  });
  assert.equal(v.resumable, true);
  assert.equal(v.code, "HAS_UPDATES");
  assert.equal(v.signals.newCommitCount, 1);
  assert.equal(v.signals.headMoved, true);
  assert.match(v.reason, /1 new commit/);
});

test("a reply to our inline comment makes it resumable, and is counted", () => {
  const v = assess({
    inlineComments: [
      { id: 1, user: { login: "us" }, created_at: iso(T0) },
      { id: 2, user: { login: "author" }, created_at: iso(T0 + HOUR), in_reply_to_id: 1 },
      { id: 3, user: { login: "author" }, created_at: iso(T0 + HOUR), in_reply_to_id: 1 },
    ],
  });
  assert.equal(v.resumable, true);
  assert.equal(v.signals.replyCount, 2);
  assert.equal(v.signals.authorResponded, true);
  assert.match(v.reason, /2 replies to your comments/);
});

test("our own later comments don't count as something new", () => {
  const v = assess({
    inlineComments: [
      { id: 1, user: { login: "us" }, created_at: iso(T0) },
      { id: 2, user: { login: "us" }, created_at: iso(T0 + HOUR), in_reply_to_id: 1 },
    ],
  });
  assert.equal(v.resumable, false, "talking to ourselves is not an update");
  assert.equal(v.code, "NOTHING_NEW");
});

test("commits and replies are reported together", () => {
  const v = assess({
    pr: {
      headRefOid: "sha-new",
      commits: [{ oid: "sha-new", committedDate: iso(T0 + HOUR) }],
    },
    inlineComments: [
      { id: 1, user: { login: "us" }, created_at: iso(T0) },
      { id: 2, user: { login: "author" }, created_at: iso(T0 + HOUR), in_reply_to_id: 1 },
    ],
  });
  assert.equal(v.resumable, true);
  assert.match(v.reason, /1 new commit and 1 reply to your comments/);
});

test("a PR-level comment from the author counts", () => {
  const v = assess({
    pr: { comments: [{ author: { login: "author" }, createdAt: iso(T0 + HOUR), body: "fixed, ptal" }] },
  });
  assert.equal(v.resumable, true);
  assert.equal(v.signals.authorResponded, true);
});

test("our latest review time wins over a stale reviewedAt", () => {
  // Job says it finished at T0, but GitHub shows we reviewed again later — so a
  // comment between those two times is already accounted for.
  const v = assessResumability({
    pr: basePr({
      reviews: [
        { author: { login: "us" }, state: "COMMENTED", submittedAt: iso(T0) },
        { author: { login: "us" }, state: "COMMENTED", submittedAt: iso(T0 + 2 * HOUR) },
      ],
      comments: [{ author: { login: "author" }, createdAt: iso(T0 + HOUR) }],
    }),
    selfLogin: "us",
    reviewedSha: "sha-reviewed",
    reviewedAt: T0,
    hasSession: true,
  });
  assert.equal(v.resumable, false);
  assert.equal(v.code, "NOTHING_NEW");
  assert.equal(v.signals.since, T0 + 2 * HOUR);
});

test("missing selfLogin degrades to timestamps, not a crash", () => {
  const v = assessResumability({
    pr: basePr({ comments: [{ author: { login: "author" }, createdAt: iso(T0 + HOUR) }] }),
    inlineComments: [],
    selfLogin: null,
    reviewedSha: "sha-reviewed",
    reviewedAt: T0,
    hasSession: true,
  });
  assert.equal(v.resumable, true, "still sees the new comment");
  assert.equal(v.signals.replyCount, 0, "but can't attribute replies to us");
});

// ---------------------------------------------------------------------------
// resumeGate — should this resume request actually run?
//
// The rule worth pinning down: Force can override "already approved" and
// "nothing new" (wanting another pass is a legitimate reason on its own), but it
// can NEVER override a merged or closed PR. There's no PR left to review, the run
// would die at `resolving`, and getting that far flips a finished review's state
// to failed for nothing — which is exactly what happened once by hand.
const { resumeGate } = require("../lib/github");

test("gate: a resumable review runs without forcing", () => {
  const g = resumeGate({ assessment: { resumable: true, code: "HAS_UPDATES", reason: "2 new commits" }, forced: false });
  assert.equal(g.allow, true);
  assert.equal(g.forcible, true);
});

test("gate: not resumable is refused but offers force", () => {
  for (const code of ["APPROVED", "NOTHING_NEW", "UNKNOWN"]) {
    const g = resumeGate({ assessment: { resumable: false, code, reason: "r" }, forced: false });
    assert.equal(g.allow, false, `${code} refused`);
    assert.equal(g.forcible, true, `${code} is forcible`);
  }
});

test("gate: force overrides approved and unchanged", () => {
  for (const code of ["APPROVED", "NOTHING_NEW", "UNKNOWN"]) {
    const g = resumeGate({ assessment: { resumable: false, code, reason: "r" }, forced: true });
    assert.equal(g.allow, true, `${code} forced through`);
    assert.match(g.reason, /^forced — /);
  }
});

test("gate: force can NOT override a merged or closed PR", () => {
  const g = resumeGate({ assessment: { resumable: false, code: "PR_CLOSED", reason: "The PR is merged" }, forced: true });
  assert.equal(g.allow, false, "still refused");
  assert.equal(g.forcible, false, "and the UI is told forcing is pointless");
  assert.match(g.reason, /merged/);
});

test("gate: force can NOT invent a session that was never recorded", () => {
  const g = resumeGate({ assessment: { resumable: false, code: "NO_SESSION", reason: "no session" }, forced: true });
  assert.equal(g.allow, false);
  assert.equal(g.forcible, false);
});
