#!/usr/bin/env node
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  orange: "\x1b[38;5;208m",
};

function banner() {
  process.stdout.write(`
${c.orange}${c.bold}     👀  prsnooze${c.reset}  ${c.dim}— PR reviews that happen while you sleep${c.reset}

`);
}

function warning() {
  process.stdout.write(
    `${c.yellow}${c.bold}⚠️  WARNING — read this before exposing the URL ⚠️${c.reset}\n` +
      `  prsnooze runs ${c.bold}claude --dangerously-skip-permissions${c.reset}. Claude\n` +
      `  has full file/network/tool access in the worktree without\n` +
      `  confirmation prompts.\n\n` +
      `  - Anyone who can reach the URL can trigger a Claude session.\n` +
      `  - Use a ${c.bold}fine-grained GitHub PAT${c.reset} scoped to read PRs and write\n` +
      `    review comments on the repos you actually want reviewed. Avoid\n` +
      `    classic "all-repos admin" tokens.\n` +
      `  - Do NOT expose to the public internet without auth (LAN/Tailscale).\n` +
      `  - Run on a machine you don't mind seeing networked actions from.\n\n` +
      `  ${c.bold}Use at your own risk.${c.reset}\n\n`,
  );
}

const args = new Set(process.argv.slice(2));
const FLAG_HELP = args.has("-h") || args.has("--help");
const FLAG_CHECK = args.has("--check");
const FLAG_NO_CHECK = args.has("--no-check");
// Run the checks, report what failed, start anyway. This is what the
// background and supervised starts use (bin/prsnooze-service, launchd,
// systemd): at boot there is nobody reading the terminal, and refusing to
// start over a check that needs the network would leave the team with no
// prsnooze until someone noticed.
const FLAG_CHECK_WARN = args.has("--check-warn");

if (FLAG_HELP) {
  console.log(`Usage: npm start [-- --check | --check-warn | --no-check]

  (no args)     Run preflight checks and start the server.
  --check       Run preflight checks only and exit (don't start server).
  --check-warn  Run preflight checks, report failures, start anyway.
  --no-check    Skip preflight checks and start anyway.
  -h, --help    Show this help.

To keep it running in the background, and after a reboot, use
bin/prsnooze-service instead (start / stop / restart / status / install).
`);
  process.exit(0);
}

(async () => {
  banner();
  await ensureEnvFile();
  if (!FLAG_CHECK) await guardSecondInstance();
  warning();

  if (!FLAG_NO_CHECK) {
    const ok = await runPreflight();
    if (!ok && !FLAG_CHECK_WARN) {
      console.log(
        `\n${c.red}${c.bold}preflight failed.${c.reset} Fix the issues above, then re-run.\n` +
          `${c.dim}You can also run \`npm start -- --no-check\` to skip these checks (not recommended).${c.reset}\n`,
      );
      process.exit(1);
    }
    if (!ok) {
      console.log(
        `\n${c.yellow}${c.bold}preflight failed, starting anyway${c.reset} ${c.dim}(--check-warn).${c.reset}\n` +
          `${c.dim}Reviews that need the failing piece will fail until it's fixed.${c.reset}\n`,
      );
    }
    if (FLAG_CHECK) {
      console.log(`\n${c.green}all checks passed.${c.reset}\n`);
      process.exit(0);
    }
  }

  console.log(`\n${c.bold}starting server${c.reset}\n`);
  // Hand off to server.js in this process so signals (Ctrl-C) work as expected.
  // server.js only auto-listens when run directly (node server.js); required as
  // a module it exports start(), so call it explicitly here — asking for the
  // config summary, which this path is the main audience for. Default port, so
  // server.js keeps deciding what that is.
  require(path.join(ROOT, "server.js")).start(undefined, { banner: true });
})().catch((e) => {
  console.error(`${c.red}startup error:${c.reset}`, e);
  process.exit(1);
});

// ---------- one server at a time ----------

// prsnooze can be started four ways (this script in a terminal, the same script
// detached, launchd, systemd) and any of them can be run on top of a server
// that is already up. Binding twice fails with a raw EADDRINUSE stack trace,
// which reads like a broken install rather than "it's already working". So ask
// the port first, and turn the two answers into plain instructions.
async function guardSecondInstance() {
  const { probe, resolvePort } = require(path.join(ROOT, "lib", "instance.js"));
  const port = resolvePort({ root: ROOT });
  const found = await probe(port);

  if (found.state === "prsnooze") {
    console.log(
      `${c.green}${c.bold}prsnooze is already running${c.reset} at ${c.bold}${found.url}${c.reset}` +
        `${found.host ? ` ${c.dim}(host: ${found.host})${c.reset}` : ""}\n\n` +
        `  Nothing was started, and the one already running was left alone.\n` +
        `  ${c.dim}To bounce it:  bin/prsnooze-service restart${c.reset}\n` +
        `  ${c.dim}To stop it:    bin/prsnooze-service stop${c.reset}\n`,
    );
    process.exit(0);
  }

  if (found.state === "foreign") {
    console.log(
      `${c.red}${c.bold}port ${port} is already taken${c.reset} by something that isn't prsnooze` +
        `${found.reason ? ` ${c.dim}(${found.reason})${c.reset}` : ""}.\n\n` +
        `  Free that port, or set a different ${c.bold}PORT${c.reset} in ${c.dim}.env${c.reset}, then start again.\n`,
    );
    process.exit(1);
  }
}

// ---------- preflight ----------

async function runPreflight() {
  console.log(`${c.bold}preflight checks${c.reset}\n`);

  const dataHome = resolveDataHome();
  const checks = [
    {
      name: "Node.js ≥ 20",
      run: async () => {
        const major = parseInt(process.versions.node.split(".")[0], 10);
        if (major < 20) throw new Error(`have ${process.version}, need ≥ 20`);
        return process.version;
      },
      hint: "Install Node 20+ (https://nodejs.org or via nvm).",
    },
    {
      name: "git on PATH",
      run: async () => {
        const { stdout } = await execFileP("git", ["--version"]);
        return stdout.trim();
      },
      hint: "Install git: https://git-scm.com/downloads",
    },
    {
      name: "claude CLI on PATH",
      run: async () => {
        const { stdout } = await execFileP(process.env.CLAUDE_BIN || "claude", [
          "--version",
        ]);
        return stdout.trim().split("\n")[0];
      },
      hint: "Install Claude Code (https://claude.com/claude-code) and ensure `claude --version` works.",
    },
    {
      name: "claude is logged in",
      run: async () => {
        // No deterministic offline auth check today — claude --version succeeds
        // even when not logged in. Best-effort: confirm a config dir exists.
        const cfg = path.join(os.homedir(), ".claude");
        if (!fs.existsSync(cfg)) {
          throw new Error(`no ~/.claude/ directory — run \`claude\` once interactively to log in`);
        }
        return `~/.claude/ present`;
      },
      hint: "Run `claude` once in a terminal to complete the login flow.",
    },
    {
      name: "gh CLI on PATH",
      run: async () => {
        const { stdout } = await execFileP("gh", ["--version"]);
        return stdout.trim().split("\n")[0];
      },
      hint: "Install GitHub CLI: https://cli.github.com",
    },
    {
      name: "gh is authenticated",
      run: async () => {
        try {
          // gh auth status writes to stderr; we just need exit code.
          await execFileP("gh", ["auth", "status"]);
          return "ok";
        } catch (e) {
          throw new Error(e.stderr?.trim() || e.message);
        }
      },
      hint: "Run `gh auth login` and pick the GitHub.com account this server should review as.",
    },
    {
      name: "GitHub SSH reachable",
      run: async () => {
        // ssh -T git@github.com exits 1 on success (with the welcome message).
        // We accept exit 1 with the right message; any other error is a real fail.
        const out = await new Promise((resolve) => {
          execFile(
            "ssh",
            ["-T", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "git@github.com"],
            { timeout: 8000 },
            (err, stdout, stderr) => resolve({ err, stdout, stderr }),
          );
        });
        const text = (out.stderr || "") + (out.stdout || "");
        if (/successfully authenticated/i.test(text)) return "authenticated";
        if (/Permission denied/i.test(text))
          throw new Error("permission denied — SSH key not registered with GitHub");
        if (/Host key verification failed/i.test(text))
          throw new Error("host key verification failed");
        throw new Error(text.split("\n")[0] || "unexpected ssh error");
      },
      hint: "Add an SSH key to your GitHub account: https://github.com/settings/keys",
    },
    {
      name: `data dir writable (${tildify(dataHome)})`,
      run: async () => {
        await fsp.mkdir(dataHome, { recursive: true });
        const probe = path.join(dataHome, ".write-probe");
        await fsp.writeFile(probe, "ok");
        await fsp.unlink(probe);
        return "ok";
      },
      hint: `Make sure you can read/write ${dataHome}, or set PRSNOOZE_HOME to a path you own.`,
    },
  ];

  let allOk = true;
  for (const ch of checks) {
    process.stdout.write(`  ${ch.name}... `);
    try {
      const detail = await ch.run();
      console.log(`${c.green}ok${c.reset} ${c.dim}${detail || ""}${c.reset}`);
    } catch (e) {
      allOk = false;
      console.log(`${c.red}fail${c.reset}`);
      console.log(`    ${c.red}${e.message}${c.reset}`);
      if (ch.hint) console.log(`    ${c.dim}hint: ${ch.hint}${c.reset}`);
    }
  }
  return allOk;
}

function resolveDataHome() {
  // Mirror server.js precedence (env > default), without loading .env yet —
  // .env loads in server.js after preflight passes.
  return path.resolve(
    process.env.PRSNOOZE_HOME || path.join(os.homedir(), ".prsnooze"),
  );
}

function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// ---------- .env bootstrap ----------

async function ensureEnvFile() {
  if (fs.existsSync(ENV_FILE)) return;
  if (!fs.existsSync(ENV_EXAMPLE)) return;
  await fsp.copyFile(ENV_EXAMPLE, ENV_FILE);
  console.log(
    `${c.yellow}note:${c.reset} created ${c.dim}.env${c.reset} from ${c.dim}.env.example${c.reset} (first run). Edit it if you want to override defaults.`,
  );
}
