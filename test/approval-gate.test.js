"use strict";

// Tests for the approval gate: the block that decides approve-vs-comment, and
// the resume prompt that has to carry it.
//
// The bug these pin down: the resume ("verify fixes") path never received the
// gate at all, and its prompt ended with a flat "do NOT approve". So a PR whose
// every finding the author had fixed came back as a plain issue comment, and
// sat unapproved forever. Both halves are asserted here because both were
// needed to reproduce it.

const test = require("node:test");
const assert = require("node:assert");
const { approvalBlock } = require("../lib/claude-runner");
const { buildVerifyPrompt } = require("../lib/review-job");

const firstPass = (over = {}) =>
  approvalBlock({ autoApprove: true, matchedTests: [], ...over }).join("\n");
const reReview = (over = {}) => firstPass({ reReview: true, ...over });

const META = {
  url: "https://github.com/o/r/pull/7",
  number: 7,
  owner: "o",
  repo: "r",
};
const verifyPrompt = (approvalOver = {}) =>
  buildVerifyPrompt({
    meta: META,
    approval: { autoApprove: true, matchedTests: [], reReview: true, ...approvalOver },
  });

// ---------------------------------------------------------------- the gate --

test("auto-approve off forbids approving, in both modes", () => {
  for (const mode of [{}, { reReview: true }]) {
    const b = approvalBlock({ autoApprove: false, ...mode }).join("\n");
    assert.match(b, /Do not approve or request changes/);
    assert.doesNotMatch(b, /--approve/);
  }
});

test("the gate claims precedence over the inlined skill", () => {
  // The skill header says it supersedes what sits above it, and the user-level
  // review skill carries its own conflicting auto-approve policy. Without this
  // line, which of the two wins is left to chance.
  const b = firstPass();
  assert.match(b, /PRECEDENCE/);
  assert.match(b, /THIS BLOCK WINS/);
});

test("first pass keeps the plain findings gate and no re-review section", () => {
  const b = firstPass();
  assert.match(b, /If you found any critical or major issues/);
  assert.doesNotMatch(b, /Re-review scoring/);
});

test("re-review can still reach --approve", () => {
  assert.match(reReview(), /Score ≤ 20\s+→ `gh pr review <N> --approve/);
});

test("re-review closes out findings the author fixed", () => {
  const b = reReview();
  assert.match(b, /Re-review scoring/);
  assert.match(b, /ADDRESSED or ANSWERED is closed and stops counting/);
  assert.match(b, /Only STILL OPEN findings/);
});

test("re-review scores the whole current diff, not just the new commits", () => {
  assert.match(reReview(), /Score the CURRENT head diff as a whole/);
});

test("re-review does not let fixed findings buy down the risk score", () => {
  // Deliberate: the score measures what the change touches, so a high-risk PR
  // still comments after its findings are fixed. If that ever becomes wrong,
  // it should change by editing this rule, not by the model inventing one.
  const b = reReview();
  assert.match(b, /fixing the findings does not lower the risk\s+score/);
  assert.match(b, /Do NOT invent a reducer/);
});

test("the matched-tests reducer hint reflects the PR", () => {
  assert.match(firstPass({ matchedTests: ["lib/a.js"] }), /matching-name test files for these prod files: lib\/a\.js/);
  assert.match(firstPass(), /No matching-name test files were changed/);
});

// ------------------------------------------------------- the resume prompt --

test("resume prompt carries the approval gate", () => {
  const p = verifyPrompt();
  assert.match(p, /APPROVAL POLICY \(auto-approve enabled\)/);
  assert.match(p, /Re-review scoring/);
});

test("resume prompt never tells the reviewer not to approve", () => {
  // The exact regression. Any blanket ban here re-breaks it.
  assert.doesNotMatch(verifyPrompt(), /do NOT approve/i);
});

test("resume prompt posts a review, not a loose issue comment", () => {
  // `gh pr comment` leaves no review state, so branch protection and
  // reviewDecision never see it. The prompt names it only to forbid it.
  const p = verifyPrompt();
  assert.match(p, /Post exactly ONE review via `gh pr review 7`/);
  assert.match(p, /never `gh pr comment`/);
  assert.doesNotMatch(p, /via `gh pr comment`/);
});

test("resume prompt still suppresses a repeat of the original review", () => {
  const p = verifyPrompt();
  assert.match(p, /do NOT\nrepeat your original review/);
  assert.match(p, /ADDRESSED/);
  assert.match(p, /STILL OPEN/);
});

test("resume prompt honours auto-approve being switched off", () => {
  const p = verifyPrompt({ autoApprove: false });
  assert.match(p, /Do not approve or request changes/);
});
