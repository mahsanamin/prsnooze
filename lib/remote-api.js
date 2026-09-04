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
    if (!secretsMatch(presentedToken(req), token.trim())) {
      // No detail about what was wrong, and the same answer for a missing and a
      // wrong token, matching how the approve password is handled.
      return res.status(401).json({ error: "unauthorized", code: "UNAUTHORIZED" });
    }
    next();
  });

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
    const { prUrl, provider } = req.body || {};
    try {
      const result = await submitReview({ prUrl, provider });
      res.status(202).json({
        ...result,
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
    try {
      const result = await resumeReview(req.params.id, { force: !!req.body?.force });
      res.json(result);
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

module.exports = { createRemoteRouter, secretsMatch, presentedToken };
