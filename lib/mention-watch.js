"use strict";

// Mention watch: on a timer, find open PRs where someone @mentioned the host's
// GitHub account in a comment, and queue a review for each one.
//
// A comment mention is the only trigger. A mention in the PR description, a
// review request, or an assignment does not queue anything.
//
// Who can trigger it matters, because the review posts under the host's GitHub
// identity and runs on the host's plan. On a public repo anyone can comment, so
// a mention only counts when GitHub says its author is the repo's OWNER, a
// MEMBER of the owning org, or a COLLABORATOR. Bots and the host's own comments
// never count.
//
// A mention on a PR this host already reviewed resumes that review's session
// instead of starting a fresh review. "Check again" is a request for an answer:
// a fresh review on the same commit is skipped as already reviewed, and one
// that finds nothing new posts nothing, so the person who asked hears nothing
// back. A resume always posts one follow-up review.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const STATE_FILE = "mention-watch.json";
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// Search results and comment timestamps can lag a little. Each poll re-reads a
// short window before the last one and the handled list drops the repeats.
const OVERLAP_MS = 5 * 60 * 1000;
// A mention refused by admission (intake locked, usage floor) is retried on
// later polls, but not forever.
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HANDLED_LIMIT = 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const SEARCH_LIMIT = 50;

async function ghJson(args) {
  const { stdout } = await execFileP("gh", args, { maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  return JSON.parse(stdout || "null");
}

// Drop fenced code and quoted reply lines, so a mention pasted inside a code
// sample or quoted from an earlier comment does not count again.
function stripQuotedAndCode(body) {
  return String(body || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

function mentions(body, login) {
  if (!login) return false;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/-])@${escaped}(?![\\w-])`, "i").test(stripQuotedAndCode(body));
}

function loadState(dataHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataHome, STATE_FILE), "utf8"));
    return {
      since: Number.isFinite(raw.since) ? raw.since : null,
      handled: Array.isArray(raw.handled) ? raw.handled.filter((k) => typeof k === "string").slice(-HANDLED_LIMIT) : [],
      pending: Array.isArray(raw.pending) ? raw.pending.filter((p) => p && typeof p.key === "string") : [],
    };
  } catch {
    return { since: null, handled: [], pending: [] };
  }
}

function saveState(dataHome, state) {
  try {
    fs.mkdirSync(dataHome, { recursive: true });
    const target = path.join(dataHome, STATE_FILE);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    // A lost write only means a few comments are looked at again next time;
    // the active-review check still stops a duplicate review.
  }
}

// The default GitHub reader. Tests pass their own.
function createGhReader(run = ghJson) {
  return {
    async searchMentionedPrs(login, sinceMs) {
      const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");
      const data = await run([
        "api", "-X", "GET", "search/issues",
        "-f", `q=is:pr is:open mentions:${login} updated:>=${since}`,
        "-f", `per_page=${SEARCH_LIMIT}`,
      ]);
      return (data?.items || [])
        .map((item) => item.pull_request?.html_url || item.html_url)
        .filter((url) => /\/pull\/\d+$/.test(String(url || "")));
    },
    async commentsSince(prUrl, sinceMs) {
      const [, owner, repo, number] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl) || [];
      if (!owner) return [];
      const since = new Date(sinceMs).toISOString();
      const base = `repos/${owner}/${repo}`;
      const [issueComments, reviewComments, reviews] = await Promise.all([
        run(["api", "-X", "GET", `${base}/issues/${number}/comments`, "-f", `since=${since}`, "-f", "per_page=100"]),
        run(["api", "-X", "GET", `${base}/pulls/${number}/comments`, "-f", `since=${since}`, "-f", "per_page=100"]),
        run(["api", "-X", "GET", `${base}/pulls/${number}/reviews`, "-f", "per_page=100"]),
      ]);
      const shape = (kind, c, at) => ({
        key: `${kind}:${c.id}`,
        body: c.body || "",
        author: c.user?.login || "",
        authorType: c.user?.type || "",
        association: String(c.author_association || "").toUpperCase(),
        createdAt: Date.parse(at || "") || 0,
        url: c.html_url || prUrl,
      });
      return [
        ...(issueComments || []).map((c) => shape("issue-comment", c, c.created_at)),
        ...(reviewComments || []).map((c) => shape("review-comment", c, c.created_at)),
        ...(reviews || []).map((c) => shape("review", c, c.submitted_at)),
      ];
    },
  };
}

/**
 * The watcher. Everything with a side effect is passed in so the server keeps
 * one queueing path (enqueueReview, with its admission policy) and tests can
 * run a poll without GitHub.
 */
function createMentionWatcher({
  dataHome,
  getLogin,
  enqueue,
  resume = null,
  findResumable = () => null,
  isPrActive = () => false,
  reader = createGhReader(),
  onChange = () => {},
  log = () => {},
  now = Date.now,
} = {}) {
  let state = loadState(dataHome);
  let config = { enabled: false, intervalMinutes: 5 };
  let timer = null;
  let running = null;
  let status = { lastRunAt: null, lastError: null, lastQueued: [], login: null, nextRunAt: null };

  function publicStatus() {
    return { ...status, lastQueued: status.lastQueued.slice(-10) };
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

  // Called on startup and after every settings save. Turning the watch on
  // starts the clock now, so mentions from before it was enabled are ignored.
  function configure(next) {
    const wasEnabled = config.enabled;
    config = { enabled: !!next?.enabled, intervalMinutes: next?.intervalMinutes || 5 };
    if (config.enabled && !wasEnabled && (!state.since || next?.resetClock)) {
      state = { since: now(), handled: state.handled, pending: [] };
      saveState(dataHome, state);
    }
    schedule(next?.startup ? STARTUP_DELAY_MS : null);
    onChange();
  }

  async function pollOnce() {
    if (running) return running;
    running = (async () => {
      const startedAt = now();
      const queued = [];
      try {
        const login = await getLogin();
        status.login = login || null;
        if (!login) throw new Error("gh is not signed in on this host, so mentions cannot be read. Run gh auth login.");
        // Never look back more than a day, so a host that was off for a week
        // does not wake up and review every PR it was mentioned on.
        const since = Math.max(
          startedAt - PENDING_MAX_AGE_MS,
          Math.min(state.since ?? startedAt, ...state.pending.map((p) => p.createdAt)) - OVERLAP_MS,
        );
        const handled = new Set(state.handled);
        const prUrls = await reader.searchMentionedPrs(login, since);
        const stillPending = [];

        for (const prUrl of prUrls) {
          const comments = await reader.commentsSince(prUrl, since);
          const fresh = comments
            .filter((c) => c.createdAt >= since && !handled.has(c.key))
            .filter((c) => c.author.toLowerCase() !== login.toLowerCase())
            .filter((c) => c.authorType !== "Bot" && !/\[bot\]$/i.test(c.author))
            .filter((c) => TRUSTED_ASSOCIATIONS.has(c.association))
            .filter((c) => mentions(c.body, login))
            .sort((a, b) => a.createdAt - b.createdAt);
          if (!fresh.length) continue;
          const trigger = fresh[fresh.length - 1];
          if (isPrActive(prUrl)) {
            log(`mention watch: ${prUrl} is already being reviewed; skipping @${trigger.author}'s mention`);
            fresh.forEach((c) => handled.add(c.key));
            continue;
          }
          const requestedBy = { label: `@${trigger.author} mentioned @${login}`, address: trigger.url, source: "mention" };
          try {
            const earlier = resume ? findResumable(prUrl) : null;
            const result = earlier
              ? await resume(earlier, { force: true, requestedBy })
              : await enqueue({ prUrl, requestedBy });
            fresh.forEach((c) => handled.add(c.key));
            queued.push({ prUrl, jobId: result?.jobId || earlier || null, by: trigger.author, at: startedAt, resumed: !!earlier });
            log(`mention watch: ${earlier ? "resumed the earlier review of" : "queued"} ${prUrl} for @${trigger.author}'s mention`);
          } catch (error) {
            // Refused by admission or the provider: try again on a later poll
            // until the mention is a day old.
            if (startedAt - trigger.createdAt < PENDING_MAX_AGE_MS) {
              stillPending.push({ key: trigger.key, prUrl, createdAt: trigger.createdAt });
            } else {
              fresh.forEach((c) => handled.add(c.key));
            }
            log(`mention watch: could not queue ${prUrl}: ${error.message}`);
            status.lastError = `Could not queue ${prUrl}: ${error.message}`;
          }
        }

        state = {
          since: startedAt,
          handled: [...handled].slice(-HANDLED_LIMIT),
          pending: stillPending,
        };
        saveState(dataHome, state);
        if (!stillPending.length) status.lastError = null;
      } catch (error) {
        status.lastError = error.message || String(error);
        log(`mention watch: ${status.lastError}`);
      } finally {
        status.lastRunAt = startedAt;
        status.lastQueued = [...status.lastQueued, ...queued].slice(-10);
        running = null;
        onChange();
      }
      return { queued };
    })();
    return running;
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { configure, pollOnce, status: publicStatus, stop };
}

module.exports = { createMentionWatcher, createGhReader, mentions, stripQuotedAndCode, TRUSTED_ASSOCIATIONS };
