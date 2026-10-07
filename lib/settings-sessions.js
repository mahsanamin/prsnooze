"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSIONS_FILE = "settings-sessions.json";

// Settings-only bearer credentials: never accepted for PR approval. Bounded,
// fixed lifetime with no sliding renewal: 8 hours by default, 30 days when the
// owner ticks "remember this browser".
//
// With a data home they are also kept on disk so a server restart does not log
// the owner out. Only a SHA-256 digest of each token is written, never the
// token or the password. The file carries a fingerprint of the current
// settings password, and a file written under a different password is
// ignored, so changing the password logs out every browser.
function createSettingsSessions({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  limit = 1000,
  dataHome = null,
  passwordFingerprint = null,
} = {}) {
  const sessions = new Map();
  const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
  const file = dataHome ? path.join(dataHome, SESSIONS_FILE) : null;

  if (file && passwordFingerprint) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw?.fingerprint === passwordFingerprint && Array.isArray(raw.sessions)) {
        for (const [key, expiresAt] of raw.sessions.slice(-limit)) {
          if (/^[a-f0-9]{64}$/.test(key) && Number.isFinite(expiresAt)) sessions.set(key, expiresAt);
        }
      }
    } catch { /* No file or an unreadable one: start with no sessions. */ }
  }

  function persist() {
    if (!file || !passwordFingerprint) return;
    try {
      fs.mkdirSync(dataHome, { recursive: true });
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ fingerprint: passwordFingerprint, sessions: [...sessions] }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {
      // Sessions still work for this process; they just will not survive a restart.
    }
  }

  function prune() {
    let changed = false;
    for (const [key, expiresAt] of sessions) {
      if (expiresAt <= now()) { sessions.delete(key); changed = true; }
    }
    return changed;
  }

  return {
    issue({ remember = false } = {}) {
      prune();
      while (sessions.size >= limit) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = now() + (remember ? REMEMBER_TTL_MS : ttlMs);
      sessions.set(digest(token), expiresAt);
      persist();
      return { token, expiresAt, remember: !!remember };
    },
    valid(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
      if (prune()) persist();
      return sessions.has(digest(token));
    },
    revoke(token) {
      if (typeof token === "string" && sessions.delete(digest(token))) persist();
    },
  };
}

// A stable fingerprint of the settings password, salted with the instance id,
// used only to tell whether saved sessions were issued under this password.
function settingsPasswordFingerprint(password, instanceId) {
  if (!password) return null;
  return crypto.createHash("sha256").update(`prsnooze-settings-sessions:${instanceId}:${password}`).digest("hex");
}

module.exports = { createSettingsSessions, settingsPasswordFingerprint, DEFAULT_TTL_MS, REMEMBER_TTL_MS };
