"use strict";

// Mark prsnooze's own clones as trusted workspaces for Claude Code.
//
// Claude Code only honours a repo's `.claude/settings.json` in a directory the
// host has trusted, and trust is granted by answering a dialog that only ever
// appears in an interactive session. prsnooze's clones are created by prsnooze,
// live under `~/.prsnooze/`, and are never opened by hand — so that dialog
// never gets answered, and every review runs with the reviewed repo's own
// config half-loaded. The tell is a line like this on claude's stderr:
//
//   Ignoring 30 permissions.allow entries from .claude/settings.json:
//   this workspace has not been trusted. Run Claude Code interactively here
//   once and accept the trust dialog, or set
//   projects["/home/you/.prsnooze/repos/acme/widgets"].hasTrustDialogAccepted:
//   true in /home/you/.claude.json.
//
// That is a problem for prsnooze specifically, because "your project's own
// `.claude/`" is the whole pitch: an untrusted workspace also drops the repo's
// project-level skills and agents. So we write exactly what the dialog would
// have written, for exactly the directories prsnooze created — which is the
// same decision the host already made by pointing prsnooze at these clones and
// letting it run `claude --dangerously-skip-permissions` inside them.
//
// Rules this follows, because `~/.claude.json` is the host's live Claude Code
// config and not ours to break:
//   - never create the file (if Claude Code has never run here, there is
//     nothing for us to patch and no trust to grant)
//   - never write when the flag is already set (the common case: one write per
//     repo, ever)
//   - take the same mkdir-based lock Claude Code takes, and give up rather than
//     force it
//   - write via a temp file + rename, so a crash can't leave a half-file
//
// Set PRSNOOZE_TRUST_CLONES=false to skip all of this and leave the config
// alone; reviews still run, they just run with the reviewed repo's project
// settings ignored.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 100;
// Claude Code refreshes its lock's mtime every few seconds while it holds it,
// so a much older lock directory is a leftover from something that died.
const LOCK_STALE_MS = 60_000;

function enabled() {
  return String(process.env.PRSNOOZE_TRUST_CLONES ?? "true") === "true";
}

/**
 * Where Claude Code keeps the config that holds `projects[dir]`.
 *
 * CLAUDE_CONFIG_DIR relocates it, so prefer that when it actually has a config
 * in it, and fall back to the home-directory default.
 */
async function configPath() {
  const custom = process.env.CLAUDE_CONFIG_DIR;
  if (custom) {
    const candidate = path.join(custom, ".claude.json");
    if (await exists(candidate)) return candidate;
  }
  return path.join(os.homedir(), ".claude.json");
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(lockPath) {
  for (let i = 0; i < LOCK_ATTEMPTS; i++) {
    try {
      await fs.mkdir(lockPath);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // It vanished between mkdir and stat — just try again.
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  return false;
}

/**
 * The keys Claude Code could use for this directory. It stores the resolved
 * path; when the path runs through a symlink the resolved and real forms
 * differ, and which one it lands on isn't ours to predict — so set both.
 */
async function trustKeysFor(dir) {
  const resolved = path.resolve(dir);
  const keys = new Set([resolved]);
  try {
    keys.add(await fs.realpath(resolved));
  } catch {
    // Directory gone; the caller's own git work will have failed already.
  }
  return [...keys];
}

/**
 * Ensure `dir` is a trusted workspace, writing `~/.claude.json` only if it
 * isn't already.
 *
 * Resolves to { changed, reason } and never throws: a review must not fail
 * because we couldn't touch an unrelated config file.
 *   reason: "disabled" | "no-config" | "already" | "granted" | "busy" | "error"
 */
async function ensureWorkspaceTrusted(dir, { onLog } = {}) {
  if (!enabled()) return { changed: false, reason: "disabled" };

  const file = await configPath();
  if (!(await exists(file))) return { changed: false, reason: "no-config" };

  const keys = await trustKeysFor(dir);
  try {
    const before = JSON.parse(await fs.readFile(file, "utf8"));
    if (keys.every((k) => before?.projects?.[k]?.hasTrustDialogAccepted === true)) {
      return { changed: false, reason: "already" };
    }
  } catch {
    // Unreadable or not JSON — leave it strictly alone.
    return { changed: false, reason: "error" };
  }

  const lockPath = `${file}.lock`;
  if (!(await acquireLock(lockPath))) {
    onLog?.(
      `Claude Code is writing ${file} right now — leaving the workspace-trust flag for the next review.`,
    );
    return { changed: false, reason: "busy" };
  }

  try {
    // Re-read under the lock: whoever held it may have just changed this.
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    const projects = { ...(config.projects || {}) };
    let changed = false;
    for (const key of keys) {
      if (projects[key]?.hasTrustDialogAccepted === true) continue;
      projects[key] = { ...(projects[key] || {}), hasTrustDialogAccepted: true };
      changed = true;
    }
    if (!changed) return { changed: false, reason: "already" };

    const next = JSON.stringify({ ...config, projects }, null, 2);
    const tmp = `${file}.prsnooze-${process.pid}.tmp`;
    await fs.writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
    onLog?.(`Marked ${dir} as a trusted workspace in ${file} (so the repo's own .claude/ is honored)`);
    return { changed: true, reason: "granted" };
  } catch (e) {
    onLog?.(`Could not mark ${dir} trusted in ${file} (${e.message}) — continuing without it.`);
    return { changed: false, reason: "error" };
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { ensureWorkspaceTrusted };
