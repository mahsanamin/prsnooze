"use strict";

// Tests for how often /api/jobs/:id/pr-state is willing to spawn `gh`.
//
// The endpoint needs no password, and `gh pr view` runs with a 20s timeout, so
// "one request, one process" is a real cost: a logged-out host used to pay it on
// every click, and ?refresh=1 could ask for it on demand. Three protections are
// pinned here — the cache, the per-PR in-flight share, and the floor under
// forced refreshes — by counting invocations of a fake `gh` on PATH rather than
// by timing, which can't tell one slow process from three concurrent ones.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-probe-"));
const GH_LOG = path.join(tmp, "gh-calls.log");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
// Slow enough that concurrent requests genuinely overlap, so the in-flight
// share is being exercised rather than accidentally serialised.
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/bin/sh\necho "$@" >> ${JSON.stringify(GH_LOG)}\nsleep 0.4\n` +
    `echo '{"number":1,"state":"OPEN","reviewDecision":null,"isDraft":false}'\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-home-"));

const { start, jobs } = require("../server");

// `pr view` only: the server also resolves the host's gh login once at startup
// (`gh api user`), and that call is not what's being counted here.
const ghCalls = () =>
  (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf8").split("\n") : []).filter((l) => l.startsWith("pr view")).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let base;

test.before(async () => {
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  jobs.set("j", { id: "j", prUrl: "https://github.com/o/r/pull/1", state: "done", events: [], createdAt: Date.now() });
});
test.after(() => { server?.close(); });

const get = async (q = "") => {
  const r = await fetch(`${base}/api/jobs/j/pr-state${q}`);
  assert.equal(r.status, 200);
  return r.json();
};

test("concurrent requests for the same PR share one `gh`", async () => {
  const all = await Promise.all([get(), get(), get(), get(), get()]);
  for (const state of all) assert.equal(state.state, "OPEN");
  assert.equal(ghCalls(), 1);
});

test("a cached answer spawns nothing", async () => {
  assert.equal((await get()).state, "OPEN");
  assert.equal(ghCalls(), 1);
});

test("?refresh=1 gets past the cache — once", async () => {
  // The first insistence is the real one (an approval GitHub just refused).
  assert.equal((await get("?refresh=1")).state, "OPEN");
  assert.equal(ghCalls(), 2);
  // Everything after it inside the floor reads what that probe just wrote,
  // which is the fresh answer it was asking for anyway.
  for (let i = 0; i < 4; i++) await get("?refresh=1");
  assert.equal(ghCalls(), 2);
});

test("the floor expires, so a later refusal is still honoured", async () => {
  await sleep(3100); // PR_STATE_REFRESH_FLOOR_MS
  assert.equal((await get("?refresh=1")).state, "OPEN");
  assert.equal(ghCalls(), 3);
});
