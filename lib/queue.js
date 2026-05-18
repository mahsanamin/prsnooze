const { EventEmitter } = require("node:events");

/**
 * In-memory FIFO queue with a single async worker.
 *
 * runner: async (job, helpers) => void
 *   helpers.emit(event)  — broadcast an event for this job
 *   helpers.signal       — AbortSignal that fires if the job is cancelled
 *
 * Events on the queue's EventEmitter:
 *   "job"   -> { jobId, event }     for every emitted event from runner / queue
 *   "state" -> { jobId, state }     coarse state changes (queued/running/done/failed)
 */
class Queue extends EventEmitter {
  constructor(runner) {
    super();
    this.runner = runner;
    this.pending = [];
    this.running = null;
    this.busy = false;
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

  async _drain() {
    if (this.busy) return;
    const job = this.pending.shift();
    if (!job) return;
    this.busy = true;
    this.running = job;

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
      this.busy = false;
      this.running = null;
      setImmediate(() => this._drain());
    }
  }

  status() {
    return {
      runningJobId: this.running?.id || null,
      pending: this.pending.map((j) => j.id),
    };
  }
}

module.exports = { Queue };
