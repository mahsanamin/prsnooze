"use strict";

// The auto-approve CI gate. Two PRs were approved after a 30-second
// read: one fixed a CI job that had been skipped on that very run, and the
// review said "I did not run anything myself". An approval now needs CI on the
// reviewed commit to have passed, and the prompt asks for named evidence.

const test = require("node:test");
const assert = require("node:assert");
const { ciGate } = require("../lib/github");
const { approvalBlock } = require("../lib/claude-runner");

const run = (name, conclusion, status = "completed") => ({ name, status, conclusion });

test("all checks passed lets the approval through and lists skipped ones", () => {
  const g = ciGate({ ok: true, checks: [run("test", "success"), run("lint", "neutral"), run("Storybook smoke", "skipped")] });
  assert.equal(g.ok, true);
  assert.deepEqual(g.passed, ["test", "lint"]);
  assert.deepEqual(g.skipped, ["Storybook smoke"]);
});

test("a failed, cancelled or timed-out check withholds approval", () => {
  for (const c of ["failure", "cancelled", "timed_out", "action_required", "error"]) {
    const g = ciGate({ ok: true, checks: [run("test", "success"), run("e2e", c)] });
    assert.equal(g.ok, false, c);
    assert.match(g.reason, /did not pass/);
  }
});

test("a check still running withholds approval", () => {
  const g = ciGate({ ok: true, checks: [run("test", "success"), run("e2e", "", "in_progress")] });
  assert.equal(g.ok, false);
  assert.match(g.reason, /still running/);
});

test("no checks, or only skipped ones, means nothing verified the change", () => {
  assert.equal(ciGate({ ok: true, checks: [] }).ok, false);
  assert.equal(ciGate({ ok: true, checks: [run("smoke", "skipped")] }).ok, false);
});

test("an unreadable CI lookup fails closed", () => {
  const g = ciGate({ ok: false, error: "HTTP 502" });
  assert.equal(g.ok, false);
  assert.match(g.reason, /could not read CI.*HTTP 502/);
  assert.equal(ciGate(null).ok, false);
});

test("approval block asks for named evidence and shows passed and skipped checks", () => {
  const b = approvalBlock({ autoApprove: true, matchedTests: [], ci: { passed: ["test"], skipped: ["Storybook smoke"] } }).join("\n");
  assert.match(b, /Verification gate/);
  assert.match(b, /PASSED on this commit: test/);
  assert.match(b, /SKIPPED on this commit: Storybook smoke/);
  assert.match(b, /the author's own\s+measurements/);
  assert.match(b, /verified-by=\[/);
});

test("withheld approval tells the reviewer why and forbids approving", () => {
  const b = approvalBlock({ autoApprove: false, withheld: "CI is still running on this commit: e2e" }).join("\n");
  assert.match(b, /Do not approve/);
  assert.match(b, /withheld approval for this run: CI is still running/);
});

test("an approval must carry its reasons, never an empty body or LGTM", () => {
  const b = approvalBlock({ autoApprove: true, matchedTests: [], ci: { passed: ["test"], skipped: [] } }).join("\n");
  assert.match(b, /Never approve with\s+an empty body, "LGTM"/);
  for (const line of ["**Change:**", "**Checked:**", "**Verified by:**", "**Risk:**"]) assert.ok(b.includes(line), line);
  assert.match(b, /post `--comment` and say what is missing/);
});
