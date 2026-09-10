"use strict";

const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { runClaude } = require("../claude-runner");
const { ensureWorkspaceTrusted } = require("../claude-trust");
const { getUsage: getClaudeUsage } = require("../claude-usage");
const { getModel: getClaudeModel } = require("../claude-model");
const { runCodex } = require("./codex");
const { getModel: getCodexModel } = require("./codex-model");

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
    getUsage: ({ bin, force = false }) => getClaudeUsage({ claudeBin: bin, force }),
    getModel: ({ bin, force = false }) => getClaudeModel({ claudeBin: bin, force }),
    dangerousCommand: "claude --dangerously-skip-permissions",
    installHint: "Install Claude Code (https://claude.com/claude-code) and ensure `claude --version` works.",
    // `claude auth status` is authoritative and prints JSON with a loggedIn
    // flag. This used to check only that ~/.claude/ existed, which still
    // passes once an OAuth session expires: preflight reported "Claude is
    // logged in" while every review died on "OAuth session expired and could
    // not be refreshed". A check that cannot fail is not a check.
    checkAuth: async ({ bin }) => {
      // `claude auth status` prints its JSON even when it exits non-zero, so
      // read stdout off the error too. That is how a service with no keychain
      // access reports itself: {"loggedIn": false, "authMethod": "none"}.
      let out = "";
      try {
        out = (await execFileP(bin, ["auth", "status"], { timeout: 15_000 })).stdout;
      } catch (e) {
        out = e?.stdout || "";
        if (!out) {
          const why = String(e?.stderr || e?.message || e).replace(/\s+/g, " ").trim().slice(0, 160);
          throw new Error(`could not run \`${bin} auth status\`: ${why || "no output"}`);
        }
      }

      let info = null;
      try {
        info = JSON.parse(out);
      } catch {}
      // Never report "ok" on an unconfirmed session. Every review needs this
      // auth, so a green tick here on a broken host is worse than no check:
      // it sends the host looking for the fault in prsnooze instead.
      if (!info) throw new Error(`\`${bin} auth status\` returned nothing usable, so auth is unconfirmed`);
      if (!info.loggedIn) {
        throw new Error(
          `claude reports authMethod "${info.authMethod || "none"}", so every review will fail. ` +
            `If \`claude auth status\` works in your own terminal but not here, this process cannot ` +
            `reach the login keychain, which is what happens under launchd or systemd. ` +
            `See "Keep it running" in the README.`,
        );
      }
      return [info.email, info.subscriptionType && `${info.subscriptionType} plan`]
        .filter(Boolean)
        .join(", ") || "logged in";
    },
    authHint:
      "Run `claude auth login` in a terminal. If that already works but this check does not, " +
      "the server cannot reach the keychain: see \"Keep it running\" in the README.",
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
    getModel: getCodexModel,
    dangerousCommand: "codex exec --dangerously-bypass-approvals-and-sandbox",
    installHint: "Install Codex CLI and ensure `codex --version` works.",
    checkAuth: async ({ bin }) => {
      const { stdout, stderr } = await execFileP(bin, ["login", "status"]);
      return (stdout || stderr).trim().split("\n")[0] || "ok";
    },
    authHint: "Run `codex login` once in a terminal to complete the login flow.",
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
  return getProviderVersionSync(provider) !== null;
}

function getProviderVersionSync(provider) {
  const result = spawnSync(provider.bin, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || "").trim().split("\n")[0] || "available";
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
  getProviderVersionSync,
  isProviderAvailable,
  isProviderAvailableSync,
  providerIds,
};
