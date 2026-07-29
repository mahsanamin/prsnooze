"use strict";

// Contract tests for the job-list WebSocket (/ws) that replaces the frontend's
// /api/jobs poll. Kept deliberately minimal: (1) a client gets a snapshot on
// connect, (2) a job state change broadcasts a fresh snapshot to it.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { once } = require("node:events");
const WebSocket = require("ws");

// Point prsnooze at a throwaway data dir BEFORE requiring the server, so
// hydrateJobs() starts from an empty state and nothing touches ~/.prsnooze.
process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-test-"));

const { start, queue, jobs } = require("../server");

let server;
let wsUrl;

test.before(async () => {
  server = start(0); // port 0 = ephemeral
  await once(server, "listening");
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
});

test.after(() => {
  try { server.close(); } catch {}
});

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
    });
    ws.once("error", reject);
  });
}

test("sends a job-list snapshot on connect", async () => {
  const ws = new WebSocket(wsUrl);
  const msg = await nextMessage(ws);
  assert.equal(msg.type, "snapshot");
  assert.ok(Array.isArray(msg.jobs), "snapshot.jobs is an array");
  assert.ok(msg.queue && typeof msg.queue.concurrency === "number", "snapshot.queue present");
  ws.close();
});

test("broadcasts an updated snapshot when a job's state changes", async () => {
  const ws = new WebSocket(wsUrl);
  await nextMessage(ws); // consume the connect snapshot
  const updated = nextMessage(ws); // arm the listener BEFORE triggering the change

  // Simulate a brand-new job transitioning to running (queue.on("state") is the
  // real broadcast trigger; a new job's initial "queued" flows the same way).
  jobs.set("test-job-1", {
    id: "test-job-1",
    prUrl: "https://example.com/pr/1",
    state: "queued",
    createdAt: Date.now(),
  });
  queue.emit("state", { jobId: "test-job-1", state: "running" });

  const msg = await updated;
  assert.equal(msg.type, "snapshot");
  const job = msg.jobs.find((j) => j.id === "test-job-1");
  assert.ok(job, "the changed job appears in the broadcast snapshot");
  assert.equal(job.state, "running");
  ws.close();
});
