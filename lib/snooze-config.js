"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The CLI's own state, separate from a server's ~/.prsnooze. A person can have
// the CLI without running an instance, and someone running an instance should
// not have their peer list wiped when they reset the server's data dir.
function configHome() {
  return process.env.SNOOZE_HOME || path.join(os.homedir(), ".snooze");
}

function configPath() {
  return path.join(configHome(), "config.json");
}

function emptyConfig() {
  return { token: null, peers: [] };
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    return {
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : null,
      peers: Array.isArray(parsed.peers) ? parsed.peers.filter((p) => p && p.url) : [],
    };
  } catch {
    return emptyConfig();
  }
}

function writeConfig(config) {
  fs.mkdirSync(configHome(), { recursive: true });
  // The file holds a shared secret, so it is never world- or group-readable.
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    // An exotic filesystem that refuses chmod should not fail the write.
  }
}

function normalizeUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("a peer URL is required");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  // Stored without a trailing slash so request paths concatenate predictably.
  return url.origin;
}

/**
 * Resolve what the user typed to one peer.
 *
 * Both forms are accepted on purpose. A local nickname is what someone types
 * from memory, but an instance short id is what a job ref carries, because a
 * ref has to mean the same instance in every colleague's CLI.
 */
function findPeer(config, needle) {
  const key = String(needle || "").trim().toLowerCase();
  if (!key) return null;

  const unique = (matches) => {
    if (matches.length > 1) {
      throw new Error(`ambiguous peer "${needle}" matches ${matches.length} instances; use its full URL or instance id`);
    }
    return matches[0] || null;
  };
  const matchers = [
    (p) => String(p.name || "").toLowerCase() === key,
    (p) => String(p.shortId || "").toLowerCase() === key,
    (p) => String(p.instanceId || "").toLowerCase() === key,
    (p) => {
      try {
        return p.url === normalizeUrl(needle);
      } catch {
        return false;
      }
    },
  ];
  for (const matches of matchers.map((matcher) => config.peers.filter(matcher))) {
    if (matches.length) return unique(matches);
  }
  return null;
}

function tokenFor(config, peer) {
  return (peer && peer.token) || config.token || null;
}

/** `<instance-short-id>/<job-id>`, the portable way to name one review. */
function parseRef(raw) {
  const value = String(raw || "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`not a review ref: ${raw} (expected <instance>/<job-id>)`);
  }
  return { peer: value.slice(0, slash), jobId: value.slice(slash + 1) };
}

module.exports = {
  configHome,
  configPath,
  emptyConfig,
  readConfig,
  writeConfig,
  normalizeUrl,
  findPeer,
  tokenFor,
  parseRef,
};
