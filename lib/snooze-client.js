"use strict";

const { tokenFor } = require("./snooze-config");

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * One request to a peer instance's remote API.
 *
 * Every failure is turned into an Error carrying `status` and `code` so callers
 * can tell "this peer said no" from "this peer is unreachable". A CLI that
 * printed the same message for a sleeping laptop and a wrong token would be
 * useless for the thing this exists for: deciding who can take a review.
 */
async function request(peer, config, method, routePath, { body = null, timeoutMs = DEFAULT_TIMEOUT_MS, query = null } = {}) {
  const token = tokenFor(config, peer);
  if (!token) {
    const err = new Error(
      "no token for this peer; run `snooze token <shared-token>` or `snooze add <url> --token <token>`",
    );
    err.code = "NO_TOKEN";
    throw err;
  }

  const url = new URL(`${peer.url}/api/remote${routePath}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === "AbortError"
        ? `no answer within ${Math.round(timeoutMs / 1000)}s (asleep, or not listening)`
        : `unreachable: ${e.message}`,
    );
    err.code = e.name === "AbortError" ? "TIMEOUT" : "UNREACHABLE";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const err = new Error(payload?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = payload?.code || null;
    err.assessment = payload?.assessment;
    err.forcible = payload?.forcible;
    throw err;
  }
  return payload;
}

const getStatus = (peer, config, { usage = false } = {}) =>
  request(peer, config, "GET", "/status", { query: usage ? { usage: 1 } : null });

const postReview = (peer, config, { prUrl, provider = null }) =>
  request(peer, config, "POST", "/review", { body: { prUrl, provider } });

const getJob = (peer, config, jobId) =>
  request(peer, config, "GET", `/jobs/${encodeURIComponent(jobId)}`);

const postResume = (peer, config, jobId, { force = false } = {}) =>
  request(peer, config, "POST", `/jobs/${encodeURIComponent(jobId)}/resume`, { body: { force } });

module.exports = { request, getStatus, postReview, getJob, postResume, DEFAULT_TIMEOUT_MS };
