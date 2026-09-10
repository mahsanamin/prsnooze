"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSettingsSessions } = require("../lib/settings-sessions");

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
