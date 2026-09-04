"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE_NAME = "instance.json";

/**
 * The stable name a colleague's CLI uses to reach this instance.
 *
 * The id has to survive a restart, because the whole point of it is that a
 * teammate keeps talking to the same machine after it reboots. It lives beside
 * the rest of the instance's state so wiping ~/.prsnooze wipes it too, which is
 * the behaviour someone expects when they reset an instance.
 *
 * A read-only or missing data dir must not stop the server booting: an instance
 * with an id it could not persist is still fully usable locally, it just gets a
 * new id next time. Losing remote addressability is a smaller failure than
 * refusing to start.
 */
function loadIdentity({
  dataHome,
  name = null,
  generateId = () => crypto.randomUUID(),
} = {}) {
  const file = path.join(dataHome, FILE_NAME);

  let saved = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // No file yet, or someone corrupted it. Either way we mint a fresh id
    // rather than refusing to start.
  }

  const savedId = typeof saved?.id === "string" ? saved.id.trim() : "";
  const identity = {
    id: savedId || generateId(),
    name: name || (typeof saved?.name === "string" ? saved.name : null) || null,
    createdAt: Number.isFinite(saved?.createdAt) ? saved.createdAt : Date.now(),
  };

  const unchanged =
    saved && saved.id === identity.id && saved.name === identity.name;
  if (!unchanged) {
    try {
      fs.mkdirSync(dataHome, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`);
      identity.persisted = true;
    } catch {
      identity.persisted = false;
    }
  } else {
    identity.persisted = true;
  }

  return identity;
}

/**
 * A short handle for job refs. Colleagues refer to instances by the local name
 * they chose, but a ref like `a1b2c3d4/<job>` has to mean the same instance in
 * everyone's CLI, so refs carry this instead of a per-machine nickname.
 */
function shortId(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8);
}

module.exports = { loadIdentity, shortId, FILE_NAME };
