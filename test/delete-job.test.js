"use strict";

// Contract tests for DELETE /api/jobs/:id — the "remove from Recent sessions"
// action. Covers: a finished job goes from the list AND from disk, an active
// job is refused, an unknown id is a 404, and the removal reaches every
// connected browser over the job-list WebSocket.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { once } = require("node:events");
const WebSocket = require("ws");

// Throwaway data dir BEFORE requiring the server, so hydrateJobs() starts
// empty and nothing touches ~/.prsnooze.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-test-"));
process.env.PRSNOOZE_HOME = HOME;

const { start, jobs } = require("../server");

const JOBS_DIR = path.join(HOME, "outputs", "jobs");
let server;
let base;

test.before(async () => {
  server = start(0); // port 0 = ephemeral
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  try { server.close(); } catch {}
});

// Seed a job the way the server itself holds them, plus its on-disk record.
function seed(id, state) {
  const job = {
    id,
    prUrl: `https://github.com/owner/repo/pull/${id.replace(/\D/g, "") || "1"}`,
    state,
    createdAt: Date.now(),
    finishedAt: state === "failed" || state === "done" ? Date.now() : undefined,
    events: [],
  };
  jobs.set(id, job);
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(job));
  return job;
}

test("removes a finished job from the list and from disk", async () => {
  seed("del-finished", "failed");
  const file = path.join(JOBS_DIR, "del-finished.json");
  assert.ok(fs.existsSync(file), "seeded record is on disk");

  const r = await fetch(`${base}/api/jobs/del-finished`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: "del-finished" });

  assert.equal(jobs.has("del-finished"), false, "dropped from memory");
  assert.equal(fs.existsSync(file), false, "record deleted, so it stays gone across a restart");

  const list = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(list.jobs.find((j) => j.id === "del-finished"), undefined);
});

test("refuses to remove a queued or running job", async () => {
  for (const state of ["queued", "running"]) {
    seed(`del-active-${state}`, state);
    const r = await fetch(`${base}/api/jobs/del-active-${state}`, { method: "DELETE" });
    assert.equal(r.status, 409, `${state} is refused`);
    assert.match((await r.json()).error, /queued or running/);
    assert.ok(jobs.has(`del-active-${state}`), `${state} job is still there`);
    jobs.delete(`del-active-${state}`); // don't leak into the other tests
  }
});

test("404s on an unknown job id", async () => {
  const r = await fetch(`${base}/api/jobs/no-such-job`, { method: "DELETE" });
  assert.equal(r.status, 404);
});

test("broadcasts the removal to connected browsers", async () => {
  seed("del-broadcast", "done");
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  const first = await nextMessage(ws); // connect snapshot
  assert.ok(first.jobs.some((j) => j.id === "del-broadcast"), "present before removal");

  const updated = nextMessage(ws); // arm BEFORE triggering the change
  const r = await fetch(`${base}/api/jobs/del-broadcast`, { method: "DELETE" });
  assert.equal(r.status, 200);

  const msg = await updated;
  assert.equal(msg.type, "snapshot");
  assert.equal(msg.jobs.find((j) => j.id === "del-broadcast"), undefined, "gone from the pushed snapshot");
  assert.equal(msg.complete, true, "a full list is flagged complete, so the frontend may prune");
  ws.close();
});

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
    });
    ws.once("error", reject);
  });
}
