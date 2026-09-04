"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeCodexEvent, runCodex, isRecognizedCodexEvent } = require("../lib/providers/codex");
const { getSessionModel, getModel } = require("../lib/providers/codex-model");

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

test("a Codex notice reaches the log instead of being dropped or alarming", () => {
  const state = { startedAt: Date.now(), numTurns: 0, finalText: "" };
  assert.deepEqual(
    normalizeCodexEvent({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: "Skill descriptions were shortened." },
    }, state),
    [{ kind: "log", message: "Codex notice: Skill descriptions were shortened." }],
  );
});

test("events Codex sends but the log has no use for stay quiet; unknown ones do not", () => {
  // turn.started drives the turn counter and shows nothing, so it must not
  // reach the browser as a raw-JSON `other` line.
  assert.equal(isRecognizedCodexEvent({ type: "turn.started" }), true);
  assert.equal(isRecognizedCodexEvent({ type: "item.completed", item: { type: "agent_message" } }), true);
  // A type this adapter has never seen must stay visible, so a Codex schema
  // change shows up instead of vanishing.
  assert.equal(isRecognizedCodexEvent({ type: "turn.interrupted" }), false);
  assert.equal(isRecognizedCodexEvent({ type: "item.completed", item: { type: "brand_new_item" } }), false);
});

function fakeCodexNoise(dir) {
  const bin = path.join(dir, "codex-noise");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' 'Reading additional input from stdin...' >&2
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-abc"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"shortened"}}'
printf '%s\\n' '{"type":"turn.interrupted"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("a clean Codex run produces no stderr warning and no raw-JSON noise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-codex-noise-"));
  const bin = fakeCodexNoise(dir);
  const events = await collectRun({ bin, cwd: dir, promptText: "review now" });

  // The empty-stdin notice is the CLI being chatty, not a problem to report.
  assert.deepEqual(events.filter((e) => e.kind === "stderr"), []);
  // turn.started is recognized and silent; only the genuinely unknown event
  // is allowed to surface as `other`.
  const other = events.filter((e) => e.kind === "other");
  assert.equal(other.length, 1);
  assert.equal(other[0].raw.type, "turn.interrupted");
  // The notice still reaches the log.
  assert.deepEqual(
    events.filter((e) => e.kind === "log"),
    [{ kind: "log", message: "Codex notice: shortened" }],
  );
});

test("the resolved model is read from Codex's own session record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-codex-model-"));
  const codexHome = path.join(dir, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "09", "04");
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, "rollout-2026-09-04-thread-abc.jsonl");
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-old" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-reviewer" } }),
    "",
  ].join("\n"));

  assert.equal(await getSessionModel({ sessionId: "thread-abc", codexHome }), "gpt-reviewer");

  const { bin } = fakeCodex(dir);
  const events = await collectRun({ bin, cwd: dir, codexHome, promptText: "review now" });
  assert.ok(events.some((event) =>
    event.kind === "system" && event.subtype === "model" && event.model === "gpt-reviewer"));
});

test("a rejected Codex model lookup cannot suppress the process exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-codex-model-failure-"));
  const { bin } = fakeCodex(dir);
  const events = await collectRun({
    bin,
    cwd: dir,
    promptText: "review now",
    sessionModelLookup: async () => { throw new Error("simulated rollout read failure"); },
  });

  assert.equal(events.filter((event) => event.kind === "result").length, 1);
  assert.equal(events.some((event) => event.subtype === "model"), false);
});

test("a stuck Codex model lookup is bounded and cannot hang the job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-codex-model-timeout-"));
  const { bin } = fakeCodex(dir);
  const startedAt = Date.now();
  await collectRun({
    bin,
    cwd: dir,
    promptText: "review now",
    sessionModelLookup: () => new Promise(() => {}),
    sessionModelTimeoutMs: 10,
  });

  assert.ok(Date.now() - startedAt < 1_000, "exit should not wait forever for model enrichment");
});

test("Codex model lookup reports explicit choices but does not invent a CLI default", async () => {
  assert.deepEqual(await getModel({ model: "gpt-explicit" }), {
    ok: true,
    name: "gpt-explicit",
    isDefault: false,
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-codex-doctor-"));
  const bin = path.join(dir, "codex-doctor");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' '{"checks":{"config.load":{"details":{"model":"<default>"}}}}'
`);
  fs.chmodSync(bin, 0o755);
  assert.deepEqual(await getModel({ bin }), { ok: false, reason: "cli-default-not-reported" });
});
