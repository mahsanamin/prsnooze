/**
 * Per-key async serialization.
 *
 * prsnooze runs reviews concurrently, but all jobs for the SAME repo share one
 * git clone. Running `git fetch` / `git worktree add` / `worktree prune` on
 * that clone at the same instant races on `.git` locks and fails intermittently.
 *
 * withRepoLock(key, fn) guarantees that, for a given key (repo), the wrapped
 * functions run strictly one-at-a-time in call order. DIFFERENT keys run fully
 * concurrently — so cross-repo reviews never wait on each other.
 *
 * This is the "take turns on the download step, per repo" rule: only the quick
 * git plumbing serializes; the long review that follows runs in parallel.
 */

// key -> promise that settles when the last-queued holder for this key finishes.
const tails = new Map();
// key -> number of holders currently queued or running (for a "will I wait?" hint).
const holders = new Map();

/**
 * Run `fn` once every previously-queued task for `key` has settled.
 * Returns fn's result (or rejection) to the caller unchanged.
 */
function withRepoLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  holders.set(key, (holders.get(key) || 0) + 1);

  // Chain after `prev` regardless of how prev settled, so one failure doesn't
  // wedge the queue for the next waiter.
  const run = prev.then(() => fn(), () => fn());

  // The tail never rejects (waiters only care that the slot is free).
  const tail = run
    .catch(() => {})
    .finally(() => {
      const n = (holders.get(key) || 1) - 1;
      if (n <= 0) holders.delete(key);
      else holders.set(key, n);
      // Only clear the tail if we're still the latest one registered.
      if (tails.get(key) === tail) tails.delete(key);
    });

  tails.set(key, tail);
  return run;
}

/** True if another holder currently owns or is waiting on this key. */
function repoLockBusy(key) {
  return (holders.get(key) || 0) > 0;
}

module.exports = { withRepoLock, repoLockBusy };
