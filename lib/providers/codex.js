"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { buildPrompt } = require("../review-prompt");

function commandSummary(item) {
  const command = item.command || item.cmd || "";
  return {
    tool: "Bash",
    summary: String(command).slice(0, 240),
    full: { command: String(command) },
  };
}

function genericToolSummary(item) {
  const name = item.server && item.tool
    ? `${item.server}.${item.tool}`
    : item.type || "tool";
  let summary = "";
  try {
    summary = JSON.stringify(item.arguments || item.query || item).slice(0, 240);
  } catch {}
  return { tool: name, summary, full: item };
}

/**
 * Convert one Codex JSONL object into PR Snooze's stable provider event shape.
 * Keeping this translation inside the adapter means the queue and browser do
 * not need to know which CLI produced the event.
 */
function normalizeCodexEvent(obj, state = {}) {
  if (!obj || typeof obj !== "object") return [];
  const events = [];
  const type = obj.type;

  if (type === "thread.started") {
    state.sessionId = obj.thread_id || obj.threadId || state.sessionId || null;
    events.push({
      kind: "system",
      subtype: "init",
      sessionId: state.sessionId,
      model: obj.model || state.model || null,
      cwd: state.cwd || null,
    });
    return events;
  }

  if (type === "turn.started") {
    state.numTurns = (state.numTurns || 0) + 1;
    return events;
  }

  if (type === "item.started" || type === "item.completed") {
    const item = obj.item || {};
    const completed = type === "item.completed";

    if (item.type === "command_execution") {
      if (!completed) events.push({ kind: "tool_use", ...commandSummary(item) });
      else {
        const output = item.aggregated_output || item.output || item.stdout || "";
        events.push({
          kind: "tool_result",
          isError: item.status === "failed" || (Number.isInteger(item.exit_code) && item.exit_code !== 0),
          preview: String(output).slice(0, 400),
          length: String(output).length,
        });
      }
      return events;
    }

    if (completed && item.type === "agent_message" && typeof item.text === "string") {
      state.finalText = item.text;
      events.push({ kind: "assistant_text", text: item.text });
      return events;
    }

    if (!completed && ["mcp_tool_call", "web_search", "file_change"].includes(item.type)) {
      events.push({ kind: "tool_use", ...genericToolSummary(item) });
      return events;
    }

    if (completed && ["mcp_tool_call", "web_search", "file_change"].includes(item.type)) {
      const output = item.result || item.output || item.status || "completed";
      const preview = typeof output === "string" ? output : JSON.stringify(output);
      events.push({
        kind: "tool_result",
        isError: item.status === "failed",
        preview: preview.slice(0, 400),
        length: preview.length,
      });
      return events;
    }

    return events;
  }

  if (type === "turn.completed") {
    const usage = obj.usage || {};
    events.push({
      kind: "result",
      isError: false,
      result: state.finalText || "",
      durationMs: Date.now() - state.startedAt,
      totalCostUsd: undefined,
      numTurns: state.numTurns || 1,
      usage: {
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_output_tokens: usage.reasoning_output_tokens,
      },
      sessionId: state.sessionId || null,
    });
    return events;
  }

  if (type === "turn.failed" || type === "error") {
    const message = obj.error?.message || obj.message || "Codex run failed";
    events.push({ kind: "result", isError: true, result: message, sessionId: state.sessionId || null });
    return events;
  }

  return events;
}

function runCodex({
  prUrl,
  skill = null,
  approval = null,
  headSha,
  headRepoOwner,
  headRepoName,
  triviality,
  confidenceThreshold = 80,
  cwd,
  checkedOutSha = null,
  atPrHead = false,
  baseBranch = null,
  bin = "codex",
  model = null,
  resumeSessionId = null,
  promptText = null,
}) {
  const ee = new EventEmitter();
  const prompt = promptText || buildPrompt({
    prUrl,
    skill,
    approval,
    headSha,
    headRepoOwner,
    headRepoName,
    triviality,
    confidenceThreshold,
    checkedOutSha,
    atPrHead,
    baseBranch,
    permissionNotice: "You are running non-interactively with approval prompts and the sandbox bypassed. Execute the review end to end.",
  });

  const common = ["--json", "--dangerously-bypass-approvals-and-sandbox"];
  if (model) common.push("--model", model);
  const args = resumeSessionId
    ? ["exec", "resume", ...common, resumeSessionId, prompt]
    : ["exec", ...common, prompt];

  const child = spawn(bin, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  ee.pid = child.pid;
  ee.kill = (sig = "SIGTERM") => {
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch {} }
  };

  const state = {
    cwd,
    model,
    sessionId: resumeSessionId || null,
    finalText: "",
    numTurns: 0,
    startedAt: Date.now(),
  };
  let stdoutBuf = "";
  let stderrBuf = "";

  const handleLine = (line) => {
    let obj;
    try { obj = JSON.parse(line); }
    catch {
      ee.emit("event", { kind: "raw_unparseable", line });
      return;
    }
    const normalized = normalizeCodexEvent(obj, state);
    if (!normalized.length) ee.emit("event", { kind: "other", raw: obj });
    else for (const event of normalized) ee.emit("event", event);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
    ee.emit("event", { kind: "stderr", text: chunk });
  });
  child.on("error", (error) => ee.emit("error", error));
  child.on("close", (code, signal) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
    ee.emit("exit", { code, signal, stderrTail: stderrBuf.split("\n").slice(-50).join("\n") });
  });

  return ee;
}

module.exports = { runCodex, normalizeCodexEvent };
