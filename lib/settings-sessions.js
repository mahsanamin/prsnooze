"use strict";

const crypto = require("node:crypto");

// Settings-only bearer credentials: never accepted for PR approval. Memory
// only, bounded, fixed lifetime; restarting the server revokes every session.
function createSettingsSessions({ now = Date.now, ttlMs = 8 * 60 * 60 * 1000, limit = 1000 } = {}) {
  const sessions = new Map();
  const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
  function prune() {
    for (const [key, expiresAt] of sessions) if (expiresAt <= now()) sessions.delete(key);
  }
  return {
    issue() {
      prune();
      while (sessions.size >= limit) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = now() + ttlMs;
      sessions.set(digest(token), expiresAt);
      return { token, expiresAt };
    },
    valid(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
      prune();
      return sessions.has(digest(token));
    },
    revoke(token) {
      if (typeof token === "string") sessions.delete(digest(token));
    },
  };
}

module.exports = { createSettingsSessions };
