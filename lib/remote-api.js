"use strict";

const crypto = require("node:crypto");
const express = require("express");

const { shortId } = require("./instance-identity");

/**
 * Compare two secrets without leaking their length or contents through timing.
 *
 * timingSafeEqual throws on a length mismatch, which would itself be a timing
 * signal, so both sides are hashed to a fixed width first.
 */
function secretsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function presentedToken(req) {
  const header = req.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const direct = req.get("x-prsnooze-token");
  return direct ? String(direct).trim() : "";
}

function createAttemptLimiter({
  maxFails = 5,
  baseLockMs = 60_000,
  maxLockMs = 30 * 60_000,
  forgetMs = 60 * 60_000,
  now = () => Date.now(),
} = {}) {
  const attempts = new Map();

  function check(key) {
    const current = now();
    if (attempts.size > 1000) {
      for (const [candidate, record] of attempts) {
        if (current - record.seen > forgetMs) attempts.delete(candidate);
      }
    }
    const record = attempts.get(key);
    if (!record) return { blocked: false };
    if (current - record.seen > forgetMs) {
      attempts.delete(key);
      return { blocked: false };
    }
    if (record.lockedUntil > current) {
      return { blocked: true, retryAfterMs: record.lockedUntil - current };
    }
    return { blocked: false };
  }

  function failed(key) {
    const current = now();
    const record = attempts.get(key) || { fails: 0, lockedUntil: 0, seen: current };
    record.fails += 1;
    record.seen = current;
    if (record.fails >= maxFails) {
      const over = record.fails - maxFails;
      record.lockedUntil = current + Math.min(baseLockMs * 2 ** over, maxLockMs);
    }
    attempts.set(key, record);
  }

  return { check, failed, succeeded: (key) => attempts.delete(key) };
}

function requesterRecord(value, address) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200) || "unspecified";
  return { label, address: String(address || "unknown").slice(0, 200) };
}

/**
 * The cross-instance API: everything a `snooze` CLI on another machine needs.
 *
 * Deliberately a separate namespace rather than auth bolted onto the existing
 * routes. The browser page is documented as shareable over a LAN or Tailscale
 * with no credential, and gating the routes it already calls would break that.
 * Remote CONTROL is the new capability, so it gets the new, guarded surface.
 *
 * With no token configured every route answers 503. A remote API that silently
 * ran wide open would be the worst outcome here: reaching one of these routes
 * spends the host's provider plan and posts a review under their GitHub
 * identity, so it stays off until someone opts in.
 */
function createRemoteRouter({
  token = null,
  identity,
  describe,
  submitReview,
  describeJob,
  resumeReview,
  authLimiter = createAttemptLimiter(),
} = {}) {
  const router = express.Router();
  const enabled = typeof token === "string" && token.trim().length > 0;

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!enabled) {
      return res.status(503).json({
        error:
          "the remote API is disabled on this instance; the host must set PRSNOOZE_REMOTE_TOKEN to enable it",
        code: "REMOTE_DISABLED",
      });
    }
    const source = req.ip || req.socket?.remoteAddress || "unknown";
    const throttle = authLimiter.check(source);
    if (throttle.blocked) {
      res.set("Retry-After", String(Math.max(1, Math.ceil(throttle.retryAfterMs / 1000))));
      return res.status(429).json({ error: "too many authentication attempts", code: "RATE_LIMITED" });
    }
    if (!secretsMatch(presentedToken(req), token.trim())) {
      authLimiter.failed(source);
      // No detail about what was wrong, and the same answer for a missing and a
      // wrong token, matching how the approve password is handled.
      return res.status(401).json({ error: "unauthorized", code: "UNAUTHORIZED" });
    }
    authLimiter.succeeded(source);
    next();
  });

  // Authentication deliberately runs before parsing a caller-controlled body.
  // An invalid token should be cheap and get the same answer even when its JSON
  // is malformed or oversized.
  router.use(express.json({ limit: "1mb" }));

  // Who am I, and can I take work right now. This is what `snooze status`
  // renders, so it carries the slot arithmetic already rather than making every
  // client recompute it.
  router.get("/status", async (req, res) => {
    // Plan usage costs a provider-CLI round trip, so a client asks for it
    // explicitly rather than every `snooze status` paying for it.
    const includeUsage = ["1", "true", "yes"].includes(String(req.query.usage || "").toLowerCase());
    try {
      const detail = await describe({ includeUsage });
      res.json({
        instance: {
          id: identity.id,
          shortId: shortId(identity.id),
          name: identity.name,
        },
        ...detail,
      });
    } catch (e) {
      res.status(500).json({ error: `could not read instance status: ${e.message}` });
    }
  });

  router.post("/review", async (req, res) => {
    const { prUrl, provider, requester } = req.body || {};
    const requestedBy = requesterRecord(requester, req.ip || req.socket?.remoteAddress);
    try {
      const result = await submitReview({ prUrl, provider, requestedBy });
      res.status(202).json({
        ...result,
        requestedBy,
        ref: `${shortId(identity.id)}/${result.jobId}`,
        instance: { id: identity.id, shortId: shortId(identity.id), name: identity.name },
      });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
    }
  });

  router.get("/jobs/:id", (req, res) => {
    const job = describeJob(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    res.json({ ...job, ref: `${shortId(identity.id)}/${job.id}` });
  });

  // Resume goes through the same gate the browser uses, so a pointless run is
  // refused here too and `force` means exactly what it means in the UI.
  router.post("/jobs/:id/resume", async (req, res) => {
    const requestedBy = requesterRecord(req.body?.requester, req.ip || req.socket?.remoteAddress);
    try {
      const result = await resumeReview(req.params.id, {
        force: !!req.body?.force,
        requestedBy,
      });
      res.json({ ...result, requestedBy });
    } catch (e) {
      res.status(e.status || 400).json({
        error: e.message,
        code: e.code,
        assessment: e.assessment,
        forcible: e.forcible,
      });
    }
  });

  return router;
}

module.exports = {
  createRemoteRouter,
  createAttemptLimiter,
  requesterRecord,
  secretsMatch,
  presentedToken,
};
