"use strict";

// Tests for canApprovePr — the decision behind "does this review get an Approve
// button?". Like assessResumability it's a pure function over already-fetched
// state, so every branch is testable with no browser, no gh, no network.
//
// The bugs it exists to prevent: a button that appeared on a merged PR while the
// state was still in flight (clickable, and guaranteed to fail), and a button
// that vanished entirely whenever `gh` was unreachable — which is the state
// where handing the decision to GitHub is the only honest thing left to do.

const test = require("node:test");
const assert = require("node:assert");
const { canApprovePr } = require("../public/can-approve");

// A finished review of a PR that GitHub has confirmed is open and unapproved.
const rev = (over = {}) => ({
  state: "done",
  outcome: "commented",
  skipped: false,
  skipReason: null,
  prStateChecked: true,
  prStateOk: true,
  prState: "OPEN",
  prApproved: false,
  ...over,
});

test("an open, unapproved PR from a finished review is approvable", () => {
  assert.equal(canApprovePr(rev()), true);
});

test("only a finished review gets the button", () => {
  for (const state of ["queued", "running", "failed", "interrupted"]) {
    assert.equal(canApprovePr(rev({ state })), false, state);
  }
});

test("a merged or closed PR is not approvable", () => {
  for (const prState of ["MERGED", "CLOSED"]) {
    assert.equal(canApprovePr(rev({ prState })), false, prState);
  }
});

test("nothing is drawn until GitHub has answered", () => {
  // The whole point of the checked flag: an un-asked state must render no
  // button at all, rather than an optimistic one that withdraws a moment later.
  assert.equal(canApprovePr(rev({ prStateChecked: false, prState: null, prStateOk: false })), false);
});

test("an unreachable GitHub fails open — let GitHub refuse it", () => {
  // Refusing every approval because a `gh` call failed is worse than posting one
  // that GitHub might reject: the probe is unauthenticated and cheap, approving
  // is neither.
  assert.equal(canApprovePr(rev({ prStateOk: false, prState: null })), true);
});

test("an unknown state that isn't a probe failure stays un-approvable", () => {
  // prStateOk is checked with === false on purpose. "Asked, and the answer was
  // something we don't recognise" is not the same as "couldn't ask", and only
  // the latter earns the fail-open.
  assert.equal(canApprovePr(rev({ prStateOk: undefined, prState: null })), false);
});

test("a PR someone else already approved is not approvable", () => {
  assert.equal(canApprovePr(rev({ prApproved: true })), false);
});

test("already-approved beats the fail-open", () => {
  // Order matters: a known approval outranks "couldn't reach GitHub", so a
  // stale ok:false doesn't resurrect the button on a PR we know is approved.
  assert.equal(canApprovePr(rev({ prApproved: true, prStateOk: false })), false);
});

test("a review that approved the PR itself gets no second button", () => {
  // The disabled "Approved" affirmation renders in its place — see renderHead.
  assert.equal(canApprovePr(rev({ outcome: "approved" })), false);
});

test("a review skipped because the PR wasn't open is not approvable", () => {
  assert.equal(canApprovePr(rev({ skipped: true, skipReason: "pr_not_open" })), false);
});

test("a skip for any other reason still leaves an open PR approvable", () => {
  // Skips are not a verdict on the PR. "Already reviewed this commit" says
  // nothing about whether the PR can be approved.
  assert.equal(canApprovePr(rev({ skipped: true, skipReason: "already_reviewed" })), true);
});
