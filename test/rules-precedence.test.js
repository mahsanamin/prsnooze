"use strict";

// Whose rules win, once both are in the prompt.
//
// The problem: a review's quality tracked whoever's laptop ran it. The skill
// resolver picked exactly one playbook, so a repo with its own rules threw the
// host's away, and a repo without any made the host's personal file the entire
// standard — including its severity bar and its approval taste.
//
// The split now: the project owns review CONTENT, a personal skill is a layer
// on top that can only add or tighten, and the approval floor is prsnooze's.
// This file asserts the prompt actually says all three, because the prompt is
// the only place that ranking exists — nothing downstream re-checks it.

const test = require("node:test");
const assert = require("node:assert");
const { buildPrompt, approvalBlock } = require("../lib/review-prompt");

const PR = "https://github.com/o/r/pull/7";
const projectSkill = (over = {}) => ({
  name: "review-pr",
  path: "/repo/.claude/skills/review-pr/SKILL.md",
  body: "PROJECT PLAYBOOK BODY",
  source: "project",
  ref: "origin/main",
  subordinate: null,
  ...over,
});
const developerSkill = {
  name: "aa-review-pr",
  path: "/home/dev/.claude/skills/aa-review-pr/SKILL.md",
  body: "PERSONAL PLAYBOOK BODY",
  source: "user",
  ref: null,
};
const prompt = (skill) => buildPrompt({ prUrl: PR, skill, approval: { autoApprove: true, matchedTests: [] } });

// ------------------------------------------------------- content precedence --

test("a project skill is announced as the project's, and stays authoritative", () => {
  const p = prompt(projectSkill());
  assert.match(p, /PROJECT SKILL \(AUTHORITATIVE on review CONTENT/);
  assert.match(p, /PROJECT PLAYBOOK BODY/);
});

test("a personal skill is NOT announced as the project's standard", () => {
  // It used to be: the section header said "PROJECT SKILL" whichever file won,
  // so ~/.claude was introduced to the model as the repo's agreed rules.
  const p = prompt({ ...developerSkill, subordinate: null });
  assert.match(p, /DEVELOPER SKILL — the personal playbook of whoever runs this host/);
  assert.doesNotMatch(p, /PROJECT SKILL \(AUTHORITATIVE/);
});

test("both skills are inlined when the host has one and the project has one", () => {
  const p = prompt(projectSkill({ subordinate: developerSkill }));
  assert.match(p, /PROJECT PLAYBOOK BODY/);
  assert.match(p, /PERSONAL PLAYBOOK BODY/);
});

test("the personal layer is ranked below the project's, wherever it sits", () => {
  const p = prompt(projectSkill({ subordinate: developerSkill }));
  assert.match(p, /DEVELOPER PREFERENCES \(SUBORDINATE\)/);
  assert.match(p, /the project wins\. Every time\./);
  assert.match(p, /ranked below the PROJECT SKILL/);
  // Position must not be load-bearing: the personal section comes last, and
  // this prompt's other sections use "later wins".
  assert.match(p, /no matter where it sits in this message/);
});

test("the personal layer may add and tighten, never subtract", () => {
  const p = prompt(projectSkill({ subordinate: developerSkill }));
  assert.match(p, /Extra checks, extra rigour/);
  assert.match(p, /It cannot subtract/);
  assert.match(p, /would DROP a check, lower a severity/);
});

// ------------------------------------------------------------------- floor --

test("a personal skill brings the non-negotiable floor with it", () => {
  for (const skill of [{ ...developerSkill, subordinate: null }, projectSkill({ subordinate: developerSkill })]) {
    const p = prompt(skill);
    assert.match(p, /PROJECT FLOOR \(non-negotiable\)/, `for source=${skill.source}`);
    assert.match(p, /THE REPO'S OWN RULES OUTRANK A PERSONAL PREFERENCE/);
    assert.match(p, /THESE CHECKS RUN ON EVERY REVIEW/);
    assert.match(p, /A REAL FINDING IS REPORTED AT ITS OWN SEVERITY/);
  }
});

test("the floor reads the repo's docs from the base, not from the PR", () => {
  // Same trust rule as the skill itself: a PR that edits AGENTS.md must not
  // relax the standard it is being reviewed against.
  const p = prompt({ ...developerSkill, subordinate: null });
  assert.match(p, /Read them from the BASE, not from the working tree/);
  assert.match(p, /git show origin\/<base>:AGENTS\.md/);
});

test("the floor is not imposed on a project skill or the bundled default", () => {
  // A project is allowed to set its own bar, including a lower one — the floor
  // exists for the machine-dependent case, not to overrule a repo.
  for (const skill of [projectSkill(), { ...projectSkill(), source: "bundled", ref: null }]) {
    assert.doesNotMatch(prompt(skill), /PROJECT FLOOR/, `for source=${skill.source}`);
  }
});

test("the floor sends uncertainty toward reporting, not toward silence", () => {
  const p = prompt({ ...developerSkill, subordinate: null });
  assert.match(p, /UNCERTAINTY GOES IN THE STRICT DIRECTION/);
  assert.match(p, /Do not resolve your own uncertainty by staying/);
});

// ---------------------------------------------------- approval: one-way only --

test("a skill may make approval stricter, never looser", () => {
  // This is the deliberate asymmetry the host asked for: personal judgment is
  // welcome when it withholds an approval, and irrelevant when it grants one.
  const b = approvalBlock({ autoApprove: true, matchedTests: [] }).join("\n");
  assert.match(b, /A skill that says COMMENT where this block says approve: follow the\s+skill/);
  assert.match(b, /A skill that says APPROVE where this block says comment: ignore it/);
  assert.match(b, /THIS BLOCK WINS/);
  assert.match(b, /strictest answer wins/);
});

test("the findings gate is still absolute", () => {
  // Nothing above may buy past an open critical or major finding — the same
  // rule the forced-approve endpoint enforces server-side.
  const b = approvalBlock({ autoApprove: true, matchedTests: [] }).join("\n");
  assert.match(b, /Findings gate \(overrides score\)/);
  assert.match(b, /Findings block approval regardless of score/);
});

test("a skill-free prompt still carries the approval policy", () => {
  // The broken-install path: no skill resolved at all. It has no rules to rank,
  // but it must not lose the gate.
  const p = buildPrompt({ prUrl: PR, skill: null, approval: { autoApprove: true, matchedTests: [] } });
  assert.match(p, /APPROVAL POLICY/);
  assert.doesNotMatch(p, /PROJECT FLOOR/);
});
