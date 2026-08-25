"use strict";

// Approving is the only place prsnooze checks a secret, and it posts to GitHub
// as the host. There is no unlock step and no session: the password arrives with
// the approval it authorises, every time, and nothing is kept afterwards.
//
// `gh` is a shim on PATH here, so none of this touches GitHub or needs an
// account — and it lets the tests assert that a refused attempt runs nothing.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const PASSWORD = "correct-horse-battery-staple";
const PR_URL = "https://github.com/o/r/pull/7";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-approve-"));
const GH_LOG = path.join(tmp, "gh.log");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/bin/sh\necho "$@" >> ${JSON.stringify(GH_LOG)}\n` +
    `case "$1" in\n  api) echo host-bot ;;\n  *) echo '{"number":7,"state":"OPEN"}' ;;\nesac\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
// Both before requiring the server: it reads the password at module load, and
// hydrateJobs() must not touch ~/.prsnooze.
process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-home-"));
process.env.PRSNOOZE_APPROVE_PASSWORD = PASSWORD;

const { start, jobs } = require("../server");

const ghLines = (needle) =>
  (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf8").split("\n") : []).filter((l) => l.includes(needle));

let server;
let base;

test.before(async () => {
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  jobs.set("j", {
    id: "j", prUrl: PR_URL, state: "done", events: [], createdAt: Date.now(),
    prMeta: { number: 7, authorLogin: "someone-else" },
  });
});
test.after(() => { try { server.close(); } catch {} });

const approve = (password, id = "j") =>
  fetch(`${base}/api/jobs/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

test("a wrong password is refused, and nothing is run", async () => {
  const r = await approve("nope");
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /Not authorized/);
  assert.equal(ghLines("pr review").length, 0, "no approval may reach GitHub");
});

test("the password is checked before the job is even looked up", async () => {
  // Otherwise this endpoint tells an unauthorised caller which job ids exist.
  const r = await approve("nope", "no-such-job");
  assert.equal(r.status, 401, "401, not 404");
});

test("the right password approves, and hands back nothing to remember", async () => {
  const r = await approve(PASSWORD);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, outcome: "approved" });
  assert.equal(ghLines(`pr review ${PR_URL} --approve`).length, 1);
  assert.equal(jobs.get("j").outcome, "approved");
  // The point of the whole change: no cookie, no token, no ttl — the next
  // approval asks again.
  assert.equal(r.headers.get("set-cookie"), null);
});

test("the right password still can't approve a job that doesn't exist", async () => {
  const r = await approve(PASSWORD, "no-such-job");
  assert.equal(r.status, 404);
});

test("repeated wrong guesses lock the endpoint with a Retry-After", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await approve(`guess-${i}`);
  assert.equal(last.status, 429);
  const body = await last.json();
  assert.match(body.error, /Too many attempts/);
  assert.ok(body.retryAfterMs > 0, "tells the caller how long to wait");
  const retryAfter = Number(last.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, "sets a Retry-After header");
});

test("even the RIGHT password is refused while locked out", async () => {
  // An attacker who lands on the right guess after the limit still doesn't get
  // in until the window passes.
  const before = ghLines("pr review").length;
  const r = await approve(PASSWORD);
  assert.equal(r.status, 429);
  assert.equal(ghLines("pr review").length, before, "and nothing was posted");
});
