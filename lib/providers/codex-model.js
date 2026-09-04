"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

function resolveCodexHome(value = process.env.CODEX_HOME) {
  return path.resolve(value || path.join(os.homedir(), ".codex"));
}

async function findRolloutFile(sessionId, codexHome) {
  if (!sessionId) return null;
  const root = path.join(resolveCodexHome(codexHome), "sessions");
  const suffix = `${sessionId}.jsonl`;
  const pending = [root];

  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(suffix)) return full;
    }
  }
  return null;
}

// Codex's public JSONL stream identifies the thread but currently omits the
// model. Its own rollout records the resolved model in each turn_context, so
// read the newest one after the process exits. This is best-effort and silent:
// a missing or changed rollout format must never make a review fail.
async function getSessionModel({ sessionId, codexHome } = {}) {
  const file = await findRolloutFile(sessionId, codexHome);
  if (!file) return null;

  let model = null;
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"type":"turn_context"') || !line.includes('"model"')) continue;
      try {
        const event = JSON.parse(line);
        const candidate = event?.type === "turn_context" ? event.payload?.model : null;
        if (typeof candidate === "string" && candidate.trim()) model = candidate.trim();
      } catch {}
    }
  } catch {
    return null;
  }
  return model;
}

// The model chip can report an explicit CODEX_MODEL immediately. For an
// explicit model in config, `codex doctor --json` returns the resolved value.
// When the CLI says `<default>`, keep the chip hidden until a real run records
// the concrete model in its rollout instead of inventing one from the catalog.
async function getModel({ bin = "codex", model = null } = {}) {
  if (model) return { ok: true, name: model, isDefault: false };
  try {
    const { stdout } = await execFileP(bin, ["doctor", "--json"], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    const configured = report?.checks?.["config.load"]?.details?.model;
    if (typeof configured === "string" && configured.trim() && configured !== "<default>") {
      return { ok: true, name: configured.trim(), isDefault: false };
    }
    return { ok: false, reason: "cli-default-not-reported" };
  } catch (error) {
    return { ok: false, reason: "unavailable", detail: error.message };
  }
}

module.exports = { findRolloutFile, getSessionModel, getModel, resolveCodexHome };
