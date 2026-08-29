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

async function hasCommit(repoPath, sha) {
  try {
    await execFileP("git", ["-C", repoPath, "cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring the PR's head commit into the local clone and hand back the ref to
 * check the worktree out at (null if it couldn't be fetched).
 *
 * `pull/<N>/head` is the one ref that works for every PR: a fork's head branch
 * never exists on origin, so fetching `headRefName` would fail for exactly the
 * PRs where it matters most. We fetch it into a local `refs/prsnooze/pr/<N>`
 * so the commit is pinned and survives a later `fetch --prune`.
 *
 * Best effort by design. If the fetch fails — a server that hides `pull/*`, a
 * PR whose head was deleted — the caller falls back to the base branch and the
 * review still runs off `gh pr diff`.
 */
async function fetchPrHead({ repoPath, prNumber, headSha, onLog }) {
  if (!prNumber) return null;
  const localRef = `refs/prsnooze/pr/${prNumber}`;
  onLog?.(`Fetching PR #${prNumber} head`);
  try {
    await run("git", [
      "-C", repoPath, "fetch", "--quiet", "--force", "origin",
      `pull/${prNumber}/head:${localRef}`,
    ]);
  } catch (e) {
    onLog?.(
      `Could not fetch pull/${prNumber}/head — the worktree will sit on the base branch instead. (${e.message})`,
    );
    return null;
  }
  // Prefer the SHA the PR metadata pinned over the ref's current tip: the
  // review's file:line links quote that SHA, so the checkout and the links
  // have to agree even if the branch moved while we were reading metadata.
  if (headSha && (await hasCommit(repoPath, headSha))) return headSha;
  if (headSha) {
    onLog?.(
      `Head ${headSha.slice(0, 8)} isn't in the fetched history (force-push?) — using the PR's current tip.`,
    );
  }
  return localRef;
}

/**
 * Create the review's private worktree, detached at `ref` when one is given
 * (the PR head) and at the base branch otherwise.
 *
 * Resolves to { worktreePath, sha, ref } — the caller tells the reviewer which
 * commit it is looking at.
 */
async function addWorktree({ repoPath, worktreePath, baseBranch, ref = null, onLog }) {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const target = ref || `origin/${baseBranch}`;
  onLog?.(`Adding worktree ${worktreePath} at ${target}`);
  try {
    await run("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, target]);
  } catch (e) {
    const looksMissing = /invalid reference|unknown revision|not a valid object/i.test(
      e.cause?.stderr || e.message,
    );
    if (looksMissing && !ref) {
      const err = new Error(
        `Base branch "${baseBranch}" not found on origin after fetch. Is the PR's base branch still on the remote?`,
      );
      err.code = "BASE_BRANCH_MISSING";
      err.cause = e;
      throw err;
    }
    throw e;
  }
  let sha = null;
  try {
    const { stdout } = await execFileP("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
    sha = stdout.trim();
  } catch {
    // Not worth failing the review over: the worktree exists, we just can't
    // name its commit in the prompt.
  }
  return { worktreePath, sha, ref: target };
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

module.exports = { ensureRepo, fetchPrHead, addWorktree, removeWorktree };
