"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-settings-api-")), ".prsnooze");
fs.mkdirSync(home);
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
process.env.REVIEW_PROVIDERS = "claude,codex";
process.env.CODEX_BIN = "/bin/true";
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

test("custom avatars in the hidden data home remain readable after saving settings", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
  const saved = await save({ avatarDataUrl: `data:image/png;base64,${png.toString("base64")}` });
  assert.equal(saved.status, 200);
  const { profile } = await saved.json();
  assert.equal(profile.custom, true);
  const image = await fetch(`${base}${profile.avatarUrl}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /image\/png/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.profile.avatarUrl, profile.avatarUrl);
});

test("settings login grants a settings-only session and logout revokes it", async () => {
  const login = await fetch(`${base}/api/settings/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "settings-secret" }),
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("cache-control"), "no-store");
  const session = await login.json();
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(session).includes("settings-secret"), false);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };
  const saved = await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify({ maxConcurrentReviews: 2 }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).admission.maxConcurrentReviews, 2);
  const renewed = await fetch(`${base}/api/settings/session`, { method: "POST", headers, body: "{}" });
  assert.equal(renewed.status, 401);
  const approval = await fetch(`${base}/api/jobs/nonexistent/approve`, { method: "POST", headers, body: "{}" });
  assert.equal(approval.status, 401);
  const logout = await fetch(`${base}/api/settings/session`, { method: "DELETE", headers });
  assert.equal(logout.status, 204);
  const denied = await fetch(`${base}/api/settings`, { method: "POST", headers, body: "{}" });
  assert.equal(denied.status, 401);
});

test("provider toggles reject new and resumed reviews on browser and remote paths", async () => {
  for (const disabledProviders of [["claude"], ["codex"], ["claude", "codex"]]) {
    assert.equal((await save({ disabledProviders })).status, 200);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config.admission.disabledProviders, disabledProviders);
    for (const provider of disabledProviders) {
      for (const route of ["/api/review", "/api/remote/review"]) {
        const response = await fetch(`${base}${route}`, { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prUrl: "https://github.com/example/repo/pull/1", provider }) });
        assert.equal(response.status, 423);
        assert.equal((await response.json()).code, "PROVIDER_DISABLED");
      }
      jobs.set("disabled-resume", { id: "disabled-resume", provider, sessionId: "session",
        prUrl: "https://github.com/example/repo/pull/1", state: "done", events: [] });
      const response = await fetch(`${base}/api/jobs/disabled-resume/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, 423);
      assert.equal((await response.json()).code, "PROVIDER_DISABLED");
      const remoteResume = await fetch(`${base}/api/remote/jobs/disabled-resume/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(remoteResume.status, 423);
      assert.equal((await remoteResume.json()).code, "PROVIDER_DISABLED");
      assert.equal(jobs.get("disabled-resume").state, "done");
      jobs.delete("disabled-resume");
    }
  }
  assert.equal((await save({ disabledProviders: ["unknown"] })).status, 400);
  assert.equal((await save({ disabledProviders: false })).status, 400);
  assert.equal((await save({ disabledProviders: [] })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/config`)).json()).admission.disabledProviders, []);
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
