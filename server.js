const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const express = require("express");
const { v4: uuidv4 } = require("uuid");

const { Queue } = require("./lib/queue");
const { runReviewJob } = require("./lib/review-job");
const { parsePrUrl } = require("./lib/github");

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
const AUTO_APPROVE_MAX_LINES = parseInt(process.env.AUTO_APPROVE_MAX_LINES || "100", 10);
const AUTO_APPROVE_MAX_FILES = parseInt(process.env.AUTO_APPROVE_MAX_FILES || "5", 10);
const CONFIDENCE_THRESHOLD = parseInt(process.env.CONFIDENCE_THRESHOLD || "80", 10);
const SKIP_IF_ALREADY_REVIEWED = String(process.env.SKIP_IF_ALREADY_REVIEWED ?? "true") === "true";
const MAX_CONCURRENT_REVIEWS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_REVIEWS || "1", 10));

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
  if (event.kind === "summary") job.summary = event;
  if (event.kind === "failed") job.error = event.error;
  if (event.kind === "outcome_detected") job.outcome = event.outcome;
  if (event.kind === "skipped") {
    job.skipped = true;
    job.skipReason = event.reason;
    job.outcome = event.outcome || null;
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
  (job, helpers) =>
    runReviewJob(job, helpers, {
      reposDir: REPOS_DIR,
      worktreesDir: WORKTREES_DIR,
      claudeBin: CLAUDE_BIN,
      keepWorktreeOnSuccess: KEEP_WORKTREE_ON_SUCCESS,
      autoApprove: AUTO_APPROVE,
      autoApproveMaxLines: AUTO_APPROVE_MAX_LINES,
      autoApproveMaxFiles: AUTO_APPROVE_MAX_FILES,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      skipIfAlreadyReviewed: SKIP_IF_ALREADY_REVIEWED,
    }),
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
});

// --- HTTP ---
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    heroImage: HERO_IMAGE,
    brand: "prsnooze",
  });
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

app.get("/api/jobs", (_req, res) => {
  const list = Array.from(jobs.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 50)
    .map((j) => ({
      id: j.id,
      prUrl: j.prUrl,
      state: j.state,
      phase: j.phase,
      outcome: j.outcome || null,         // "approved" | "commented" | "changes_requested" | null
      skipped: !!j.skipped,
      skipReason: j.skipReason || null,
      title: j.prMeta?.title,
      number: j.prMeta?.number,
      nameWithOwner: j.prMeta?.nameWithOwner,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      error: j.error,
    }));
  res.json({ jobs: list, queue: queue.status() });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
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

// Restore past jobs from disk and reconcile anything left mid-flight by a
// previous server that crashed or was restarted. Must run before we listen.
hydrateJobs();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`prsnooze listening on http://0.0.0.0:${PORT}`);
  console.log(`  data home: ${DATA_HOME}`);
  console.log(`  repos:     ${REPOS_DIR}`);
  console.log(`  worktrees: ${WORKTREES_DIR}`);
  console.log(`  outputs:   ${OUTPUTS_DIR}`);
  console.log(`  claude:    ${CLAUDE_BIN}`);
  console.log(`  keep wt on success: ${KEEP_WORKTREE_ON_SUCCESS}`);
  console.log(`  auto-approve clean PRs: ${AUTO_APPROVE} (size cap: ≤${AUTO_APPROVE_MAX_LINES} lines / ≤${AUTO_APPROVE_MAX_FILES} files)`);
  console.log(`  confidence threshold: ${CONFIDENCE_THRESHOLD}%`);
  console.log(`  skip if self-reviewed: ${SKIP_IF_ALREADY_REVIEWED}`);
  console.log(`  max concurrent reviews: ${MAX_CONCURRENT_REVIEWS}`);
});

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
