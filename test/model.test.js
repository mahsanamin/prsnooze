"use strict";

// Tests for the active-model reading shown in the topbar.
//
// prsnooze never passes --model, so this reading is the only place the page can
// learn which model reviews actually run on. Two things matter. First, it comes
// out of a human-readable CLI line, so the parser has to survive the shapes that
// line takes — and must never invent a model, because "Opus 5" on screen while
// Haiku reviews the diff is worse than saying nothing. Second, the same CLI
// output lists every model alias the host's account can reach, and none of that
// belongs on a page the whole team can open.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { once } = require("node:events");

const { parseModel, getModel, resetModelCache } = require("../lib/claude-model");

// What `claude -p /model` actually prints: the current model, then a usage line
// naming every alias the account can reach.
const REAL_REPORT = [
  "Current model: Opus 5 (1M context) (default)",
  "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, opusplan, default, or a full model ID.",
].join("\n");

test("the current model is read, and the (default) marker becomes a flag", () => {
  const m = parseModel(REAL_REPORT);
  assert.equal(m.ok, true);
  assert.equal(m.name, "Opus 5 (1M context)");
  assert.equal(m.isDefault, true);
});

test("a model the host picked explicitly is not marked as the default", () => {
  const m = parseModel("Current model: Sonnet 5\n");
  assert.equal(m.ok, true);
  assert.equal(m.name, "Sonnet 5");
  assert.equal(m.isDefault, false);
});

test("nothing but the model name is carried out of the report", () => {
  // The usage line advertises the host's available models. The page gets the
  // one in use and nothing else.
  const json = JSON.stringify(parseModel(REAL_REPORT));
  for (const extra of ["sonnet", "haiku", "opusplan", "Available"]) {
    assert.equal(json.includes(extra), false, `leaked "${extra}"`);
  }
});

test("an unrecognisable report is not ok rather than a guessed model", () => {
  assert.equal(parseModel("").ok, false);
  assert.equal(parseModel("command not found").ok, false);
  assert.equal(parseModel("Current model:   \n").ok, false);
  assert.equal(parseModel(null).ok, false);
});

// --- getModel: the caching layer ------------------------------------------
// Every teammate's browser asks for this, so a reading must be shared rather
// than re-spawned per caller — the CLI takes seconds to boot.

function fakeClaude(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-model-"));
  const bin = path.join(dir, "fake-claude");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

test("concurrent callers share one CLI run, and the result is cached", async () => {
  resetModelCache();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-mcount-")), "runs");
  const bin = fakeClaude(`#!/bin/sh\necho x >> ${counter}\necho "Current model: Haiku 4.5 (default)"\n`);
  const [a, b] = await Promise.all([getModel({ claudeBin: bin }), getModel({ claudeBin: bin })]);
  assert.equal(a.name, "Haiku 4.5");
  assert.equal(b.name, "Haiku 4.5");
  const again = await getModel({ claudeBin: bin });
  assert.equal(again.stale, false);
  assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
});

test("a CLI that fails leaves the last known model standing, marked stale", async () => {
  resetModelCache();
  const good = fakeClaude(`#!/bin/sh\necho "Current model: Opus 5"\n`);
  const broken = fakeClaude(`#!/bin/sh\necho "boom" >&2\nexit 1\n`);
  await getModel({ claudeBin: good });
  const after = await getModel({ claudeBin: broken, force: true });
  assert.equal(after.ok, true);
  assert.equal(after.stale, true);
  assert.equal(after.name, "Opus 5");
});

test("a CLI that fails with nothing cached says so instead of guessing", async () => {
  resetModelCache();
  const m = await getModel({ claudeBin: fakeClaude(`#!/bin/sh\nexit 127\n`) });
  assert.equal(m.ok, false);
  assert.equal(m.reason, "unavailable");
  // The cause is kept for the host — the route below is what withholds it.
  assert.match(m.detail, /127/);
});

// --- the endpoint ---------------------------------------------------------

process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-test-"));
process.env.CLAUDE_BIN = fakeClaude(`#!/bin/sh\necho "Current model: Sonnet 5 (1M context) (default)"\n`);
const { start } = require("../server");

let server;
let base;
test.before(async () => {
  resetModelCache();
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { try { server.close(); } catch {} });

test("GET /api/model tells anyone who can open the page what reviews run on", async () => {
  resetModelCache();
  const r = await fetch(`${base}/api/model`);
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.ok, true);
  assert.equal(m.name, "Sonnet 5 (1M context)");
  assert.equal(m.isDefault, true);
  assert.ok(m.fetchedAt > 0);
});

test("a failed reading never ships the CLI's error text to the browser", async () => {
  resetModelCache();
  const broken = await getModel({ claudeBin: fakeClaude(`#!/bin/sh\necho "keychain says no" >&2\nexit 1\n`) });
  assert.equal(broken.ok, false);
  const m = await (await fetch(`${base}/api/model`)).json();
  assert.equal(m.ok, false);
  assert.equal(m.reason, "unavailable");
  assert.equal("detail" in m, false);
});
