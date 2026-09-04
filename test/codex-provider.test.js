"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeCodexEvent, runCodex } = require("../lib/providers/codex");

test("Codex JSONL is normalized into the existing live event contract", () => {
  const state = { startedAt: Date.now() - 10, cwd: "/tmp/repo", numTurns: 0, finalText: "" };

  assert.deepEqual(
    normalizeCodexEvent({ type: "thread.started", thread_id: "thread-123" }, state),
    [{ kind: "system", subtype: "init", sessionId: "thread-123", model: null, cwd: "/tmp/repo" }],
  );
  assert.deepEqual(normalizeCodexEvent({ type: "turn.started" }, state), []);
  assert.deepEqual(
    normalizeCodexEvent({
      type: "item.started",
      item: { type: "command_execution", command: "gh pr review 12 --approve" },
    }, state),
    [{
      kind: "tool_use",
      tool: "Bash",
      summary: "gh pr review 12 --approve",
      full: { command: "gh pr review 12 --approve" },
    }],
  );
  assert.deepEqual(
    normalizeCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "APPROVAL: approve - score=0" },
    }, state),
    [{ kind: "assistant_text", text: "APPROVAL: approve - score=0" }],
  );
  const [result] = normalizeCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 },
  }, state);
  assert.equal(result.kind, "result");
  assert.equal(result.result, "APPROVAL: approve - score=0");
  assert.equal(result.sessionId, "thread-123");
  assert.equal(result.numTurns, 1);
  assert.equal(result.usage.input_tokens, 100);
});

function fakeCodex(dir) {
  const bin = path.join(dir, "codex");
  const argsFile = path.join(dir, "args.txt");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-abc"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
`);
  fs.chmodSync(bin, 0o755);
  return { bin, argsFile };
}

function collectRun(options) {
  return new Promise((resolve, reject) => {
    const events = [];
    const run = runCodex(options);
    run.on("event", (event) => events.push(event));
    run.on("error", reject);
    run.on("exit", ({ code }) => code === 0 ? resolve(events) : reject(new Error(`exit ${code}`)));
  });
}

test("Codex fresh and resumed runs use the non-interactive JSON interface", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-codex-"));
  const { bin, argsFile } = fakeCodex(dir);

  const freshEvents = await collectRun({ bin, cwd: dir, promptText: "review now" });
  let args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(args.at(-1), "review now");
  assert.equal(freshEvents.find((event) => event.kind === "result").sessionId, "thread-abc");

  await collectRun({ bin, cwd: dir, promptText: "verify fixes", resumeSessionId: "thread-abc" });
  args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.ok(args.includes("thread-abc"));
  assert.equal(args.at(-1), "verify fixes");
});
