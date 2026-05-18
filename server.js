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
  if (event.kind === "summary") job.summary = event;
  if (event.kind === "failed") job.error = event.error;
  for (const res of subscribers.get(jobId) || []) {
    sendSse(res, event);
  }
  // Throttle persistence: write on coarse changes only
  if (
    event.kind === "queued" ||
    event.kind === "started" ||
    event.kind === "phase" ||
    event.kind === "done" ||
    event.kind === "failed" ||
    event.kind === "summary"
  ) {
    persistJob(job);
  }
}

const queue = new Queue((job, helpers) =>
  runReviewJob(job, helpers, {
    reposDir: REPOS_DIR,
    worktreesDir: WORKTREES_DIR,
    claudeBin: CLAUDE_BIN,
    keepWorktreeOnSuccess: KEEP_WORKTREE_ON_SUCCESS,
  }),
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`prsnooze listening on http://0.0.0.0:${PORT}`);
  console.log(`  data home: ${DATA_HOME}`);
  console.log(`  repos:     ${REPOS_DIR}`);
  console.log(`  worktrees: ${WORKTREES_DIR}`);
  console.log(`  outputs:   ${OUTPUTS_DIR}`);
  console.log(`  claude:    ${CLAUDE_BIN}`);
  console.log(`  keep wt on success: ${KEEP_WORKTREE_ON_SUCCESS}`);
});

// --- helpers ---
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
