"use strict";

// The forced-approve gate: what the approve password does NOT buy you.
//
// The hole this covers is worth stating, because every test here is one branch
// of it: the password authorised the person and nothing checked the PR, so
// anyone who knew it could approve a PR prsnooze had just flagged 🔴 Critical.
//
// Every case below refuses somebody's approval, so every case is also a way to
// wrongly block a clean PR. Both directions are asserted.

const test = require("node:test");
const assert = require("node:assert");
const { assessForcedApproval, classifySeverity } = require("../lib/approval-gate");

const HEAD = "a1b2c3d4";
const signals = (over = {}) => ({
  ok: true,
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  headRefOid: HEAD,
  authorLogin: "author-dev",
  threads: [],
  reviews: [],
  latestReviews: [],
  ...over,
});
const gate = (over = {}, rest = {}) =>
  assessForcedApproval({
    signals: signals(over),
    job: { prMeta: { authorLogin: "author-dev" } },
    hostLogin: "host-bot",
    hostName: "Ahsan",
    ...rest,
  });

const thread = (body, over = {}) => ({
  isResolved: false,
  isOutdated: false,
  path: "lib/auth.js",
  line: 41,
  comments: [{ body, author: "alice", path: "lib/auth.js", line: 41 }],
  ...over,
});

// ------------------------------------------------------------- the happy path --

test("a clean open PR approves", () => {
  const g = gate();
  assert.equal(g.allowed, true);
  assert.equal(g.code, "CLEAR");
  assert.deepEqual(g.blockers, []);
});

test("resolved criticals and answered nits don't block", () => {
  const g = gate({
    threads: [
      thread("🔴 this leaks the token", { isResolved: true }),
      thread("⚪ nit: rename this to `count`"),
      thread("Question — why the extra fetch here?"),
    ],
  });
  assert.equal(g.allowed, true, g.message);
});

test("prsnooze's own approving review body doesn't block the next approval", () => {
  // Its bodies talk about criticals in the negative ("No critical or major
  // issues"), and reading that as an open critical would deadlock every PR it
  // had ever cleared.
  const g = gate({
    reviews: [
      { state: "APPROVED", body: "No critical or major issues found.", author: "host-bot", commitOid: HEAD },
      { state: "COMMENTED", body: "Nothing critical here — two minors, both cosmetic.", author: "host-bot", commitOid: HEAD },
    ],
  });
  assert.equal(g.allowed, true, g.message);
});

// ------------------------------------------------------------- the refusals --

test("an unreachable GitHub holds the approval instead of guessing", () => {
  // The browser's Approve button deliberately fails OPEN when gh can't answer;
  // this deliberately fails CLOSED. The button decides whether to offer a
  // click, this decides whether an approval lands, and "couldn't check" is not
  // "there's nothing to find".
  const g = assessForcedApproval({ signals: { ok: false, error: "gh: not logged in" } });
  assert.equal(g.allowed, false);
  assert.equal(g.code, "UNVERIFIED");
  assert.match(g.message, /gh: not logged in/);
  assert.match(g.message, /Nothing was posted/);
});

test("a missing signals object is refused, not treated as clean", () => {
  assert.equal(assessForcedApproval({}).allowed, false);
  assert.equal(assessForcedApproval().code, "UNVERIFIED");
});

test("a merged or closed PR has nothing to approve", () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const g = gate({ state });
    assert.equal(g.allowed, false);
    assert.equal(g.code, "NOT_OPEN");
    assert.match(g.message, new RegExp(state.toLowerCase()));
  }
});

test("the host can't approve their own PR", () => {
  const g = gate({ authorLogin: "host-bot" });
  assert.equal(g.allowed, false);
  assert.equal(g.code, "OWN_PR");
});

test("a standing changes-requested review blocks, and names who left it", () => {
  const g = gate({ latestReviews: [{ state: "CHANGES_REQUESTED", author: "alice" }] });
  assert.equal(g.allowed, false);
  assert.equal(g.code, "CHANGES_REQUESTED");
  assert.match(g.message, /@alice requested changes/);
  assert.match(g.message, /only be cleared by the reviewer who left it/);
});

test("reviewDecision alone still blocks when the review list is empty", () => {
  // A repo where latestOpinionatedReviews comes back empty (permissions, an
  // API shape change) must not turn the strongest signal GitHub has into a
  // pass.
  const g = gate({ reviewDecision: "CHANGES_REQUESTED" });
  assert.equal(g.code, "CHANGES_REQUESTED");
});

test("an unresolved critical inline comment blocks, and is quoted back", () => {
  const g = gate({ threads: [thread("🔴 token compared with `==`, timing-unsafe")] });
  assert.equal(g.allowed, false);
  assert.equal(g.code, "OPEN_CRITICAL_COMMENTS");
  assert.match(g.message, /lib\/auth\.js:41/);
  assert.match(g.message, /@alice/);
  assert.match(g.message, /timing-unsafe/);
  assert.equal(g.blockers.length, 1);
  assert.equal(g.blockers[0].level, "critical");
});

test("an unresolved major comment blocks too", () => {
  const g = gate({ threads: [thread("🟠 this drops the error on the floor")] });
  assert.equal(g.code, "OPEN_CRITICAL_COMMENTS");
  assert.equal(g.blockers[0].level, "major");
});

test("a critical raised in a REPLY blocks, not just the opening comment", () => {
  const g = gate({
    threads: [
      thread("looks fine", {
        comments: [
          { body: "looks fine to me", author: "alice" },
          { body: "wait — this is a blocker, it double-charges on retry", author: "bob" },
        ],
      }),
    ],
  });
  assert.equal(g.code, "OPEN_CRITICAL_COMMENTS");
  assert.match(g.message, /@bob/);
});

test("an outdated but unresolved thread still blocks, and says so", () => {
  // The code moving under a comment is not the comment being answered, and
  // clicking Resolve is the cheap half of "solve the comments first".
  const g = gate({ threads: [thread("🔴 unbounded loop", { isOutdated: true })] });
  assert.equal(g.code, "OPEN_CRITICAL_COMMENTS");
  assert.match(g.message, /outdated but still unresolved/);
});

test("prsnooze's own critical findings on the current head block a force-approve", () => {
  // The case the whole gate exists for: prsnooze posts findings as ONE review
  // body, not as inline threads, so the thread rule above never sees them.
  const g = gate({
    reviews: [
      {
        state: "COMMENTED",
        body: "## Findings\n\n### 🔴 Critical\n- `lib/pay.js:88` — rounds before tax. **Fix:** round last.",
        author: "host-bot",
        commitOid: HEAD,
      },
    ],
  });
  assert.equal(g.allowed, false);
  assert.equal(g.code, "OPEN_CRITICAL_COMMENTS");
  assert.match(g.message, /host-bot/);
});

test("findings against a superseded commit don't block", () => {
  // Deliberate, and the one visible give in the gate: a review of code the
  // author has since replaced says nothing about the code being approved, and
  // holding on it would deadlock every PR prsnooze ever commented on. Pushing
  // a commit clears this rule, so it catches "nobody did anything", not
  // "somebody pushed something and called it fixed".
  const g = gate({
    reviews: [{ state: "COMMENTED", body: "### 🔴 Critical\n- boom", author: "host-bot", commitOid: "older123" }],
  });
  assert.equal(g.allowed, true, g.message);
});

test("every refusal says how to get past it, and that there is no override", () => {
  const g = gate({ threads: [thread("🔴 leaks the session token")] });
  assert.match(g.message, /does not override an\s+open finding/);
  assert.match(g.message, /there is no override that does/);
  assert.match(g.message, /have the reviewer who raised them mark the thread resolved/);
  assert.match(g.message, /Ahsan \(@host-bot\), who owns this prsnooze host/);
});

test("a long blocker list is trimmed, not dumped", () => {
  const g = gate({ threads: Array.from({ length: 9 }, () => thread("🔴 no")) }, { maxListed: 3 });
  assert.equal(g.blockers.length, 9, "the caller still gets all of them");
  assert.match(g.message, /…and 6 more/);
});

// -------------------------------------------------------- severity reading --

test("severity words are read, in the strict direction", () => {
  for (const body of [
    "🔴 broken",
    "This is critical",
    "blocker: the migration drops the column",
    "must fix before merge",
    "P0",
  ]) {
    assert.equal(classifySeverity(body).level, "critical", body);
  }
  for (const body of ["🟠 worth fixing", "major issue here", "P1", "sql injection on line 4"]) {
    assert.equal(classifySeverity(body).level, "major", body);
  }
});

test("a severity named only to deny it is not a finding", () => {
  for (const body of [
    "No critical issues.",
    "nothing critical, ship it",
    "zero blockers from me",
    "the critical one is addressed in a1b2c3d",
    "not a blocker, just curious",
    "🟡 minor: spacing",
    "⚪ nit: naming",
    "LGTM",
  ]) {
    assert.equal(classifySeverity(body).level, "none", body);
  }
});

test("a severity word inside quoted code is not a finding", () => {
  // Reviewers paste diffs, and a snippet containing the word says nothing
  // about this PR.
  const body = "same as before:\n\n```js\nif (isCritical) throw new Error('critical');\n```\n\nlooks right";
  assert.equal(classifySeverity(body).level, "none");
});

test("empty and non-string bodies classify as nothing", () => {
  for (const body of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(classifySeverity(body).level, "none");
  }
});

// ----------------------------------------- severity reading, on real bodies --
// These came out of a live `gh api graphql` run against an open PR, not out of
// a fixture. Each one is something the classifier got wrong at first.

test("a review bot's 🛑 Requirement is a blocker", () => {
  // The miss that this section exists for. GitHub's Copilot reviewer marks a
  // required change with 🛑 and the label "Requirement:", and the first version
  // of the classifier read that as harmless prose — so an unresolved "cover
  // these branches" thread would have let a forced approval through.
  const body =
    "🛑 Requirement: Cover the capability-based script-selection branches. " +
    "The existing tests validate token prefixes and metadata parsing, but nothing else was found.";
  assert.equal(classifySeverity(body).level, "critical");
});

test("a requirement MENTIONED is not a requirement STATED", () => {
  assert.equal(classifySeverity("This change meets the requirement: it returns early.").level, "none");
  assert.equal(classifySeverity("Requirement: this has to change before merge.").level, "critical");
});

test("a negation cancels its own sentence, not the whole paragraph", () => {
  // Real comments are one long line. Judging the line as a unit let a stray
  // "no other issues" wave off a blocker stated beside it.
  const body = "No critical issues in the tests. But this is a blocker: it double-charges on retry.";
  assert.equal(classifySeverity(body).level, "critical");
  assert.match(classifySeverity(body).evidence, /double-charges/);
});

test("a bot's badge markup and hidden markers carry no severity", () => {
  // Copilot's body opens with an HTML comment marker and a <picture> block
  // whose image filenames contain severity words. None of it is a claim about
  // the PR, and quoting it back at someone is useless either way.
  const body =
    '<!-- ccr-overview-v2 --> ## Copilot review overview\n' +
    '| <picture><source media="(prefers-color-scheme: dark)" srcset="https://x/icons/critical-v1-dark.svg"><img src="https://x/icons/critical-v1.svg"></picture> | ' +
    '[see the guidelines](https://example.com/major-issues) |';
  assert.equal(classifySeverity(body).level, "none");
});

test("an un-backticked comparison in prose keeps its blocker", () => {
  // The tag stripper has to be narrow: "<b) return x>" is not an HTML tag, and
  // treating it as one would delete whatever sat between the angle brackets.
  assert.equal(classifySeverity("if (a<b) return x>y — this is a blocker").level, "critical");
});

test("🟡 changes-recommended is not a blocker", () => {
  // The same bot's softer verdict. Blocking on it would hold up most PRs it
  // touches, which is how a gate stops being taken seriously.
  assert.equal(classifySeverity("### 🟡 Changes recommended\nThe new filtering branch could be simpler.").level, "none");
});

test("a table row is judged cell by cell", () => {
  const body = "| `lib/pay.js:88` | 🛑 Requirement: round after tax | no other issues here |";
  const found = classifySeverity(body);
  assert.equal(found.level, "critical");
  assert.match(found.evidence, /round after tax/);
  assert.doesNotMatch(found.evidence, /no other issues/, "quotes the finding, not the whole row");
});

test("evidence from a long paragraph is a window, not the paragraph", () => {
  const body = `${"x".repeat(400)} this is a blocker: it deletes the column. ${"y".repeat(400)}`;
  const found = classifySeverity(body);
  assert.equal(found.level, "critical");
  assert.ok(found.evidence.length <= 160, `got ${found.evidence.length} chars`);
  assert.match(found.evidence, /blocker/);
});
