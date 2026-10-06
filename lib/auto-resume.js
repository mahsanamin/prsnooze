"use strict";

// Auto-resume: on a timer, look at reviews this host posted comments on, and
// when the PR author has pushed new commits since, resume that review's
// session so it checks whether the comments were addressed.
//
// New commits are the only trigger. A reply on the PR without a push is left
// for a person to resume by hand, because a reply alone often means "I
// disagree", not "please look again".
//
// The actual resume goes through the server's resumeReviewJob, so the resume
// gate, admission policy and refusal reasons are the same as the button's.

// Outcomes that leave something for the author to fix. "approved" is done, and
// a skipped or failed review has no posted comments to follow up on.
const FOLLOW_UP_OUTCOMES = new Set(["commented", "changes_requested", "no_new_findings"]);
// A review older than this is left alone; the PR has usually moved on.
const MAX_REVIEW_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Each candidate costs a couple of gh calls per check, so look at the newest few.
const MAX_CANDIDATES = 20;
const STARTUP_DELAY_MS = 60 * 1000;

/**
 * The newest finished review per PR that is worth following up, newest first.
 * Pure, so the selection can be tested without a server.
 */
function pickCandidates(jobs, { now = Date.now(), prState = () => null, hasSession = () => false } = {}) {
  const newestPerPr = new Map();
  for (const job of jobs) {
    if (!job?.prUrl || !hasSession(job)) continue;
    const key = String(job.prUrl).toLowerCase();
    const current = newestPerPr.get(key);
    if (!current || (job.createdAt || 0) > (current.createdAt || 0)) newestPerPr.set(key, job);
  }
  return Array.from(newestPerPr.values())
    .filter((job) => job.state === "done" && !job.skipped && FOLLOW_UP_OUTCOMES.has(job.outcome))
    .filter((job) => now - (job.finishedAt || 0) <= MAX_REVIEW_AGE_MS)
    .filter((job) => {
      const state = String(prState(job.prUrl)?.state || "").toUpperCase();
      return state !== "MERGED" && state !== "CLOSED";
    })
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, MAX_CANDIDATES);
}

function createAutoResumer({
  listJobs,
  hasSession,
  prState = () => null,
  assess,
  resume,
  persist = () => {},
  onChange = () => {},
  log = () => {},
  now = Date.now,
} = {}) {
  let config = { enabled: false, intervalMinutes: 5 };
  let timer = null;
  let running = null;
  const status = { lastRunAt: null, lastError: null, lastResumed: [], nextRunAt: null };

  function publicStatus() {
    return { ...status, lastResumed: status.lastResumed.slice(-10) };
  }

  // `firstDelayMs` is for startup: a restart must not push the next check a
  // whole interval out, or frequent restarts mean it never runs.
  function schedule(firstDelayMs = null) {
    if (timer) clearTimeout(timer);
    timer = null;
    status.nextRunAt = null;
    if (!config.enabled) return;
    const interval = config.intervalMinutes * 60 * 1000;
    const delay = firstDelayMs === null ? interval : Math.min(firstDelayMs, interval);
    status.nextRunAt = now() + delay;
    timer = setTimeout(() => { pollOnce().catch(() => {}).finally(() => schedule()); }, delay);
    timer.unref?.();
  }

  function configure(next) {
    config = { enabled: !!next?.enabled, intervalMinutes: next?.intervalMinutes || 5 };
    schedule(next?.startup ? STARTUP_DELAY_MS : null);
    onChange();
  }

  async function pollOnce() {
    if (running) return running;
    running = (async () => {
      const startedAt = now();
      const resumed = [];
      const errors = [];
      try {
        const candidates = pickCandidates(listJobs(), { now: startedAt, prState, hasSession });
        for (const job of candidates) {
          let assessment;
          try {
            assessment = await assess(job);
          } catch (error) {
            errors.push(`Could not check ${job.prUrl}: ${error.message}`);
            continue;
          }
          const signals = assessment?.signals || {};
          const pushed = (signals.newCommitCount || 0) > 0 || !!signals.headMoved;
          if (!assessment?.resumable || !pushed) continue;
          // One automatic follow-up per pushed head. Without this, a review
          // whose recorded head never updates would resume on every check.
          const head = signals.headRefOid || "";
          if (head && job.autoResumedAtSha === head) continue;
          try {
            job.autoResumedAtSha = head || null;
            persist(job);
            await resume(job.id, {
              requestedBy: { label: "auto-resume: new commits", address: job.prUrl, source: "auto-resume" },
            });
            resumed.push({ prUrl: job.prUrl, jobId: job.id, at: startedAt });
            log(`auto-resume: resumed ${job.prUrl} after new commits`);
          } catch (error) {
            // Refused by admission or the gate. Clear the marker so a later
            // check tries again once capacity or the plan allows it.
            job.autoResumedAtSha = null;
            persist(job);
            errors.push(`Could not resume ${job.prUrl}: ${error.message}`);
          }
        }
      } catch (error) {
        errors.push(error.message || String(error));
      } finally {
        status.lastRunAt = startedAt;
        status.lastError = errors.length ? errors.join(" ") : null;
        status.lastResumed = [...status.lastResumed, ...resumed].slice(-10);
        if (errors.length) log(`auto-resume: ${status.lastError}`);
        running = null;
        onChange();
      }
      return { resumed };
    })();
    return running;
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { configure, pollOnce, status: publicStatus, stop };
}

module.exports = { createAutoResumer, pickCandidates, FOLLOW_UP_OUTCOMES };
