"use strict";

// How much of the host's Claude plan is left.
//
// prsnooze spends someone's personal Claude subscription on other people's PRs,
// and until now nobody using the page could see how much of it was left. When
// the limit runs out reviews just start failing, which reads as "the tool is
// broken" rather than "the plan is spent until 9pm".
//
// There is no API for this and no file to read: the numbers live inside the
// claude CLI, which prints them for `/usage`. In print mode that slash command
// is answered locally — zero turns, zero tokens, no model call — so asking
// costs nothing against the very limit we're reporting. It is not cheap in
// *time* (~5s of CLI boot), and this is reachable by every teammate with the
// page open, so readings are cached and concurrent callers share one spawn.

const { spawn } = require("node:child_process");
const os = require("node:os");

const TTL_MS = 90_000;        // a reading this fresh is good enough to reuse
const TIMEOUT_MS = 25_000;    // the CLI is slow to boot; still, don't hang forever
// A failed refresh shouldn't blank the number out — a slightly old reading is
// far more useful than "unknown", so keep serving the last good one (flagged
// stale) for a while before admitting we don't know.
const STALE_MS = 15 * 60_000;

// "Current session: 13% used · resets Aug 7 at 9:20pm (Asia/Karachi)"
// "Current week (all models): 8% used"
const LIMIT_RE = /^\s*([^:]{1,60}?):\s*(\d{1,3}(?:\.\d+)?)%\s+used\b(.*)$/i;
const RESETS_RE = /resets\s+(.+?)\s*$/i;
// "Last 24h · 500 requests · 14 sessions"
const ACTIVITY_RE = /^\s*Last\s+(24h|7d)\D+([\d,]+)\s+requests?\D+([\d,]+)\s+sessions?/i;

let cache = null;     // { at, data } — last reading, good or bad
let inflight = null;  // one spawn, however many callers are waiting on it

/** Ask the CLI for its usage report. Resolves with stdout. */
function runUsage(claudeBin) {
  return new Promise((resolve, reject) => {
    // Home, not the server's checkout: this asks a question about the account,
    // so it has no business being pointed at a repo.
    const child = spawn(claudeBin, ["-p", "/usage"], {
      cwd: os.homedir(),
      env: process.env,
      // stdin closed, or the CLI waits 3s for input that will never come.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, new Error(`claude /usage timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      if (code === 0) return finish(resolve, out);
      finish(reject, new Error(`claude exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ""}`));
    });
  });
}

function prettyLabel(raw) {
  const s = raw.trim().replace(/^current\s+/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function windowId(raw) {
  return (
    raw.toLowerCase().replace(/^current\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
    "window"
  );
}

/**
 * Pull the limit windows out of the CLI's report.
 *
 * Only the numbers are extracted, deliberately: the rest of that report is a
 * breakdown of the host's own working habits (their top skills, their MCP
 * servers) and none of it belongs on a page their whole team can open.
 */
function parseUsage(text) {
  const lines = String(text || "").split("\n");
  const subscription = /using your subscription/i.test(text || "");
  const windows = [];
  const activity = {};
  for (const line of lines) {
    const a = line.match(ACTIVITY_RE);
    if (a) {
      activity[a[1].toLowerCase()] = {
        requests: parseInt(a[2].replace(/,/g, ""), 10),
        sessions: parseInt(a[3].replace(/,/g, ""), 10),
      };
      continue;
    }
    const m = line.match(LIMIT_RE);
    if (!m) continue;
    const usedPct = parseFloat(m[2]);
    if (!Number.isFinite(usedPct)) continue;
    const resets = (m[3].match(RESETS_RE) || [])[1] || null;
    windows.push({
      id: windowId(m[1]),
      label: prettyLabel(m[1]),
      usedPct,
      leftPct: Math.round(Math.max(0, 100 - usedPct) * 10) / 10,
      resets,
      // The CLI stamps its own timezone on the reset time. Teammates elsewhere
      // need to know whose clock that is, so the zone travels with the string
      // and the compact form drops it.
      resetsShort: resets ? resets.replace(/\s*\([^)]*\)\s*$/, "") : null,
      zone: resets ? ((resets.match(/\(([^)]+)\)\s*$/) || [])[1] || null) : null,
    });
  }
  if (!windows.length) {
    // Reached the CLI, got no percentages: an API-key setup has no plan window
    // to report, and a logged-out one has nothing at all.
    return { ok: false, reason: subscription ? "no-limits-reported" : "not-a-subscription", subscription };
  }
  return { ok: true, subscription, windows, activity };
}

/**
 * Latest usage reading, cached. Never rejects — a failure is a payload with
 * ok:false, because "we couldn't ask" is something the page has to render too.
 */
async function getUsage({ claudeBin = "claude", ttlMs = TTL_MS, force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < ttlMs) {
    return { ...cache.data, fetchedAt: cache.at, stale: false };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const parsed = parseUsage(await runUsage(claudeBin));
      cache = { at: Date.now(), data: parsed };
      return { ...parsed, fetchedAt: cache.at, stale: false };
    } catch (err) {
      if (cache?.data?.ok && Date.now() - cache.at < STALE_MS) {
        return { ...cache.data, fetchedAt: cache.at, stale: true };
      }
      const data = { ok: false, reason: "unavailable", detail: err.message };
      cache = { at: Date.now(), data };
      return { ...data, fetchedAt: cache.at, stale: false };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Tests only: forget the cached reading. */
function resetUsageCache() {
  cache = null;
  inflight = null;
}

module.exports = { getUsage, parseUsage, resetUsageCache, USAGE_TTL_MS: TTL_MS };
