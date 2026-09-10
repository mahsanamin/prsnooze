"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-settings-api-"));
const modelState = path.join(home, "model");
fs.writeFileSync(modelState, "sonnet");
const fakeClaude = path.join(home, "claude");
fs.writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Claude Code test"; exit 0; fi
if [ "$2" = "/model" ]; then
  if [ "$(cat '${modelState}')" = "broken" ]; then exit 1; fi
  if [ "$(cat '${modelState}')" = "fable" ]; then echo "Current model: Fable"; else echo "Current model: Sonnet 5"; fi
  exit 0
fi
if [ "$2" = "/usage" ]; then
  if [ "$(cat '${modelState}')" = "usage-broken" ]; then exit 1; fi
  echo "You are currently using your subscription to power your Claude Code usage"
  echo "Current session: 90% used"
  echo "Current week (Fable): 99% used"
  exit 0
fi
exit 0
`, { mode: 0o755 });

process.env.PRSNOOZE_HOME = home;
process.env.REVIEW_PROVIDERS = "claude";
process.env.CLAUDE_BIN = fakeClaude;
process.env.PRSNOOZE_SETTINGS_PASSWORD = "settings-secret";
const { start, jobs } = require("../server");

let server;
let base;
test.before(async () => {
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { try { server.close(); } catch {} });

async function save(body, password = "settings-secret") {
  return fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, ...body }),
  });
}

test("the settings password is separate, required, and never exposed", async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const config = await response.json();
  assert.equal(JSON.stringify(config).includes("settings-secret"), false);
  assert.equal(config.profile.choices.length, 20);
  const denied = await save({ acceptingReviews: false }, "wrong");
  assert.equal(denied.status, 401);
});

test("every default avatar is served locally as SVG", async () => {
  const config = await (await fetch(`${base}/api/config`)).json();
  for (const avatar of config.profile.choices) {
    const response = await fetch(`${base}${avatar.url}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await response.text(), /<svg /);
  }
});

test("locking intake persists and refuses both browser and shared submit paths", async () => {
  const saved = await save({
    acceptingReviews: false,
    maxConcurrentReviews: 2,
    minUsageRemainingPct: 0,
    avatarId: "coral",
  });
  assert.equal(saved.status, 200);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.admission.acceptingReviews, false);
  assert.equal(config.admission.maxConcurrentReviews, 2);
  assert.equal(config.profile.avatarId, "coral");
  const refused = await fetch(`${base}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/1" }),
  });
  assert.equal(refused.status, 423);
  assert.equal((await refused.json()).code, "REVIEW_INTAKE_LOCKED");
  const remoteRefused = await fetch(`${base}/api/remote/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/1" }),
  });
  assert.equal(remoteRefused.status, 423);
  assert.equal((await remoteRefused.json()).code, "REVIEW_INTAKE_LOCKED");

  jobs.set("finished-review", {
    id: "finished-review",
    prUrl: "https://github.com/example/repo/pull/1",
    provider: "claude",
    sessionId: "session-1",
    state: "done",
    events: [],
  });
  const resumeRefused = await fetch(`${base}/api/jobs/finished-review/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(resumeRefused.status, 423);
  assert.equal((await resumeRefused.json()).code, "REVIEW_INTAKE_LOCKED");
  jobs.delete("finished-review");
});

test("Fable and low-plan guards fail before a job is created", async () => {
  await save({ acceptingReviews: true, maxConcurrentReviews: 1, minUsageRemainingPct: 0 });
  fs.writeFileSync(modelState, "fable");
  let response = await fetch(`${base}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/2" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "FABLE_MODEL_BLOCKED");

  fs.writeFileSync(modelState, "sonnet");
  await save({ acceptingReviews: true, maxConcurrentReviews: 1, minUsageRemainingPct: 20 });
  response = await fetch(`${base}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/3" }),
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "USAGE_FLOOR_REACHED");

  fs.writeFileSync(modelState, "broken");
  response = await fetch(`${base}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/4" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MODEL_UNAVAILABLE");

  fs.writeFileSync(modelState, "usage-broken");
  response = await fetch(`${base}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/5" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "USAGE_UNAVAILABLE");
});

test("a custom raster avatar is stored and served from the host", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const saved = await save({
    acceptingReviews: true,
    maxConcurrentReviews: 1,
    minUsageRemainingPct: 0,
    avatarDataUrl: png,
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).profile.custom, true);
  const image = await fetch(`${base}/api/profile/avatar`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /^image\/png/);
});
