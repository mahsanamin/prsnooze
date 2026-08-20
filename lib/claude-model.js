"use strict";

// Which Claude model the reviews actually run on.
//
// prsnooze never passes `--model`: every review inherits whatever the host's
// claude CLI is set to. That was invisible from the page, and it matters —
// the same PR reviewed on Haiku and on Opus comes back with very different
// reviews, and when the host changes their default the page should say so
// rather than leave the team guessing which one read their diff.
//
// Like the plan meter, there's no API for this: the CLI answers `/model`
// locally in print mode ("Current model: Opus 5 (1M context) (default)"), so
// asking costs no tokens — only CLI boot time. Hence the same shape as
// lib/claude-usage.js: cached, one shared spawn for concurrent callers. The TTL
// is far longer because a default model changes about as often as someone
// edits their settings, not once a review.

const { runPrint, CLI_TIMEOUT_MS } = require("./claude-cli");

const TTL_MS = 10 * 60_000;   // the default barely moves; don't re-spawn for it
// A failed refresh shouldn't blank out a name we already know — the model the
// host picked last week is still the best answer available, so keep serving it
// (flagged stale) rather than falling back to "unknown".
const STALE_MS = 6 * 60 * 60_000;

// "Current model: Opus 5 (1M context) (default)"
const MODEL_RE = /^\s*Current model:\s*(.+?)\s*$/im;
// The CLI marks a model it wasn't explicitly asked for as "(default)". Worth
// keeping as a flag — "this is just what the CLI came with" reads differently
// from "the host chose this" — but not worth carrying in the name.
const DEFAULT_SUFFIX_RE = /\s*\(default\)\s*$/i;

let cache = null;     // { at, data } — last reading, good or bad
let inflight = null;  // one spawn, however many callers are waiting on it

/**
 * Pull the model name out of the CLI's `/model` output.
 *
 * Only the name crosses the wire. The same output also lists every model alias
 * the host's account can reach, which says more about their plan than the page
 * needs to tell a room full of teammates.
 */
function parseModel(text) {
  const m = String(text || "").match(MODEL_RE);
  if (!m) return { ok: false, reason: "unknown" };
  const raw = m[1].trim();
  const isDefault = DEFAULT_SUFFIX_RE.test(raw);
  const name = raw.replace(DEFAULT_SUFFIX_RE, "").trim();
  if (!name) return { ok: false, reason: "unknown" };
  return { ok: true, name, isDefault };
}

/**
 * Latest model reading, cached. Never rejects — a failure is a payload with
 * ok:false, because "we couldn't ask" is something the page has to render too.
 */
async function getModel({ claudeBin = "claude", ttlMs = TTL_MS, force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < ttlMs) {
    return { ...cache.data, fetchedAt: cache.at, stale: false };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const parsed = parseModel(await runPrint(claudeBin, "/model", { timeoutMs: CLI_TIMEOUT_MS }));
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
function resetModelCache() {
  cache = null;
  inflight = null;
}

module.exports = { getModel, parseModel, resetModelCache, MODEL_TTL_MS: TTL_MS };
