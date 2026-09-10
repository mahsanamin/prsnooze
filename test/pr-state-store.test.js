"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPrStateStore, createPrStateRefresh } = require("../lib/pr-state-store");

test("last known PR status survives restart and failed probes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-pr-state-"));
  const store = createPrStateStore(home, { now: () => 123 });
  store.remember("pr", { ok: true, state: "MERGED", approved: true });
  assert.equal(store.remember("pr", { ok: false }), null);
  assert.equal(store.get("pr").state, "MERGED");
  const restored = createPrStateStore(home);
  assert.deepEqual(restored.get("pr"), store.get("pr"));
  assert.equal(fs.statSync(path.join(home, "pr-states.json")).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(home, "pr-states.json"), "broken");
  assert.equal(createPrStateStore(home).get("pr"), null);
});

test("disk failure keeps PR status usable in memory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-pr-state-"));
  const blocker = path.join(home, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const store = createPrStateStore(blocker);
  store.remember("pr", { ok: true, state: "CLOSED" });
  assert.equal(store.get("pr").state, "CLOSED");
});

test("refresh batches are bounded, deduplicated, non-overlapping and back off failures", async () => {
  let time = 1_000_000;
  const called = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const refresh = createPrStateRefresh({
    now: () => time,
    listJobs: () => ["merged", "fresh", "a", "a", "b", "c", "d"].map((prUrl) => ({ prUrl })),
    getState: (url) => url === "merged" ? { state: "MERGED" } : url === "fresh" ? { state: "OPEN", checkedAt: time } : null,
    probe: async (url) => { called.push(url); await gate; throw new Error("offline"); },
  });
  const running = refresh();
  await refresh();
  assert.deepEqual(called, ["a"]);
  release();
  await running;
  assert.deepEqual(called, ["a", "b", "c"]);
  await refresh();
  assert.deepEqual(called, ["a", "b", "c", "d"]);
  await refresh();
  assert.equal(called.length, 4);
  time += 5 * 60_000;
  await refresh();
  assert.equal(called.length, 7);
});
