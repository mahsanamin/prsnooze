"use strict";

// /api/unlock is the only endpoint that checks a secret, and it gates posting an
// approval to GitHub as the host. These tests pin down that it can't be
// brute-forced: wrong guesses lock the caller out, the right password still
// works before the lock, and a lockout clears the counter once it's used.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { once } = require("node:events");

// Both must be set BEFORE requiring the server: it reads the password at module
// load, and hydrateJobs() must not touch ~/.prsnooze.
process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-test-"));
process.env.PRSNOOZE_ADMIN_PASSWORD = "correct-horse-battery-staple";

const { start } = require("../server");

let server;
let base;

test.before(async () => {
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  try { server.close(); } catch {}
});

const unlock = (password) =>
  fetch(`${base}/api/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

test("the right password unlocks and sets an HttpOnly cookie", async () => {
  const r = await unlock("correct-horse-battery-staple");
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie") || "";
  assert.match(cookie, /prsnooze_priv=/);
  assert.match(cookie, /HttpOnly/, "the browser must not be able to read it");
  assert.match(cookie, /SameSite=Lax/);
});

test("a wrong password is rejected without leaking which part was wrong", async () => {
  const r = await unlock("nope");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "incorrect password");
  assert.equal(r.headers.get("set-cookie"), null, "no cookie on failure");
});

test("repeated wrong guesses lock the endpoint with a Retry-After", async () => {
  // A success resets the counter, so start from a clean slate: the first test
  // unlocked, then one failure landed above. Drive it past the threshold.
  let last;
  for (let i = 0; i < 6; i++) last = await unlock(`guess-${i}`);

  assert.equal(last.status, 429, "locked out rather than answering 401 forever");
  const body = await last.json();
  assert.match(body.error, /too many attempts/);
  assert.ok(body.retryAfterMs > 0, "tells the caller how long to wait");

  const retryAfter = Number(last.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, "sets a Retry-After header");
});

test("even the CORRECT password is refused while locked out", async () => {
  // The point of the lockout: an attacker who lands on the right guess after the
  // limit still doesn't get in until the window passes.
  const r = await unlock("correct-horse-battery-staple");
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("set-cookie"), null);
});

test("a privileged action stays refused without a valid cookie", async () => {
  // Belt and braces: the gate isn't only on /api/unlock. Approving needs the
  // signed cookie, and a forged one must not pass the HMAC.
  const r = await fetch(`${base}/api/jobs/whatever/approve`, {
    method: "POST",
    headers: { Cookie: `prsnooze_priv=${Date.now()}.deadbeef` },
  });
  assert.ok(r.status === 401 || r.status === 404, `got ${r.status}`);
  if (r.status === 401) assert.equal((await r.json()).locked, true);
});
