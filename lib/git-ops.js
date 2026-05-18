const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");

const execFileP = promisify(execFile);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd, args, opts = {}) {
  try {
    return await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  } catch (e) {
    const err = new Error(
      `${cmd} ${args.join(" ")} failed (exit ${e.code ?? "?"}): ${e.stderr || e.message}`,
    );
    err.code = "GIT_OP_FAILED";
    err.cause = e;
    throw err;
  }
}

function sshUrl(owner, repo) {
  return `git@github.com:${owner}/${repo}.git`;
}

async function getOriginUrl(repoPath) {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoPath,
      "remote",
      "get-url",
      "origin",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function ensureSshRemote({ repoPath, owner, repo, onLog }) {
  const current = await getOriginUrl(repoPath);
  const want = sshUrl(owner, repo);
  if (!current) return;
  if (current === want) return;
  if (current.startsWith("https://github.com/")) {
    onLog?.(`Switching origin from HTTPS to SSH (avoids credential prompt on fetch)`);
    await run("git", ["-C", repoPath, "remote", "set-url", "origin", want]);
  }
}

async function ensureRepo({ owner, repo, reposDir, onLog }) {
  const repoPath = path.resolve(reposDir, owner, repo);
  const isClone = await exists(path.join(repoPath, ".git"));
  if (!isClone) {
    onLog?.(`Cloning ${owner}/${repo} → ${repoPath} (via SSH)`);
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await run("git", ["clone", "--quiet", sshUrl(owner, repo), repoPath]);
  } else {
    await ensureSshRemote({ repoPath, owner, repo, onLog });
    onLog?.(`Fetching origin in ${repoPath}`);
    await run("git", ["-C", repoPath, "fetch", "origin", "--prune", "--quiet"]);
  }
  return repoPath;
}

async function addWorktree({ repoPath, worktreePath, baseBranch, onLog }) {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const ref = `origin/${baseBranch}`;
  onLog?.(`Adding worktree ${worktreePath} from ${ref}`);
  try {
    await run("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, ref]);
  } catch (e) {
    const looksMissing = /invalid reference|unknown revision|not a valid object/i.test(
      e.cause?.stderr || e.message,
    );
    if (looksMissing) {
      const err = new Error(
        `Base branch "${baseBranch}" not found on origin after fetch. Is the PR's base branch still on the remote?`,
      );
      err.code = "BASE_BRANCH_MISSING";
      err.cause = e;
      throw err;
    }
    throw e;
  }
  return worktreePath;
}

async function removeWorktree({ repoPath, worktreePath, onLog }) {
  onLog?.(`Removing worktree ${worktreePath}`);
  try {
    await run("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
  } catch (e) {
    onLog?.(`worktree remove failed; trying rm -rf + prune. (${e.message})`);
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      await run("git", ["-C", repoPath, "worktree", "prune"]);
    } catch (e2) {
      onLog?.(`fallback cleanup also failed: ${e2.message}`);
    }
  }
}

module.exports = { ensureRepo, addWorktree, removeWorktree };
