const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const express = require("express");
const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { execSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(execFile);
const { v4: uuidv4 } = require("uuid");

const { Queue } = require("./lib/queue");
const { runReviewJob, runVerifyJob } = require("./lib/review-job");
const { createProvider, discoverProvidersSync, providerIds } = require("./lib/providers");
const { parsePrUrl, getSelfLogin, fetchPrState, fetchResumeSignals, assessResumability, resumeGate } = require("./lib/github");
const { loadIdentity, shortId } = require("./lib/instance-identity");
const { createRemoteRouter, createAttemptLimiter } = require("./lib/remote-api");

// --- env ---
loadDotenv(path.join(__dirname, ".env"));

const PORT = parseInt(process.env.PORT || "8284", 10);
const DATA_HOME = path.resolve(
  process.env.PRSNOOZE_HOME || path.join(os.homedir(), ".prsnooze"),
);
const REPOS_DIR = path.resolve(process.env.REPOS_DIR || path.join(DATA_HOME, "repos"));
const WORKTREES_DIR = path.resolve(
  process.env.WORKTREES_DIR || path.join(DATA_HOME, "worktrees"),
);
const OUTPUTS_DIR = path.resolve(
  process.env.OUTPUTS_DIR || path.join(DATA_HOME, "outputs"),
);
const JOBS_DIR = path.join(OUTPUTS_DIR, "jobs");
const KEEP_WORKTREE_ON_SUCCESS = String(process.env.KEEP_WORKTREES_ON_SUCCESS || "false") === "true";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const discoveredProviders = discoverProvidersSync({ env: process.env });
// Keep the server usable under --no-check even when neither CLI is currently
// runnable. Preflight will explain the missing binary, as it did before.
const providerList = discoveredProviders.length
  ? discoveredProviders
  : providerIds(process.env.REVIEW_PROVIDERS).map((id) => createProvider(id, process.env)).filter(Boolean);
const PROVIDERS = new Map(providerList.map((provider) => [provider.id, provider]));
const requestedDefaultProvider = String(process.env.DEFAULT_REVIEW_PROVIDER || "claude").toLowerCase();
const DEFAULT_REVIEW_PROVIDER = PROVIDERS.has(requestedDefaultProvider)
  ? requestedDefaultProvider
  : PROVIDERS.keys().next().value || "claude";
const HERO_IMAGE = process.env.HERO_IMAGE || "/heroes/sleepy-cat.svg";
const AUTO_APPROVE = String(process.env.AUTO_APPROVE ?? "true") === "true";
const CONFIDENCE_THRESHOLD = parseInt(process.env.CONFIDENCE_THRESHOLD || "80", 10);
const SKIP_IF_ALREADY_REVIEWED = String(process.env.SKIP_IF_ALREADY_REVIEWED ?? "true") === "true";
// How many reviews run at once. Default 1 = sequential (one at a time, no
// concurrency). Set >1 to allow that many concurrent reviews.
const MAX_CONCURRENT_REVIEWS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_REVIEWS || "1", 10));
// The password that authorises approving a PR. Asked for on every approval —
// there is no unlock step and nothing is remembered between clicks — and only
// ever compared here; it never travels to the browser.
//
// Unset means no approval can be authorised, and the flow is deliberately
// identical to a wrong password: same prompt, same answer. A page your team can
// reach shouldn't advertise whether approving is configured, and one path is one
// path to get right.
const APPROVE_PASSWORD = process.env.MANUAL_APPROVE_PASSWORD || "";

// Shared secret for the cross-instance API that `bin/snooze` talks to. Unset
// means the remote API is off, which is the default: reaching those routes
// spends this host's provider plan and posts a review under their GitHub
// identity, so it is opt-in rather than something a rebuild switches on.
const REMOTE_TOKEN = process.env.PRSNOOZE_REMOTE_TOKEN || "";
const PKG_VERSION = require("./package.json").version;

// Who owns the machine this instance runs on — surfaced in the UI so teammates
// know whose gh identity will post the reviews. Override with PRSNOOZE_HOST.
const HOST_NAME = detectHost();
// The host's gh login (for approve-rights). Resolved once at startup; null if
// gh isn't authenticated.
let HOST_LOGIN = null;
getSelfLogin().then((l) => { HOST_LOGIN = l || null; }).catch(() => {});
function detectHost() {
  const tryCmd = (cmd) => {
    try {
      return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  return (
    process.env.PRSNOOZE_HOST ||
    tryCmd("git config user.name") ||
    os.userInfo().username ||
    os.hostname()
  );
}

for (const d of [REPOS_DIR, WORKTREES_DIR, JOBS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// The stable name a colleague's CLI reaches this instance by. Read once at
// boot, after the data dir exists so the first run can persist it.
const IDENTITY = loadIdentity({ dataHome: DATA_HOME, name: HOST_NAME });

// --- in-memory job state ---
// jobs: id -> { id, prUrl, createdAt, state, events: [...], prMeta?, worktreePath?, error? }
const jobs = new Map();
const subscribers = new Map(); // jobId -> Set<res>

function persistJob(job) {
  const p = path.join(JOBS_DIR, `${job.id}.json`);
  fsp.writeFile(p, JSON.stringify(job, null, 2)).catch(() => {});
}

function pushEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.events.push(event);
  if (event.kind === "phase") job.phase = event.phase;
  if (event.kind === "pr_meta") job.prMeta = event;
  if (event.kind === "worktree_ready") job.worktreePath = event.path;
  if (event.kind === "agent_started" || event.kind === "claude_started") {
    job.agentPid = event.pid || null;
    job.claudePid = event.pid || null;
  }
  // The CLI announces the model it booted with on its init event. Recorded on
  // the job so a review keeps the model that actually read the diff, even after
  // the host changes their default.
  if (event.kind === "system" && event.model) job.model = event.model;
  if (event.kind === "summary" && event.sessionId) job.sessionId = event.sessionId;
  if (event.kind === "summary") job.summary = event;
  if (event.kind === "failed") job.error = event.error;
  if (event.kind === "outcome_detected") job.outcome = event.outcome;
  if (event.kind === "skipped") {
    job.skipped = true;
    job.skipReason = event.reason;
    job.skipMessage = event.message || "";
    job.outcome = event.outcome || "skipped";
  }
  for (const res of subscribers.get(jobId) || []) {
    sendSse(res, event);
  }
  // Throttle persistence: write on coarse changes only
  if (
    event.kind === "queued" ||
    event.kind === "started" ||
    event.kind === "phase" ||
    event.kind === "agent_started" ||
    event.kind === "claude_started" ||
    event.kind === "done" ||
    event.kind === "failed" ||
    event.kind === "summary"
  ) {
    persistJob(job);
  }
}

const queue = new Queue(
  (job, helpers) => {
    const cfg = {
      reposDir: REPOS_DIR,
      worktreesDir: WORKTREES_DIR,
      claudeBin: CLAUDE_BIN,
      codexBin: CODEX_BIN,
      providers: PROVIDERS,
      defaultProvider: DEFAULT_REVIEW_PROVIDER,
      keepWorktreeOnSuccess: KEEP_WORKTREE_ON_SUCCESS,
      autoApprove: AUTO_APPROVE,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      skipIfAlreadyReviewed: SKIP_IF_ALREADY_REVIEWED,
    };
    return job.mode === "verify"
      ? runVerifyJob(job, helpers, cfg)
      : runReviewJob(job, helpers, cfg);
  },
  { concurrency: MAX_CONCURRENT_REVIEWS },
);

queue.on("job", ({ jobId, event }) => pushEvent(jobId, event));
queue.on("state", ({ jobId, state }) => {
  const job = jobs.get(jobId);
  if (!job) return;
  job.state = state;
  if (state === "done" || state === "failed") {
    job.finishedAt = Date.now();
    persistJob(job);
  }
  // Every state transition (queued/running/done/failed, incl. a brand-new
  // job's initial "queued") pushes a fresh list snapshot to all WS clients —
  // this is what replaces the frontend's /api/jobs poll.
  broadcastJobs();
});

// --- HTTP ---
const app = express();
app.use(
  "/api/remote",
  createRemoteRouter({
    token: REMOTE_TOKEN,
    identity: IDENTITY,
    describe: ({ includeUsage } = {}) => describeInstance({ includeUsage }),
    submitReview: ({ prUrl, provider, requestedBy }) => enqueueReview({ prUrl, provider, requestedBy }),
    describeJob: (id) => {
      const job = jobs.get(id);
      if (!job) return null;
      return {
        ...jobListItem(job),
        // Whether resume is even possible, so the CLI can say so before asking.
        hasSession: !!reviewSessionId(job),
        requestedBy: job.requestedBy || null,
        error: job.error || null,
      };
    },
    resumeReview: (id, opts) => resumeReviewJob(id, opts),
  }),
);
app.use(express.json({ limit: "1mb" }));

// Serve index.html ourselves with a version stamp on the asset URLs. A reverse
// proxy in front (e.g. openresty) may slap a long max-age on /app.js and
// /style.css, so browsers would keep running stale JS/CSS after a deploy. The
// HTML itself is always revalidated (max-age=0), so stamping ?v=<mtime> on the
// asset refs guarantees a changed file is fetched fresh — through the proxy too
// (new query = new cache key). The version only changes when a file changes.
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_PATH = path.join(PUBLIC_DIR, "index.html");
function assetVersion() {
  try {
    const mtimes = ["app.js", "style.css", "index.html"].map(
      (f) => fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs,
    );
    return Math.floor(Math.max(...mtimes)).toString(36);
  } catch {
    return "1";
  }
}
function serveIndex(_req, res) {
  fs.readFile(INDEX_PATH, "utf8", (err, html) => {
    if (err) return res.status(500).send("index read error");
    const v = assetVersion();
    const stamped = html
      .replace('href="/style.css"', `href="/style.css?v=${v}"`)
      .replace('src="/app.js"', `src="/app.js?v=${v}"`);
    res.set("Cache-Control", "no-cache");
    res.type("html").send(stamped);
  });
}
app.get("/", serveIndex);
app.get("/index.html", serveIndex);
// index:false so the static handler doesn't serve the un-stamped index.html.
app.use(express.static(PUBLIC_DIR, { index: false }));

// --- authorising an approval ----------------------------------------------
// There is no session, no cookie and no unlocked state: the password comes in
// with the approval it authorises, is checked once, and is not kept. That's the
// whole mechanism, and it's the reason nothing in the UI has to track it.
//
// Two things matter in the comparison: it must not leak by timing, and a guess
// must not be cheap. It used to hash both sides with a bare SHA-256 — only ever
// to get two equal-length buffers for timingSafeEqual, since comparing the raw
// strings leaks the length — but a bare digest is fast, so a guess cost an
// attacker nothing beyond the round trip and the throttle below was the only
// thing slowing them down. That matters most in the case the throttle is weakest
// at: behind a reverse proxy, where every request arrives from one IP.
//
// scrypt is deliberately expensive instead (tens of ms), which is nothing on a
// click a human makes by hand and a real cost per guess. The salt is random per
// process: nothing is stored, so it never has to survive a restart, and a fresh
// one each boot means no digest here can be precomputed against.
//
// An unset password can't match anything — including an empty guess, which is
// what the early return is for.
const APPROVE_SALT = crypto.randomBytes(16);
const scrypt = promisify(crypto.scrypt);
let configuredHash = null; // computed once, on the first attempt
async function passwordMatches(input) {
  if (!APPROVE_PASSWORD || !input) return false;
  if (!configuredHash) configuredHash = scrypt(APPROVE_PASSWORD, APPROVE_SALT, 32);
  const [got, want] = await Promise.all([scrypt(String(input), APPROVE_SALT, 32), configuredHash]);
  return crypto.timingSafeEqual(got, want);
}
function isLoopback(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.");
}

app.get("/api/config", (req, res) => {
  res.json({
    heroImage: HERO_IMAGE,
    brand: "prsnooze",
    host: HOST_NAME,
    isHost: isLoopback(req),
    hostLogin: HOST_LOGIN,
    concurrent: MAX_CONCURRENT_REVIEWS > 1,
    providers: providerList.map(({ id, label }) => ({ id, label })),
    defaultProvider: DEFAULT_REVIEW_PROVIDER,
    // Nothing about the approve password is reported. The button always shows
    // and always asks, so the client has no state to sync — and whether a
    // password is configured isn't the browser's business.
  });
});

// What prsnooze itself has spent this calendar month. Claude's plan meters in
// 5-hour and weekly windows — there is no monthly limit to report — so this
// isn't a limit, it's a total: how much of the host's plan went on reviewing
// other people's PRs since the 1st. Read from the job history already on disk,
// so it costs nothing and stays live even when the CLI reading is stale.
function monthToDateUsage(now = new Date()) {
  const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let reviews = 0;
  let costUsd = 0;
  for (const j of jobs.values()) {
    const at = j.finishedAt || j.createdAt || 0;
    if (at < since || (j.state !== "done" && j.state !== "failed")) continue;
    reviews += 1;
    // Subscription runs still report what the same work would have cost on the
    // API — the only spend figure there is, so it's labelled as such in the UI.
    costUsd += Number(j.summary?.totalCostUsd) || 0;
  }
  return { since, reviews, costUsd: Math.round(costUsd * 100) / 100 };
}

// How much of the host's Claude plan is left. Open to everyone who can reach
// the page on purpose: they're the ones spending it, so they should be able to
// see what's left before they queue another review. The CLI reading is cached in
// lib/claude-usage.js, so a room full of open tabs still only spawns one CLI;
// the month-to-date total is cheap and always computed fresh.
app.get("/api/usage", async (_req, res) => {
  const providerId = String(_req.query.provider || DEFAULT_REVIEW_PROVIDER).toLowerCase();
  const provider = PROVIDERS.get(providerId);
  const data = provider?.getUsage
    ? await provider.getUsage({ bin: provider.bin, model: provider.model })
    : { ok: false, reason: provider ? "unsupported-by-provider" : "unknown-provider" };
  res.set("Cache-Control", "no-store");
  if (!data.ok && data.detail) {
    // The host is the only one who can fix a broken reading, so the reason goes
    // to their console — the page just says it doesn't know.
    console.warn(`[usage] unavailable: ${data.detail}`);
    const { detail, ...safe } = data;
    return res.json({ ...safe, month: monthToDateUsage() });
  }
  res.json({ ...data, month: monthToDateUsage() });
});

// Which model the selected provider reports. Claude answers through its local
// slash command; Codex reports an explicit configured model here and records
// an otherwise-defaulted model on the completed job from its session rollout.
// It is shown to everyone because "which model reviewed my PR" helps explain
// why a review reads the way it does.
app.get("/api/model", async (_req, res) => {
  const providerId = String(_req.query.provider || DEFAULT_REVIEW_PROVIDER).toLowerCase();
  const provider = PROVIDERS.get(providerId);
  const data = provider?.getModel
    ? await provider.getModel({ bin: provider.bin, model: provider.model })
    : { ok: false, reason: provider ? "unsupported-by-provider" : "unknown-provider" };
  res.set("Cache-Control", "no-store");
  if (!data.ok && data.detail) {
    // Only the host can fix a broken reading, so the reason goes to their
    // console — the page just says it doesn't know.
    console.warn(`[model] unavailable: ${data.detail}`);
    const { detail, ...safe } = data;
    return res.json(safe);
  }
  res.json(data);
});

// --- brute-force protection for the approval endpoint ----------------------
// Approving posts to GitHub as the host. Without a limit, anyone who can reach
// the page can try passwords as fast as the network allows. The remote API uses
// the same limiter implementation inside its router; both secrets get the same
// bounded-attempt treatment.
//
// In-memory and per-IP: this is a single process on one machine, so there is no
// shared store to coordinate with. Note that behind a reverse proxy every
// request looks like it comes from the proxy unless `trust proxy` is set, in
// which case a single attacker can lock the endpoint for everyone. That is the
// deliberate trade: approve is a rare manual action, and the lockout expires.
const approveLimiter = createAttemptLimiter();
const approveThrottle = (ip) => approveLimiter.check(ip);
const approveFailed = (ip) => approveLimiter.failed(ip);
const approveSucceeded = (ip) => approveLimiter.succeeded(ip);

// Queue one review. Shared by the browser route and the remote API so the two
// can never drift on what counts as a valid submission, which provider a job
// lands on, or what gets persisted.
function enqueueReview({ prUrl, provider: requested, requestedBy = null } = {}) {
  const provider = String(requested || DEFAULT_REVIEW_PROVIDER).toLowerCase();
  if (!prUrl) throw httpError(400, "prUrl is required");
  if (!PROVIDERS.has(provider)) {
    throw httpError(400, `review provider is not available: ${provider}`, "UNKNOWN_PROVIDER");
  }
  let parsed;
  try {
    parsed = parsePrUrl(prUrl);
  } catch (e) {
    throw httpError(400, e.message, "BAD_PR_URL");
  }
  const id = uuidv4();
  const job = {
    id,
    prUrl: parsed.url,
    createdAt: Date.now(),
    state: "queued",
    phase: null,
    provider,
    events: [],
    ...(requestedBy ? { requestedBy } : {}),
  };
  jobs.set(id, job);
  persistJob(job);
  queue.enqueue(job);
  return { jobId: id, prUrl: parsed.url, provider };
}

function httpError(status, message, code = undefined) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

app.post("/api/review", (req, res) => {
  try {
    const result = enqueueReview({ prUrl: req.body?.prUrl, provider: req.body?.provider });
    res.status(202).json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Coarse per-job shape for the list view (the WS snapshot and /api/jobs share
// this exactly, so REST and WebSocket never drift).
function jobListItem(j) {
  return {
    id: j.id,
    provider: j.provider || "claude",
    prUrl: j.prUrl,
    state: j.state,
    phase: j.phase,
    outcome: j.outcome || null, // "approved" | "commented" | "changes_requested" | null
    skipped: !!j.skipped,
    skipReason: j.skipReason || null,
    skipMessage: j.skipMessage || null,
    title: j.prMeta?.title,
    number: j.prMeta?.number,
    nameWithOwner: j.prMeta?.nameWithOwner,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    error: j.error,
    requestedBy: j.requestedBy || null,
    lastResumeRequestedBy: j.lastResumeRequestedBy || null,
  };
}
function jobsSnapshot() {
  const all = Array.from(jobs.values()).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  );
  const list = all.slice(0, 50).map(jobListItem);
  // `complete` = this snapshot is the whole job list, not the newest 50 of a
  // longer one. The frontend only prunes rows missing from a complete snapshot,
  // so a truncated list can't make older rows vanish from a browser that has
  // them.
  return { jobs: list, complete: list.length === all.length, queue: queue.status() };
}

app.get("/api/jobs", (_req, res) => {
  res.json(jobsSnapshot());
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

// Remove a finished review from the list, and from disk so it stays gone
// across a restart. Queued/running reviews are refused: their provider session
// is still streaming events at this job id, and dropping the record would
// leave those events with nowhere to land.
app.delete("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.state === "queued" || job.state === "running") {
    return res
      .status(409)
      .json({ error: "this review is still queued or running — wait for it to finish" });
  }
  jobs.delete(job.id);
  // End any SSE tail on this job cleanly, rather than leaving the browser
  // holding a stream that will never speak again.
  for (const sub of subscribers.get(job.id) || []) {
    sendSse(sub, { kind: "stream_end", state: "removed" });
    try { sub.end(); } catch {}
  }
  subscribers.delete(job.id);
  try {
    await fsp.rm(path.join(JOBS_DIR, `${job.id}.json`), { force: true });
  } catch {}
  broadcastJobs();
  res.json({ ok: true, id: job.id });
});


// --- resuming a finished review ------------------------------------------
// A review can be picked up where it left off: the provider session id is on the
// job, and its adapter continues that conversation instead of starting a
// fresh read of the PR. But resuming is only worth it under some conditions —
// the PR still open, not already approved, and something new to look at (the
// author pushed commits, or replied to the comments we left). This works out
// which case we're in so the UI can say so, and so a pointless run can be
// refused rather than silently costing a provider session.
function reviewSessionId(job) {
  return job.sessionId || job.summary?.sessionId || job.resumeSessionId || null;
}
async function assessJobResume(job) {
  const assessment = await fetchResumeSignals(job.prUrl).then((sig) =>
    assessResumability({
      ...sig,
      reviewedSha: job.prMeta?.headRefOid || "",
      reviewedAt: job.finishedAt || 0,
      hasSession: !!reviewSessionId(job),
    }),
  );
  return assessment;
}

// Read-only: is this PR still open, and has it already been approved? The
// Approve button is drawn from this, so it deliberately does NOT reuse
// resume-check — that answers a different question and returns nothing at all
// for a review with no provider session. Cached briefly: selecting a review asks,
// and clicking between reviews shouldn't mean a `gh` call per click.
//
// Failures are cached too, for much less time. A logged-out or timing-out `gh`
// is precisely the state where the client deliberately fails open and keeps the
// Approve button clickable — so every click used to spawn another `gh pr view`
// with a 20s timeout, from an endpoint that needs no password. A few seconds of
// "still broken" is a good enough answer.
const PR_STATE_TTL_MS = 30_000;
const PR_STATE_FAIL_TTL_MS = 5_000;
// How often a client may insist on a fresh probe for the same PR. The real
// caller does it once, after an approval GitHub refused; anything faster than
// this is a loop, and ?refresh=1 needs no password.
const PR_STATE_REFRESH_FLOOR_MS = 3_000;
const prStateCache = new Map();   // prUrl -> { at, ttl, value }
const prStateForced = new Map();  // prUrl -> ts of the last honoured ?refresh=1
const prStateInflight = new Map(); // prUrl -> in-flight probe

// The cache is keyed by PR, not by browser, so anything that makes the stored
// answer wrong has to drop it for everyone.
function forgetPrState(prUrl) {
  prStateCache.delete(prUrl || "");
}

// One `gh` per PR at a time. The cache alone doesn't give this: several clients
// selecting the same review in the same second all miss it and all spawn their
// own process, and a `gh` that ends in the 20s timeout leaves a long window for
// that to happen in. Callers of a probe already running just wait for it.
function probePrState(key, prUrl) {
  const running = prStateInflight.get(key);
  if (running) return running;
  const probe = fetchPrState(prUrl) // never throws — see lib/github.js
    .then((value) => {
      if (prStateCache.size > 500) prStateCache.clear();
      prStateCache.set(key, { at: Date.now(), ttl: value.ok ? PR_STATE_TTL_MS : PR_STATE_FAIL_TTL_MS, value });
      return value;
    })
    .finally(() => prStateInflight.delete(key));
  prStateInflight.set(key, probe);
  return probe;
}

app.get("/api/jobs/:id/pr-state", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const key = job.prUrl || "";
  const now = Date.now();
  // ?refresh=1 is the client saying "the answer you gave me turned out to be
  // wrong" — an approval GitHub refused, most often. Serving the cached entry
  // there would hand back the exact state that was just disproved, and since
  // the refusal lands seconds after the entry was written, that is the common
  // path rather than the edge case. Rate-limited per PR so it can't be used to
  // spend the host's processes: a second insistence inside the floor reads the
  // entry the first one just refreshed, which is the answer it wanted anyway.
  if (req.query.refresh === "1" && now - (prStateForced.get(key) || 0) >= PR_STATE_REFRESH_FLOOR_MS) {
    if (prStateForced.size > 500) prStateForced.clear();
    prStateForced.set(key, now);
    forgetPrState(key);
  }
  const hit = prStateCache.get(key);
  if (hit && now - hit.at < hit.ttl) return res.json(hit.value);
  res.json(await probePrState(key, job.prUrl));
});

// Read-only: what would happen if you hit resume, and why.
app.get("/api/jobs/:id/resume-check", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (isJobActive(job)) {
    return res.json({ resumable: false, code: "RUNNING", reason: "This review is still running.", signals: {} });
  }
  try {
    res.json(await assessJobResume(job));
  } catch (e) {
    res.json({ resumable: false, code: "UNKNOWN", reason: `Couldn't check the PR: ${e.message}`, signals: {} });
  }
});

function isJobActive(job) {
  return job.state === "queued" || job.state === "running";
}

// Resume: re-run this job by resuming its original provider session to
// check whether the author addressed the review's comments. No new session.
// Resume one finished review. Shared by the browser route and the remote API:
// the gate, the refusal reasons and what `force` may override have to be
// identical whether a person clicked the button or a colleague's CLI asked.
async function resumeReviewJob(jobId, { force = false, requestedBy = null } = {}) {
  const job = jobs.get(jobId);
  if (!job) throw httpError(404, "not found", "NOT_FOUND");
  const sessionId = reviewSessionId(job);
  if (!sessionId) {
    throw httpError(
      400,
      "no provider session recorded for this review; run a fresh review instead",
      "NO_SESSION",
    );
  }
  if (isJobActive(job)) {
    throw httpError(409, "this review is already running", "ALREADY_RUNNING");
  }
  // Don't burn a provider session on a PR that's already approved or untouched
  // since the last look — but that's advice, not a veto: `force` overrides it,
  // and the reason is handed back so the UI can explain what it's overriding.
  //
  // The one thing force cannot override is a merged or closed PR. There's no PR
  // left to review, the run would die at `resolving` anyway (fetchPrMetadata
  // refuses a non-OPEN PR), and getting that far would have flipped a finished
  // review's state to failed for nothing.
  let assessment;
  try {
    assessment = await assessJobResume(job);
  } catch (e) {
    assessment = { resumable: false, code: "UNKNOWN", reason: `Couldn't check the PR: ${e.message}`, signals: {} };
  }
  const gate = resumeGate({ assessment, forced: !!force });
  if (!gate.allow) {
    const err = httpError(409, gate.reason, "NOT_RESUMABLE");
    err.assessment = assessment;
    err.forcible = gate.forcible;
    throw err;
  }
  job.resumeReason = gate.reason;
  if (requestedBy) {
    job.lastResumeRequestedBy = requestedBy;
    job.remoteResumeRequests = [
      ...(Array.isArray(job.remoteResumeRequests) ? job.remoteResumeRequests : []),
      { requestedBy, at: Date.now() },
    ].slice(-20);
  }
  job.mode = "verify";
  job.resumeSessionId = sessionId;
  job.state = "queued";
  job.finished = false;
  job.events.push({
    ts: Date.now(),
    kind: "verify_restart",
    message: job.resumeReason
      ? `Resuming the review — ${job.resumeReason}`
      : "Resuming the review — re-checking whether the comments were addressed.",
  });
  persistJob(job);
  queue.enqueue(job);
  return { ok: true, jobId: job.id, provider: job.provider || "claude", reason: job.resumeReason || null };
}

app.post("/api/jobs/:id/verify", async (req, res) => {
  try {
    const result = await resumeReviewJob(req.params.id, { force: !!req.body?.force });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({
      error: e.message,
      assessment: e.assessment,
      forcible: e.forcible,
    });
  }
});

// Approve the PR. The browser can't run `gh`, so the server shells out to it
// here, under the host's existing `gh` login (the same identity every review
// posts under — no token/env var for gh).
//
// The password arrives with the request, every time. It's checked before the job
// is even looked up, so an unauthorised caller can't use this endpoint to find
// out which job ids exist, and a host with no password configured answers the
// same way a wrong guess does.
app.post("/api/jobs/:id/approve", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const throttled = approveThrottle(ip);
  if (throttled.blocked) {
    const secs = Math.ceil(throttled.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(secs));
    return res.status(429).json({ error: `Too many attempts — try again in ${secs}s.`, retryAfterMs: throttled.retryAfterMs });
  }
  if (!(await passwordMatches((req.body || {}).password))) {
    approveFailed(ip);
    return res.status(401).json({ error: "Not authorized — that password doesn't match." });
  }
  approveSucceeded(ip);
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (!job.prUrl) return res.status(400).json({ error: "no PR URL on this job" });
  // Reject approving your own PR up front (gh would also refuse).
  if (HOST_LOGIN && job.prMeta?.authorLogin && HOST_LOGIN === job.prMeta.authorLogin) {
    return res.status(400).json({ error: "you can't approve your own PR" });
  }
  try {
    // Array args (no shell) — job.prUrl was validated by parsePrUrl at creation.
    await execFileP("gh", ["pr", "review", job.prUrl, "--approve"], { timeout: 30000 });
    job.outcome = "approved";
    job.events.push({ ts: Date.now(), kind: "outcome_detected", outcome: "approved" });
    job.events.push({ ts: Date.now(), kind: "log", message: `Approved by @${HOST_LOGIN || "host"} via prsnooze.` });
    persistJob(job);
    // The PR is now approved, so the cached "open, unapproved" answer is stale
    // for every browser watching it, not just this one. Drop it so nobody else
    // is offered an Approve button that can only fail.
    forgetPrState(job.prUrl);
    res.json({ ok: true, outcome: "approved" });
  } catch (e) {
    const detail = (e.stderr || e.message || "").toString().trim().split("\n").slice(-3).join(" ");
    res.status(500).json({ error: `gh approve failed: ${detail || "unknown error"}` });
  }
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // Replay buffered events
  for (const ev of job.events) sendSse(res, ev);

  // If already finished, close after replay
  if (job.state === "done" || job.state === "failed") {
    sendSse(res, { kind: "stream_end", state: job.state });
    return res.end();
  }

  // Mark the boundary between replayed history and genuinely-live events, so
  // the client can render the backlog without re-firing chimes/notifications
  // (matters on reconnect and on a "Verify fixes" re-run of a finished job).
  sendSse(res, { kind: "caught_up" });

  // Subscribe to live events
  if (!subscribers.has(job.id)) subscribers.set(job.id, new Set());
  subscribers.get(job.id).add(res);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers.get(job.id)?.delete(res);
  });
});

// --- server + WebSocket live updates ---
// One HTTP server carries both the REST/SSE endpoints (via `app`) and the
// job-list WebSocket at /ws. broadcastJobs() pushes a snapshot to every
// connected browser whenever the job list changes (see queue.on("state")),
// which is what lets the frontend drop its /api/jobs poll.
const server = http.createServer(app);
let wss = null;

function broadcastJobs() {
  if (!wss) return;
  const msg = JSON.stringify({ type: "snapshot", ...jobsSnapshot() });
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(msg); } catch {}
    }
  }
}

function attachWebSocket(srv) {
  const w = new WebSocketServer({ server: srv, path: "/ws" });
  w.on("connection", (client) => {
    // Sync the newcomer immediately with the current list.
    try { client.send(JSON.stringify({ type: "snapshot", ...jobsSnapshot() })); } catch {}
  });
  return w;
}

// banner: print the config summary. Asked for explicitly by the two real entry
// points (`node server.js` and bin/start.js) and left off everywhere else, which
// in practice means the tests. It used to be gated on `require.main === module`
// — but bin/start.js *requires* this file rather than running it, so `npm start`
// (the way anyone actually starts prsnooze) printed no summary at all.
// --- the cross-instance API -----------------------------------------------
// What another machine's `snooze` CLI talks to. Its router is mounted before
// the global body parser so authentication happens before request-body work;
// callbacks still share enqueueReview and resumeReviewJob with the browser.

// Slot arithmetic is the thing a colleague actually asks about ("can you take a
// review right now"), so it is computed here instead of in every client. Plan
// usage is deliberately opt-in via ?usage=1: reading it shells out to the
// provider CLI, and `snooze status` across five peers should not pay that.
async function describeInstance({ includeUsage = false } = {}) {
  const q = queue.status();
  const free = Math.max(0, q.concurrency - q.running);
  const detail = {
    host: HOST_NAME,
    hostLogin: HOST_LOGIN,
    version: PKG_VERSION,
    providers: providerList.map(({ id, label }) => ({ id, label })),
    defaultProvider: DEFAULT_REVIEW_PROVIDER,
    slots: {
      capacity: q.concurrency,
      running: q.running,
      queued: q.pending.length,
      free,
      available: free > 0,
    },
  };
  if (includeUsage) {
    const provider = PROVIDERS.get(DEFAULT_REVIEW_PROVIDER);
    detail.usage = provider?.getUsage
      ? await provider.getUsage({ bin: provider.bin, model: provider.model }).catch(() => ({ ok: false, reason: "unavailable" }))
      : { ok: false, reason: "unsupported-by-provider" };
  }
  return detail;
}

function start(port = PORT, { banner = false } = {}) {
  // Restore past jobs from disk and reconcile anything left mid-flight by a
  // previous server that crashed or was restarted. Must run before we listen.
  hydrateJobs();
  wss = attachWebSocket(server);
  server.listen(port, "0.0.0.0", () => {
    const addr = server.address();
    console.log(`prsnooze listening on http://0.0.0.0:${addr.port}`);
    if (banner) {
      console.log(`  data home: ${DATA_HOME}`);
      console.log(`  repos:     ${REPOS_DIR}`);
      console.log(`  worktrees: ${WORKTREES_DIR}`);
      console.log(`  outputs:   ${OUTPUTS_DIR}`);
      console.log(`  providers: ${providerList.map((provider) => `${provider.label} (${provider.bin})`).join(", ")}`);
      console.log(`  default provider: ${DEFAULT_REVIEW_PROVIDER}`);
      console.log(`  keep wt on success: ${KEEP_WORKTREE_ON_SUCCESS}`);
      console.log(`  auto-approve clean PRs: ${AUTO_APPROVE}`);
      console.log(`  confidence threshold: ${CONFIDENCE_THRESHOLD}%`);
      console.log(`  skip if self-reviewed: ${SKIP_IF_ALREADY_REVIEWED}`);
      console.log(`  concurrent reviews: ${MAX_CONCURRENT_REVIEWS > 1 ? `up to ${MAX_CONCURRENT_REVIEWS}` : "off — one at a time"}`);
      console.log(`  approve password: ${APPROVE_PASSWORD ? "set" : "not set — every approval comes back unauthorized"}`);
    }
  });
  return server;
}

if (require.main === module) start(PORT, { banner: true });

module.exports = { app, server, start, queue, jobs, jobsSnapshot, broadcastJobs };

// Graceful shutdown: stop accepting connections, tell every running review to
// terminate (which SIGTERMs its whole process group), then exit. Prevents the
// orphaned-claude-process problem on Ctrl-C / kill / service restart.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${sig} — stopping active reviews…`);
  let aborted = 0;
  for (const job of jobs.values()) {
    if (job.state === "running" && job.abort) {
      try {
        job.abort.abort();
        aborted++;
      } catch {}
    }
  }
  console.log(`  signalled ${aborted} running review(s); exiting shortly.`);
  try {
    server.close();
  } catch {}
  // Give children a moment to receive SIGTERM and unwind before we go.
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --- helpers ---

// Is a process with this PID currently alive (and ours to signal)?
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by someone else
  }
}

// Load persisted jobs into memory on boot so the UI shows history across
// restarts, and reconcile any job that was still "queued"/"running" when the
// previous server died: mark it "interrupted", and if its review process is
// somehow still alive (an orphan), signal its group to terminate.
function hydrateJobs() {
  let files;
  try {
    files = fs.readdirSync(JOBS_DIR);
  } catch {
    return;
  }
  let loaded = 0;
  let interrupted = 0;
  let reaped = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
    } catch {
      continue; // skip corrupt/partial files
    }
    if (!job || !job.id) continue;
    // Jobs created before provider support were all Claude runs.
    if (!job.provider) job.provider = "claude";

    if (job.state === "running" || job.state === "queued") {
      // A fresh boot means this can't still be true — the process that owned
      // it is gone. Reap a leftover orphan if one is still running.
      const agentPid = job.agentPid || job.claudePid;
      if (isAlive(agentPid)) {
        try {
          process.kill(-agentPid, "SIGTERM"); // negative = whole group
        } catch {
          try {
            process.kill(agentPid, "SIGTERM");
          } catch {}
        }
        reaped++;
      }
      job.state = "interrupted";
      job.interruptedAt = Date.now();
      job.claudePid = null;
      job.agentPid = null;
      if (!Array.isArray(job.events)) job.events = [];
      job.events.push({
        ts: Date.now(),
        kind: "interrupted",
        message: "Server restarted while this review was in progress.",
      });
      persistJob(job);
      interrupted++;
    }

    jobs.set(job.id, job);
    loaded++;
  }
  if (loaded) {
    console.log(
      `  restored ${loaded} past job(s)` +
        (interrupted ? `, ${interrupted} interrupted` : "") +
        (reaped ? `, ${reaped} orphan(s) reaped` : ""),
    );
  }
}

function sendSse(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
