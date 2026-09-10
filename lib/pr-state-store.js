"use strict";
const fs = require("node:fs");
const path = require("node:path");

function createPrStateStore(dataHome, { now = Date.now } = {}) {
  const file = path.join(dataHome, "pr-states.json");
  const states = new Map();
  try {
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(entries)) for (const [url, state] of entries.slice(-500)) {
      if (typeof url === "string" && state?.ok && ["OPEN", "CLOSED", "MERGED"].includes(state.state)
        && Number.isFinite(state.checkedAt)) states.set(url, state);
    }
  } catch { /* Optional cache: malformed or missing data never blocks startup. */ }
  return {
    get: (url) => states.get(url) || null,
    remember(url, value) {
      if (!value?.ok || !["OPEN", "CLOSED", "MERGED"].includes(value.state)) return null;
      const state = { ok: true, state: value.state, merged: value.state === "MERGED",
        open: value.state === "OPEN", approved: !!value.approved, isDraft: !!value.isDraft,
        reviewDecision: value.reviewDecision || null, checkedAt: now() };
      states.delete(url);
      states.set(url, state);
      while (states.size > 500) states.delete(states.keys().next().value);
      try {
        fs.mkdirSync(dataHome, { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify([...states]), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch { console.warn("[pr-state] Could not persist status cache; keeping it in memory."); }
      return state;
    },
  };
}

// One bounded batch per tick. In-flight batches never overlap; failures back
// off just like successes so a broken PR cannot starve the rest of the list.
function createPrStateRefresh({ listJobs, getState, probe, now = Date.now }) {
  const attempts = new Map();
  let busy = false;
  return async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const urls = [...new Set(listJobs().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 50).map((job) => job.prUrl).filter(Boolean))];
      for (const url of attempts.keys()) if (!urls.includes(url)) attempts.delete(url);
      const due = urls.filter((url) => getState(url)?.state !== "MERGED"
        && now() - Math.max(attempts.get(url) || 0, getState(url)?.checkedAt || 0) >= 5 * 60_000)
        .sort((a, b) => (attempts.get(a) || getState(a)?.checkedAt || 0) - (attempts.get(b) || getState(b)?.checkedAt || 0));
      for (const url of due.slice(0, 3)) {
        attempts.set(url, now());
        try { await probe(url); } catch { /* Retry on a later tick. */ }
      }
    } finally { busy = false; }
  };
}

module.exports = { createPrStateStore, createPrStateRefresh };
