"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { resolveJobProvider, runProviderProcess } = require("../lib/review-job");
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

// Reproduces a real failure. A colleague's review died with claude reporting
// "Failed to authenticate: OAuth session expired and could not be refreshed",
// and the host was shown "Claude exited with code=1 ... Last stderr: (empty)".
// The provider had said exactly what was wrong; the failure message dropped it.
function fakeFailingClaude(dir, { message }) {
  const bin = path.join(dir, "claude-authfail");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"${message}"}]}}'
printf '%s\\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1}'
exit 1
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("Claude auth failure text is normalized from its JSONL stream", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-authfail-"));
  const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
  const bin = fakeFailingClaude(dir, { message });

  // Drive the provider seam directly: the lifecycle around it needs a repo, a
  // worktree and GitHub, none of which this failure depends on.
  const { runClaude } = require("../lib/claude-runner");
  const events = [];
  const ee = runClaude({ claudeBin: bin, cwd: dir, promptText: "x" });
  ee.on("event", (e) => events.push(e));
  const exit = await new Promise((resolve) => ee.on("exit", resolve));

  assert.equal(exit.code, 1);
  assert.equal((exit.stderrTail || "").trim(), "", "stderr is empty, as it was in the real failure");
  // The reason has to be somewhere the failure message can find it.
  const text = events.find((e) => e.kind === "assistant_text")?.text;
  assert.equal(text, message);
  assert.ok(
    events.some((e) => e.kind === "result" && e.isError),
    "the provider reported an error result",
  );
});

test("a provider's explanation reaches the final non-zero job error", async () => {
  const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
  const provider = {
    id: "claude",
    label: "Claude",
    bin: "unused",
    model: null,
    run: () => {
      const ee = new EventEmitter();
      ee.pid = 123;
      ee.kill = () => {};
      process.nextTick(() => {
        ee.emit("event", { kind: "assistant_text", text: message });
        ee.emit("event", { kind: "result", isError: true });
        ee.emit("exit", { code: 1, signal: null, stderrTail: "" });
      });
      return ee;
    },
  };

  await assert.rejects(
    () => runProviderProcess({
      provider,
      job: {},
      helpers: { emit: () => {} },
      options: {},
      log: () => {},
    }),
    (error) => {
      assert.equal(error.code, "CLAUDE_NONZERO");
      assert.match(error.message, new RegExp(message));
      assert.match(error.message, /Last stderr:\n\(empty\)/);
      return true;
    },
  );
});
