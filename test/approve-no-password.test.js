"use strict";

// A host that never set a password. The flow is deliberately identical to a
// wrong guess — same prompt, same status, same words — so a page the whole team
// can reach doesn't advertise whether approving is configured, and so there is
// only one path to get right.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-nopw-"));
const GH_LOG = path.join(tmp, "gh.log");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/bin/sh\necho "$@" >> ${JSON.stringify(GH_LOG)}\necho host-bot\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-home-"));
// Present-but-empty: loadDotenv only fills keys that are absent, so this also
// shields the test from whatever sits in the developer's own .env.
process.env.PRSNOOZE_APPROVE_PASSWORD = "";

const { start, jobs } = require("../server");

let server;
let base;

test.before(async () => {
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  jobs.set("j", {
    id: "j", prUrl: "https://github.com/o/r/pull/7", state: "done", events: [], createdAt: Date.now(),
    prMeta: { number: 7, authorLogin: "someone-else" },
  });
});
test.after(() => { try { server.close(); } catch {} });

const approve = (password) =>
  fetch(`${base}/api/jobs/j/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

test("with no password set, every attempt comes back not authorized", async () => {
  for (const guess of ["", "anything", "change-me"]) {
    const r = await approve(guess);
    assert.equal(r.status, 401, `for ${JSON.stringify(guess)}`);
    assert.equal((await r.json()).error, "Not authorized — that password doesn't match.");
  }
});

test("an empty password can't match an unset one", async () => {
  // The nastiest way to get this wrong: comparing "" to "" and letting anyone in.
  const r = await approve(undefined);
  assert.equal(r.status, 401);
  const posted = (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf8") : "");
  assert.ok(!posted.includes("pr review"), "nothing may reach GitHub");
});

test("/api/config doesn't say whether approving is configured", async () => {
  // The button shows either way and asks either way, so the browser has no use
  // for the answer — and shouldn't be handed it.
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.ok(!("passwordConfigured" in cfg), "must not report whether a password is set");
  assert.ok(!("unlocked" in cfg), "there is no unlocked state to report");
});
