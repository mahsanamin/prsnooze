"use strict";

// Tests for the plan-usage reading shown in the topbar.
//
// Two things matter here. First, the numbers come out of a human-readable CLI
// report, so the parser has to survive the shapes that report actually takes —
// and must never invent a limit when there isn't one, because "87% left" is the
// thing people trust before queueing a review. Second, that report also lists
// the host's own skills and MCP servers, and none of that may leak to the page:
// only limits and request counts cross the wire.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { once } = require("node:events");

const { parseUsage, getUsage, resetUsageCache } = require("../lib/claude-usage");

const REAL_REPORT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 13% used · resets Aug 7 at 9:20pm (Asia/Karachi)",
  "Current week (all models): 8% used · resets Aug 12 at 8pm (Asia/Karachi)",
  "Current week (Fable): 0% used",
  "",
  "What's contributing to your limits usage?",
  "Approximate, based on local sessions on this machine.",
  "",
  "Last 24h · 500 requests · 14 sessions",
  "  46% of your usage was at >150k context",
  "  Top skills: /deploy-prod 38%, /dataviz 4%",
  "  Top MCP servers: playwright 31%",
  "",
  "Last 7d · 2,396 requests · 65 sessions",
  "  Top subagents: plan-verifier 2%",
].join("\n");

test("every limit window is read, in the order the CLI lists them", () => {
  const u = parseUsage(REAL_REPORT);
  assert.equal(u.ok, true);
  assert.equal(u.subscription, true);
  assert.deepEqual(u.windows.map((w) => w.id), ["session", "week-all-models", "week-fable"]);
  assert.deepEqual(u.windows.map((w) => w.label), ["Session", "Week (all models)", "Week (Fable)"]);
});

test("used and left are two views of one number", () => {
  const [session] = parseUsage(REAL_REPORT).windows;
  assert.equal(session.usedPct, 13);
  assert.equal(session.leftPct, 87);
});

test("the reset time keeps its timezone, and offers a form without it", () => {
  const [session] = parseUsage(REAL_REPORT).windows;
  assert.equal(session.resets, "Aug 7 at 9:20pm (Asia/Karachi)");
  assert.equal(session.resetsShort, "Aug 7 at 9:20pm");
  assert.equal(session.zone, "Asia/Karachi");
});

test("a window with no reset time is still a window", () => {
  const fable = parseUsage(REAL_REPORT).windows.find((w) => w.id === "week-fable");
  assert.equal(fable.usedPct, 0);
  assert.equal(fable.leftPct, 100);
  assert.equal(fable.resets, null);
});

test("request counts are read, and thousands separators survive", () => {
  const { activity } = parseUsage(REAL_REPORT);
  assert.deepEqual(activity["24h"], { requests: 500, sessions: 14 });
  assert.deepEqual(activity["7d"], { requests: 2396, sessions: 65 });
});

test("nothing but limits and counts is carried out of the report", () => {
  // The report names the host's skills and MCP servers. This page is opened by
  // the whole team, so that detail must not survive parsing.
  const json = JSON.stringify(parseUsage(REAL_REPORT));
  for (const secret of ["deploy-prod", "dataviz", "playwright", "plan-verifier", "150k context"]) {
    assert.equal(json.includes(secret), false, `leaked "${secret}"`);
  }
});

test("fractional percentages are kept, not rounded away", () => {
  const [w] = parseUsage("Current session: 99.5% used · resets in a bit").windows;
  assert.equal(w.usedPct, 99.5);
  assert.equal(w.leftPct, 0.5);
});

test("an API-key host reports no limits rather than a fake full tank", () => {
  const u = parseUsage("You are currently using an API key to power your Claude Code usage\n");
  assert.equal(u.ok, false);
  assert.equal(u.reason, "not-a-subscription");
  assert.equal(u.windows, undefined);
});

test("an empty or unrecognisable report is not ok", () => {
  assert.equal(parseUsage("").ok, false);
  assert.equal(parseUsage("command not found").ok, false);
});

// --- getUsage: the caching layer ------------------------------------------
// Every teammate's browser polls this, so a reading must be shared rather than
// re-spawned per caller — the CLI takes seconds to boot.

function fakeClaude(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-usage-"));
  const bin = path.join(dir, "fake-claude");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

test("concurrent callers share one CLI run, and the result is cached", async () => {
  resetUsageCache();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-count-")), "runs");
  const bin = fakeClaude(
    `#!/bin/sh\necho x >> ${counter}\necho "You are currently using your subscription to power your Claude Code usage"\necho "Current session: 42% used · resets Aug 7 at 9:20pm (Asia/Karachi)"\n`,
  );
  const [a, b] = await Promise.all([getUsage({ claudeBin: bin }), getUsage({ claudeBin: bin })]);
  assert.equal(a.windows[0].leftPct, 58);
  assert.equal(b.windows[0].leftPct, 58);
  const again = await getUsage({ claudeBin: bin });
  assert.equal(again.stale, false);
  assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
});

test("a CLI that fails leaves the last good reading standing, marked stale", async () => {
  resetUsageCache();
  const good = fakeClaude(
    `#!/bin/sh\necho "You are currently using your subscription to power your Claude Code usage"\necho "Current session: 20% used"\n`,
  );
  const broken = fakeClaude(`#!/bin/sh\necho "boom" >&2\nexit 1\n`);
  await getUsage({ claudeBin: good });
  const after = await getUsage({ claudeBin: broken, force: true });
  assert.equal(after.ok, true);
  assert.equal(after.stale, true);
  assert.equal(after.windows[0].usedPct, 20);
});

test("a CLI that fails with nothing cached says so instead of guessing", async () => {
  resetUsageCache();
  const broken = fakeClaude(`#!/bin/sh\nexit 127\n`);
  const u = await getUsage({ claudeBin: broken });
  assert.equal(u.ok, false);
  assert.equal(u.reason, "unavailable");
  // The cause is kept for the host — the route below is what withholds it.
  assert.match(u.detail, /127/);
});

// --- the endpoint ---------------------------------------------------------

process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-test-"));
process.env.CLAUDE_BIN = fakeClaude(
  `#!/bin/sh\necho "You are currently using your subscription to power your Claude Code usage"\necho "Current session: 66% used · resets Aug 7 at 9:20pm (Asia/Karachi)"\necho "Last 24h · 12 requests · 3 sessions"\n`,
);
const { start } = require("../server");

let server;
let base;
test.before(async () => {
  resetUsageCache();
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { try { server.close(); } catch {} });

test("GET /api/usage serves the reading to anyone who can open the page", async () => {
  // Earlier tests exercise the cache directly, so start this one from cold.
  resetUsageCache();
  const r = await fetch(`${base}/api/usage`);
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.equal(u.ok, true);
  assert.equal(u.windows[0].usedPct, 66);
  assert.equal(u.windows[0].leftPct, 34);
  assert.deepEqual(u.activity["24h"], { requests: 12, sessions: 3 });
  assert.ok(u.fetchedAt > 0);
});

test("a failed reading never ships the CLI's error text to the browser", async () => {
  // Put a failure in the cache the way a real broken host would, then ask the
  // way a teammate's browser does: the reason is for the host's log, not the page.
  resetUsageCache();
  const broken = await getUsage({ claudeBin: fakeClaude(`#!/bin/sh\necho "keychain says no" >&2\nexit 1\n`) });
  assert.equal(broken.ok, false);
  const u = await (await fetch(`${base}/api/usage`)).json();
  assert.equal(u.ok, false);
  assert.equal(u.reason, "unavailable");
  assert.equal("detail" in u, false);
});
