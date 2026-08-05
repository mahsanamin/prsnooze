"use strict";

// Tests for how a review's outcome is decided.
//
// The bug these lock down: the outcome used to be inferred from the ABSENCE of a
// recognised `gh` command, so any posting form the pattern didn't know became a
// confident "no comment was posted" — while the review sat on the PR. GitHub is
// now the authority; outcomeFromOwnPosts() is that decision, and it returns null
// when GitHub couldn't be consulted so the caller can't assert a falsehood.

const test = require("node:test");
const assert = require("node:assert");
const { outcomeFromOwnPosts } = require("../lib/github");

test("an approval by us wins over anything else in the same run", () => {
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: ["COMMENTED", "APPROVED"], comments: 1, inline: 3 }), "approved");
});

test("a change request outranks a plain comment", () => {
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: ["COMMENTED", "CHANGES_REQUESTED"], comments: 0, inline: 0 }), "changes_requested");
});

test("a COMMENTED review is 'commented'", () => {
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: ["COMMENTED"], comments: 0, inline: 0 }), "commented");
});

test("a PR-level comment with no review still counts as posted", () => {
  // This is the shape the old sniffer missed most often — `gh api …/comments`,
  // or any wrapper it didn't recognise. It must never read as "nothing posted".
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: [], comments: 1, inline: 0 }), "commented");
});

test("inline comments alone count as posted", () => {
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: [], comments: 0, inline: 4 }), "commented");
});

test("genuinely nothing posted is the only path to no_new_findings", () => {
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: [], comments: 0, inline: 0 }), "no_new_findings");
});

test("an unchecked lookup returns null, never no_new_findings", () => {
  // The whole point: if we couldn't ask GitHub we must not claim nothing was
  // posted. null tells the caller to keep its guess and mark it unverified.
  assert.equal(outcomeFromOwnPosts({ checked: false, reviews: [], comments: 0, inline: 0 }), null);
  assert.equal(outcomeFromOwnPosts(null), null);
  assert.equal(outcomeFromOwnPosts(undefined), null);
});

test("unknown review states don't masquerade as a post", () => {
  assert.equal(outcomeFromOwnPosts({ checked: true, reviews: ["PENDING", "DISMISSED"], comments: 0, inline: 0 }), "no_new_findings");
});

// ---------------------------------------------------------------------------
// The live sniffer is still the optimistic signal that shows a verdict the
// moment Claude posts, so its coverage is worth pinning down too.
const { detectOutcomeFromBashCommand: sniffer } = require("../lib/review-job");

test("sniffer: long gh pr review flags", () => {
  assert.equal(sniffer("gh pr review https://x/pull/1 --approve"), "approved");
  assert.equal(sniffer("gh pr review 1 --request-changes --body x"), "changes_requested");
  assert.equal(sniffer("gh pr review 1 --comment --body-file /tmp/r.md"), "commented");
});

test("sniffer: short flags, which it used to miss entirely", () => {
  assert.equal(sniffer("gh pr review 1 -a"), "approved");
  assert.equal(sniffer("gh pr review 1 -r -b 'nope'"), "changes_requested");
  assert.equal(sniffer("gh pr review 1 -c -F /tmp/r.md"), "commented");
});

test("sniffer: REST forms", () => {
  assert.equal(sniffer("gh api repos/o/r/pulls/9/reviews -f event=APPROVE -f body=ok"), "approved");
  assert.equal(sniffer("gh api repos/o/r/pulls/9/reviews -f event=REQUEST_CHANGES"), "changes_requested");
  assert.equal(sniffer("gh api repos/o/r/pulls/9/reviews -f event=COMMENT"), "commented");
  assert.equal(sniffer("gh api repos/o/r/issues/9/comments -f body=hi"), "commented");
});

test("sniffer: plain comment and multi-line commands", () => {
  assert.equal(sniffer("cd /w && gh pr comment 9 --body 'hi'"), "commented");
  assert.equal(sniffer("gh pr review 9 \\\n  --comment \\\n  --body 'x'"), "commented");
});

test("sniffer: unrelated commands are not a post", () => {
  assert.equal(sniffer("gh pr diff 9"), null);
  assert.equal(sniffer("gh pr view 9 --json reviews"), null);
  assert.equal(sniffer("git log --oneline"), null);
  assert.equal(sniffer(null), null);
});
