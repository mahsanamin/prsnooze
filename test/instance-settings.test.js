"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AVATARS,
  AVATAR_FILE,
  decodeAvatarDataUrl,
  loadSettings,
  normalizeSettings,
  publicSettings,
  saveCustomAvatar,
  saveSettings,
  stableAvatarId,
} = require("../lib/instance-settings");

test("the default gallery has 20 distinct, attributed internet avatars", () => {
  assert.equal(AVATARS.length, 20);
  assert.equal(new Set(AVATARS.map((avatar) => avatar.id)).size, 20);
  assert.equal(new Set(AVATARS.map((avatar) => avatar.url)).size, 20);
  for (const avatar of AVATARS) {
    assert.match(avatar.url, /^https:\/\/api\.dicebear\.com\/9\.x\/personas\/svg\?/);
    assert.match(avatar.url, /backgroundColor=/);
  }
  assert.equal(stableAvatarId("same-instance"), stableAvatarId("same-instance"));
});

test("settings are normalized, persisted privately, and loaded again", () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-settings-"));
  const settings = normalizeSettings({
    acceptingReviews: false,
    minUsageRemainingPct: 25,
    maxConcurrentReviews: 2,
    avatar: { kind: "preset", id: "coral" },
  }, { instanceId: "instance", initialConcurrency: 1 });
  saveSettings(dataHome, settings);
  assert.deepEqual(loadSettings({ dataHome, instanceId: "instance" }), settings);
  assert.equal(fs.statSync(path.join(dataHome, "settings.json")).mode & 0o777, 0o600);
  assert.equal(publicSettings(settings).profile.avatarId, "coral");
});

test("custom avatars accept bounded raster data and reject disguised content", () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-avatar-"));
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const avatar = saveCustomAvatar(dataHome, png);
  assert.equal(avatar.mime, "image/png");
  assert.equal(fs.existsSync(path.join(dataHome, AVATAR_FILE)), true);
  assert.throws(() => decodeAvatarDataUrl("data:image/png;base64,SGVsbG8="), /does not match/);
  assert.throws(() => decodeAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz4="), /PNG, JPEG, or WebP/);
});
