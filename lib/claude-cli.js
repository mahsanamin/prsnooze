"use strict";

// One way to ask the local claude CLI a question about itself.
//
// Two things the page reports — what's left of the plan, and which model the
// reviews run on — come from slash commands the CLI answers locally in print
// mode: zero turns, zero tokens, no model call, so asking costs nothing against
// the plan being reported. What they do cost is ~5s of CLI boot, and they're
// spawned by the server on behalf of whoever has the page open, so the rules are
// the same for both: ask from the host's home directory, close stdin, and never
// hang. That's this module.

const { spawn } = require("node:child_process");
const os = require("node:os");

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Run `claude -p <slashCommand>` and resolve with its stdout.
 *
 * Rejects on a non-zero exit, a spawn failure, or the timeout — the callers
 * turn that into a "we couldn't ask" payload rather than a crash.
 */
function runPrint(claudeBin, slashCommand, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // Home, not the server's checkout: these ask questions about the account
    // and its settings, so they have no business being pointed at a repo.
    const child = spawn(claudeBin, ["-p", slashCommand], {
      cwd: os.homedir(),
      env: process.env,
      // stdin closed, or the CLI waits 3s for input that will never come.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, new Error(`claude ${slashCommand} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      if (code === 0) return finish(resolve, out);
      finish(reject, new Error(`claude exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ""}`));
    });
  });
}

module.exports = { runPrint, CLI_TIMEOUT_MS: DEFAULT_TIMEOUT_MS };
