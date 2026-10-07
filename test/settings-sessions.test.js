"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSettingsSessions, settingsPasswordFingerprint, REMEMBER_TTL_MS } = require("../lib/settings-sessions");

test("settings sessions are random, revocable, bounded and expire without renewal", () => {
  let time = 100;
  const sessions = createSettingsSessions({ now: () => time, ttlMs: 1000, limit: 2 });
  const first = sessions.issue();
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(first.expiresAt, 1100);
  assert.equal(sessions.valid(first.token), true);
  assert.equal(sessions.valid("wrong"), false);
  const second = sessions.issue();
  assert.notEqual(first.token, second.token);
  sessions.issue();
  assert.equal(sessions.valid(first.token), false);
  sessions.revoke(second.token);
  assert.equal(sessions.valid(second.token), false);
  const last = sessions.issue();
  time = 1099;
  assert.equal(sessions.valid(last.token), true);
  time = 1100;
  assert.equal(sessions.valid(last.token), false);
  assert.equal(createSettingsSessions().valid(last.token), false);
});

test("a remembered session lasts 30 days, still without renewal", () => {
  let time = 0;
  const sessions = createSettingsSessions({ now: () => time });
  const remembered = sessions.issue({ remember: true });
  assert.equal(remembered.expiresAt, REMEMBER_TTL_MS);
  assert.equal(remembered.remember, true);
  time = REMEMBER_TTL_MS - 1;
  assert.equal(sessions.valid(remembered.token), true);
  time = REMEMBER_TTL_MS;
  assert.equal(sessions.valid(remembered.token), false);
});

test("sessions survive a restart, stored as digests only, until the password changes", () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-sessions-"));
  const fingerprint = settingsPasswordFingerprint("secret", "instance-1");
  const first = createSettingsSessions({ dataHome, passwordFingerprint: fingerprint });
  const { token } = first.issue({ remember: true });
  const onDisk = fs.readFileSync(path.join(dataHome, "settings-sessions.json"), "utf8");
  assert.equal(onDisk.includes(token), false, "the raw token must never be written");
  assert.equal(onDisk.includes("secret"), false, "the password must never be written");
  assert.equal((fs.statSync(path.join(dataHome, "settings-sessions.json")).mode & 0o777), 0o600);

  const restarted = createSettingsSessions({ dataHome, passwordFingerprint: fingerprint });
  assert.equal(restarted.valid(token), true);

  const newPassword = createSettingsSessions({
    dataHome, passwordFingerprint: settingsPasswordFingerprint("changed", "instance-1"),
  });
  assert.equal(newPassword.valid(token), false, "changing the password logs every browser out");

  restarted.revoke(token);
  assert.equal(createSettingsSessions({ dataHome, passwordFingerprint: fingerprint }).valid(token), false);
  assert.equal(settingsPasswordFingerprint("", "instance-1"), null);
});
