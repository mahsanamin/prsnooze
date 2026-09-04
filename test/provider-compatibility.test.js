"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveJobProvider } = require("../lib/review-job");
const { runClaude, isSilentClaudeEvent } = require("../lib/claude-runner");

test("a providerless legacy job remains Claude when Codex is the current default", () => {
  const claude = { id: "claude", label: "Claude" };
  const codex = { id: "codex", label: "Codex" };
  const job = { sessionId: "old-claude-session" };

  const resolved = resolveJobProvider(job, {
    defaultProvider: "codex",
    providers: new Map([["claude", claude], ["codex", codex]]),
  });

  assert.equal(resolved, claude);
  assert.equal(job.provider, "claude");
});

test("an explicitly stamped job keeps its provider", () => {
  const claude = { id: "claude", label: "Claude" };
  const codex = { id: "codex", label: "Codex" };
  const job = { provider: "codex", sessionId: "codex-thread" };

  assert.equal(resolveJobProvider(job, {
    defaultProvider: "claude",
    providers: new Map([["claude", claude], ["codex", codex]]),
  }), codex);
});

function collectClaude(options) {
  return new Promise((resolve, reject) => {
    const events = [];
    const run = runClaude(options);
    run.on("event", (event) => events.push(event));
    run.on("error", reject);
    run.on("exit", ({ code }) => code === 0 ? resolve(events) : reject(new Error(`exit ${code}`)));
  });
}

test("Claude rate-limit telemetry stays quiet while unknown events remain visible", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-claude-events-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-session","model":"opus"}'
printf '%s\\n' '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour"}}'
printf '%s\\n' '{"type":"assistant"}'
printf '%s\\n' '{"type":"user"}'
printf '%s\\n' '{"type":"future_event","value":1}'
printf '%s\\n' '{"type":"result","is_error":false,"result":"done","session_id":"claude-session"}'
`);
  fs.chmodSync(bin, 0o755);

  const events = await collectClaude({ claudeBin: bin, cwd: dir, promptText: "review" });
  assert.equal(isSilentClaudeEvent({ type: "rate_limit_event" }), true);
  assert.equal(isSilentClaudeEvent({ type: "assistant" }), false);
  assert.equal(isSilentClaudeEvent({ type: "user" }), false);
  assert.equal(isSilentClaudeEvent({ type: "future_event" }), false);
  assert.deepEqual(events.filter((event) => event.kind === "other"), [
    { kind: "other", raw: { type: "assistant" } },
    { kind: "other", raw: { type: "user" } },
    { kind: "other", raw: { type: "future_event", value: 1 } },
  ]);
});
