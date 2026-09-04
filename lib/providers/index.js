"use strict";

const { execFile, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");
const { runClaude } = require("../claude-runner");
const { ensureWorkspaceTrusted } = require("../claude-trust");
const { getUsage: getClaudeUsage } = require("../claude-usage");
const { getModel: getClaudeModel } = require("../claude-model");
const { runCodex } = require("./codex");

const execFileP = promisify(execFile);

const DEFINITIONS = {
  claude: {
    id: "claude",
    label: "Claude",
    defaultBin: "claude",
    binEnv: "CLAUDE_BIN",
    modelEnv: null,
    run: (options) => runClaude({ ...options, claudeBin: options.bin }),
    prepareWorkspace: (dir, options) => ensureWorkspaceTrusted(dir, options),
    projectSkillDirs: [".claude/skills"],
    userSkillDirs: [".claude/skills"],
    getUsage: ({ bin }) => getClaudeUsage({ claudeBin: bin }),
    getModel: ({ bin }) => getClaudeModel({ claudeBin: bin }),
  },
  codex: {
    id: "codex",
    label: "Codex",
    defaultBin: "codex",
    binEnv: "CODEX_BIN",
    modelEnv: "CODEX_MODEL",
    run: runCodex,
    prepareWorkspace: async () => {},
    // Claude locations remain fallbacks so a host can use one established
    // review playbook with both providers during migration.
    projectSkillDirs: [".agents/skills", ".codex/skills", ".claude/skills"],
    userSkillDirs: [".agents/skills", ".codex/skills", ".claude/skills"],
    getUsage: null,
    getModel: async ({ model }) => model
      ? { ok: true, name: model, isDefault: false }
      : { ok: false, reason: "not-configured" },
  },
};

function createProvider(id, env = process.env) {
  const def = DEFINITIONS[id];
  if (!def) return null;
  return {
    ...def,
    bin: env[def.binEnv] || def.defaultBin,
    model: def.modelEnv ? env[def.modelEnv] || null : null,
  };
}

function providerIds(value = process.env.REVIEW_PROVIDERS) {
  const raw = value == null || value.trim() === "" ? Object.keys(DEFINITIONS) : value.split(",");
  return [...new Set(raw.map((id) => id.trim().toLowerCase()).filter((id) => DEFINITIONS[id]))];
}

async function isProviderAvailable(provider) {
  try {
    await execFileP(provider.bin, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isProviderAvailableSync(provider) {
  const result = spawnSync(provider.bin, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function discoverProvidersSync({ env = process.env, ids = providerIds(env.REVIEW_PROVIDERS) } = {}) {
  return ids
    .map((id) => createProvider(id, env))
    .filter((provider) => provider && isProviderAvailableSync(provider));
}

async function discoverProviders({ env = process.env, ids = providerIds(env.REVIEW_PROVIDERS) } = {}) {
  const providers = ids.map((id) => createProvider(id, env)).filter(Boolean);
  const available = await Promise.all(providers.map(async (provider) => ({
    provider,
    available: await isProviderAvailable(provider),
  })));
  return available.filter((entry) => entry.available).map((entry) => entry.provider);
}

function getProvider(id, { env = process.env } = {}) {
  return createProvider(id || "claude", env);
}

module.exports = {
  DEFINITIONS,
  createProvider,
  discoverProviders,
  discoverProvidersSync,
  getProvider,
  isProviderAvailable,
  isProviderAvailableSync,
  providerIds,
};
