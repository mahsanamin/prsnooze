const { EventEmitter } = require("node:events");

/**
 * In-memory FIFO queue with a configurable number of async workers.
 *
 * runner: async (job, helpers) => void
 *   helpers.emit(event)  — broadcast an event for this job
 *   helpers.signal       — AbortSignal that fires if the job is cancelled
 *
 * concurrency: how many jobs may run at once (default 1). The queue never
 * runs more than this many runners concurrently; extra jobs wait in `pending`.
 *
 * Events on the queue's EventEmitter:
 *   "job"   -> { jobId, event }     for every emitted event from runner / queue
 *   "state" -> { jobId, state }     coarse state changes (queued/running/done/failed)
 */
class Queue extends EventEmitter {
  constructor(runner, { concurrency = 1 } = {}) {
    super();
    this.runner = runner;
    this.concurrency = Math.max(1, concurrency | 0);
    this.pending = [];
    this.active = new Map(); // jobId -> job (currently running)
  }

  enqueue(job) {
    this.pending.push(job);
    this.emit("state", { jobId: job.id, state: "queued", position: this.pending.length });
    this.emit("job", {
      jobId: job.id,
      event: { kind: "queued", position: this.pending.length, ts: Date.now() },
    });
    setImmediate(() => this._drain());
    return job;
  }

  // Fill open worker slots with pending jobs.
  _drain() {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      // Fire and forget — _runJob manages its own lifecycle and re-drains.
      this._runJob(job);
    }
  }

  async _runJob(job) {
    this.active.set(job.id, job);

    const ac = new AbortController();
    job.abort = ac;
    const helpers = {
      emit: (event) => this.emit("job", { jobId: job.id, event: { ts: Date.now(), ...event } }),
      signal: ac.signal,
    };

    this.emit("state", { jobId: job.id, state: "running" });
    helpers.emit({ kind: "started" });

    try {
      await this.runner(job, helpers);
      this.emit("state", { jobId: job.id, state: "done" });
      helpers.emit({ kind: "done" });
    } catch (e) {
      this.emit("state", { jobId: job.id, state: "failed" });
      helpers.emit({ kind: "failed", error: e.message, code: e.code });
    } finally {
      this.active.delete(job.id);
      setImmediate(() => this._drain());
    }
  }

  status() {
    const runningJobIds = Array.from(this.active.keys());
    return {
      runningJobIds,
      // Back-compat for the current single-view UI (updated in the tabbed pass).
      runningJobId: runningJobIds[0] || null,
      running: runningJobIds.length,
      concurrency: this.concurrency,
      pending: this.pending.map((j) => j.id),
    };
  }
}

module.exports = { Queue };
