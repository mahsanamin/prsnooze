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
const { getUsage } = require("./lib/claude-usage");
const { getModel } = require("./lib/claude-model");
const { parsePrUrl, getSelfLogin, fetchPrState, fetchResumeSignals, assessResumability, resumeGate } = require("./lib/github");

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
const HERO_IMAGE = process.env.HERO_IMAGE || "/heroes/sleepy-cat.svg";
const AUTO_APPROVE = String(process.env.AUTO_APPROVE ?? "true") === "true";
const CONFIDENCE_THRESHOLD = parseInt(process.env.CONFIDENCE_THRESHOLD || "80", 10);
const SKIP_IF_ALREADY_REVIEWED = String(process.env.SKIP_IF_ALREADY_REVIEWED ?? "true") === "true";
// How many reviews run at once. Default 1 = sequential (one at a time, no
// concurrency). Set >1 to allow that many concurrent reviews.
const MAX_CONCURRENT_REVIEWS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_REVIEWS || "1", 10));
// Shared secret that gates privileged actions (approve). Set this on the host;
// whoever knows it can unlock approve in their own browser. Unset = approve
// disabled everywhere. Never sent to the client — only verified server-side.
const ADMIN_PASSWORD = process.env.PRSNOOZE_ADMIN_PASSWORD || "";
const PRIV_COOKIE = "prsnooze_priv";
const PRIV_TTL_MS = 60 * 60 * 1000; // stay unlocked for 1 hour

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
  if (event.kind === "claude_started") job.claudePid = event.pid || null;
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

// --- privileged-action gating (approve) -----------------------------------
// A browser proves it knows PRSNOOZE_ADMIN_PASSWORD by POSTing it once to
// /api/unlock; we hand back a signed, httpOnly cookie (a timestamp + HMAC, so
// there is no server-side session to lose on restart). Every privileged
// endpoint re-verifies that cookie independently. The raw password never
// travels to the client and is never stored there after unlock.
function signPriv(payload) {
  return crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("hex");
}
function makePrivToken() {
  const issued = String(Date.now());
  return `${issued}.${signPriv(issued)}`;
}
function verifyPrivToken(token) {
  if (!ADMIN_PASSWORD || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPriv(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const issued = parseInt(payload, 10);
  return Number.isFinite(issued) && Date.now() - issued < PRIV_TTL_MS;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
function isUnlocked(req) {
  return verifyPrivToken(parseCookies(req)[PRIV_COOKIE]);
}
// Constant-time password check (hash both sides so length isn't leaked).
function passwordMatches(input) {
  if (!ADMIN_PASSWORD || !input) return false;
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
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
    // Whether approve is gated at all (a password is set on the host), and
    // whether THIS browser is currently unlocked.
    passwordConfigured: !!ADMIN_PASSWORD,
    unlocked: isUnlocked(req),
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
  const data = await getUsage({ claudeBin: CLAUDE_BIN });
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

// Which model the reviews run on. prsnooze never passes --model, so this is
// whatever the host's claude CLI defaults to — see lib/claude-model.js. Read the
// same way as the plan meter (a local slash command, cached), and shown to
// everyone, because "which model reviewed my PR" is the first thing that
// explains why a review reads the way it does.
app.get("/api/model", async (_req, res) => {
  const data = await getModel({ claudeBin: CLAUDE_BIN });
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

// Prove knowledge of the admin password → set the privilege cookie.
// --- brute-force protection for the one password-gated endpoint ------------
// /api/unlock is the only place a secret is checked, and it gates posting an
// approval to GitHub as the host. Without a limit, anyone who can reach the page
// can try passwords as fast as the network allows — and the whole point of
// prsnooze is that the page is reachable by teammates.
//
// In-memory and per-IP: this is a single process on one machine, so there is no
// shared store to coordinate with. Note that behind a reverse proxy every
// request looks like it comes from the proxy unless `trust proxy` is set, in
// which case a single attacker can lock the endpoint for everyone. That is the
// deliberate trade: approve is a rare manual action, and the lockout expires.
const UNLOCK_MAX_FAILS = 5;              // consecutive failures before locking
const UNLOCK_BASE_LOCK_MS = 60_000;      // first lockout, doubling after that
const UNLOCK_MAX_LOCK_MS = 30 * 60_000;  // ceiling
const UNLOCK_FORGET_MS = 60 * 60_000;    // drop idle counters
const unlockAttempts = new Map(); // ip -> { fails, lockedUntil, seen }

function unlockThrottle(ip) {
  const now = Date.now();
  // Opportunistic prune so a stream of distinct IPs can't grow this forever.
  if (unlockAttempts.size > 1000) {
    for (const [k, v] of unlockAttempts) if (now - v.seen > UNLOCK_FORGET_MS) unlockAttempts.delete(k);
  }
  const rec = unlockAttempts.get(ip);
  if (!rec) return { blocked: false };
  if (now - rec.seen > UNLOCK_FORGET_MS) { unlockAttempts.delete(ip); return { blocked: false }; }
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { blocked: true, retryAfterMs: rec.lockedUntil - now };
  }
  return { blocked: false };
}

function unlockFailed(ip) {
  const now = Date.now();
  const rec = unlockAttempts.get(ip) || { fails: 0, lockedUntil: 0, seen: now };
  rec.fails += 1;
  rec.seen = now;
  if (rec.fails >= UNLOCK_MAX_FAILS) {
    const over = rec.fails - UNLOCK_MAX_FAILS;
    rec.lockedUntil = now + Math.min(UNLOCK_BASE_LOCK_MS * 2 ** over, UNLOCK_MAX_LOCK_MS);
  }
  unlockAttempts.set(ip, rec);
}

function unlockSucceeded(ip) {
  unlockAttempts.delete(ip);
}

app.post("/api/unlock", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(400).json({ error: "approving isn't available on this prsnooze yet" });
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const throttled = unlockThrottle(ip);
  if (throttled.blocked) {
    const secs = Math.ceil(throttled.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(secs));
    return res.status(429).json({ error: `too many attempts — try again in ${secs}s`, retryAfterMs: throttled.retryAfterMs });
  }
  const { password } = req.body || {};
  if (!passwordMatches(password)) {
    unlockFailed(ip);
    return res.status(401).json({ error: "incorrect password" });
  }
  unlockSucceeded(ip);
  // No Secure flag: must also work over http://localhost. Over the proxy it's
  // already HTTPS end-to-end.
  res.setHeader("Set-Cookie", `${PRIV_COOKIE}=${makePrivToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PRIV_TTL_MS / 1000}`);
  res.json({ ok: true, ttlMs: PRIV_TTL_MS });
});

// Re-lock this browser immediately.
app.post("/api/lock", (req, res) => {
  res.setHeader("Set-Cookie", `${PRIV_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post("/api/review", (req, res) => {
  const { prUrl } = req.body || {};
  if (!prUrl) return res.status(400).json({ error: "prUrl is required" });
  let parsed;
  try {
    parsed = parsePrUrl(prUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const id = uuidv4();
  const job = {
    id,
    prUrl: parsed.url,
    createdAt: Date.now(),
    state: "queued",
    phase: null,
    events: [],
  };
  jobs.set(id, job);
  persistJob(job);
  queue.enqueue(job);
  res.status(202).json({ jobId: id, prUrl: parsed.url });
});

// Coarse per-job shape for the list view (the WS snapshot and /api/jobs share
// this exactly, so REST and WebSocket never drift).
function jobListItem(j) {
  return {
    id: j.id,
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
// across a restart. Queued/running reviews are refused: their Claude session
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
// A review can be picked up where it left off: the Claude session id is on the
// job, and `claude --resume` continues that conversation instead of starting a
// fresh read of the PR. But resuming is only worth it under some conditions —
// the PR still open, not already approved, and something new to look at (the
// author pushed commits, or replied to the comments we left). This works out
// which case we're in so the UI can say so, and so a pointless run can be
// refused rather than silently costing a Claude session.
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
// for a review with no Claude session. Cached briefly: selecting a review asks,
// and clicking between reviews shouldn't mean a `gh` call per click.
//
// Failures are cached too, for much less time. A logged-out or timing-out `gh`
// is precisely the state where the client deliberately fails open and keeps the
// Approve button clickable — so every click used to spawn another `gh pr view`
// with a 20s timeout, from an endpoint that needs no password. A few seconds of
// "still broken" is a good enough answer.
const PR_STATE_TTL_MS = 30_000;
const PR_STATE_FAIL_TTL_MS = 5_000;
const prStateCache = new Map(); // prUrl -> { at, ttl, value }

// The cache is keyed by PR, not by browser, so anything that makes the stored
// answer wrong has to drop it for everyone.
function forgetPrState(prUrl) {
  prStateCache.delete(prUrl || "");
}

app.get("/api/jobs/:id/pr-state", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const key = job.prUrl || "";
  // ?refresh=1 is the client saying "the answer you gave me turned out to be
  // wrong" — an approval GitHub refused, most often. Serving the cached entry
  // there would hand back the exact state that was just disproved, and since
  // the refusal lands seconds after the entry was written, that is the common
  // path rather than the edge case.
  if (req.query.refresh === "1") forgetPrState(key);
  const hit = prStateCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return res.json(hit.value);
  const value = await fetchPrState(job.prUrl);
  if (prStateCache.size > 500) prStateCache.clear();
  prStateCache.set(key, { at: Date.now(), ttl: value.ok ? PR_STATE_TTL_MS : PR_STATE_FAIL_TTL_MS, value });
  res.json(value);
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

// Resume — re-run this job by RESUMING its original Claude session to
// check whether the author addressed the review's comments. No new session.
app.post("/api/jobs/:id/verify", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const sessionId = reviewSessionId(job);
  if (!sessionId) {
    return res.status(400).json({ error: "no Claude session recorded for this review — run a fresh review instead" });
  }
  if (isJobActive(job)) {
    return res.status(409).json({ error: "this review is already running" });
  }
  // Don't burn a Claude session on a PR that's already approved or untouched
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
  const gate = resumeGate({ assessment, forced: !!req.body?.force });
  if (!gate.allow) {
    return res.status(409).json({ error: gate.reason, assessment, forcible: gate.forcible });
  }
  job.resumeReason = gate.reason;
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
  res.json({ ok: true });
});

// Approve the PR — password-gated. The browser can't run `gh`, so the server
// shells out to it here, under the host's existing `gh` login (the same
// identity every review posts under — no token/env var for gh). The caller
// must hold a valid privilege cookie (see /api/unlock); otherwise 401.
app.post("/api/jobs/:id/approve", async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(403).json({ error: "approving isn't available on this prsnooze yet" });
  if (!isUnlocked(req)) return res.status(401).json({ error: "locked — enter the admin password to approve", locked: true });
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

function start(port = PORT) {
  // Restore past jobs from disk and reconcile anything left mid-flight by a
  // previous server that crashed or was restarted. Must run before we listen.
  hydrateJobs();
  wss = attachWebSocket(server);
  server.listen(port, "0.0.0.0", () => {
    const addr = server.address();
    console.log(`prsnooze listening on http://0.0.0.0:${addr.port}`);
    if (require.main === module) {
      console.log(`  data home: ${DATA_HOME}`);
      console.log(`  repos:     ${REPOS_DIR}`);
      console.log(`  worktrees: ${WORKTREES_DIR}`);
      console.log(`  outputs:   ${OUTPUTS_DIR}`);
      console.log(`  claude:    ${CLAUDE_BIN}`);
      console.log(`  keep wt on success: ${KEEP_WORKTREE_ON_SUCCESS}`);
      console.log(`  auto-approve clean PRs: ${AUTO_APPROVE}`);
      console.log(`  confidence threshold: ${CONFIDENCE_THRESHOLD}%`);
      console.log(`  skip if self-reviewed: ${SKIP_IF_ALREADY_REVIEWED}`);
      console.log(`  concurrent reviews: ${MAX_CONCURRENT_REVIEWS > 1 ? `up to ${MAX_CONCURRENT_REVIEWS}` : "off — one at a time"}`);
    }
  });
  return server;
}

if (require.main === module) start();

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

    if (job.state === "running" || job.state === "queued") {
      // A fresh boot means this can't still be true — the process that owned
      // it is gone. Reap a leftover orphan if one is still running.
      if (isAlive(job.claudePid)) {
        try {
          process.kill(-job.claudePid, "SIGTERM"); // negative = whole group
        } catch {
          try {
            process.kill(job.claudePid, "SIGTERM");
          } catch {}
        }
        reaped++;
      }
      job.state = "interrupted";
      job.interruptedAt = Date.now();
      job.claudePid = null;
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
