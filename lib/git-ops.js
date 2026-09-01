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
    return await execFileP(cmd, args, {
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
      env: { ...process.env, ...gitEnv(), ...(opts.env || {}) },
    });
  } catch (e) {
    const err = new Error(
      `${cmd} ${args.join(" ")} failed (exit ${e.code ?? "?"}): ${e.stderr || e.message}`,
    );
    err.code = "GIT_OP_FAILED";
    err.cause = e;
    throw err;
  }
}

// How prsnooze talks to GitHub.
//
// HTTPS with the token `gh` is already holding, by default, and deliberately.
// SSH looks like the natural choice on a developer's machine and is the wrong
// one here: the key usually lives in the ssh-agent that the login shell
// started, a background service gets a different (empty) agent, and every fetch
// then dies on "Permission denied (publickey)" while the same command works
// perfectly when the host types it. There is no agent in this path at all, so
// there is nothing to be missing.
//
// prsnooze already requires `gh` to be authenticated (it reads every PR through
// it and posts every review as it), so this adds no credential the host hasn't
// already given us, and it is the same identity the review is posted under.
//
// PRSNOOZE_GIT_TRANSPORT=ssh goes back to SSH, for a host whose gh token can't
// read the repos but whose key can.
function transport() {
  return String(process.env.PRSNOOZE_GIT_TRANSPORT || "https").toLowerCase() === "ssh"
    ? "ssh"
    : "https";
}

function sshUrl(owner, repo) {
  return `git@github.com:${owner}/${repo}.git`;
}

function httpsUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

function remoteUrl(owner, repo) {
  return transport() === "ssh" ? sshUrl(owner, repo) : httpsUrl(owner, repo);
}

// Never let git stop and wait for a human. A service has no terminal, so a
// missing credential or a locked key has to come back as an error we can
// report, not as a fetch that hangs until someone notices the review never
// finished.
function gitEnv() {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: process.env.GIT_ASKPASS || "echo",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  };
}

// The credential helper, passed per command rather than written into anyone's
// git config. `gh auth git-credential` hands git the token gh already has, and
// scoping it to github.com means prsnooze never answers for another host.
//
// The empty value first is what `gh auth setup-git` does: it resets any helper
// chain inherited from the host's global config, so a broken or interactive
// helper there cannot get in front of ours.
function credentialArgs() {
  if (transport() !== "https") return [];
  const gh = process.env.CLAUDE_GH_BIN || process.env.GH_BIN || "gh";
  return [
    "-c", "credential.https://github.com.helper=",
    "-c", `credential.https://github.com.helper=!${gh} auth git-credential`,
  ];
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

// Point an existing clone at the transport prsnooze is configured for. Clones
// made by older versions are on SSH; they are moved without being re-cloned,
// and a host who sets PRSNOOZE_GIT_TRANSPORT=ssh gets them moved back.
async function ensureRemote({ repoPath, owner, repo, onLog }) {
  const current = await getOriginUrl(repoPath);
  const want = remoteUrl(owner, repo);
  if (!current || current === want) return;
  const known = [sshUrl(owner, repo), httpsUrl(owner, repo), `https://github.com/${owner}/${repo}`];
  // Only rewrite a URL we recognise as our own doing. A host who pointed the
  // clone somewhere deliberate (a mirror, a proxy) keeps it.
  if (!known.includes(current)) return;
  onLog?.(`Switching origin to ${transport().toUpperCase()} (${want})`);
  await run("git", ["-C", repoPath, "remote", "set-url", "origin", want]);
}

async function ensureRepo({ owner, repo, reposDir, onLog }) {
  const repoPath = path.resolve(reposDir, owner, repo);
  const isClone = await exists(path.join(repoPath, ".git"));
  if (!isClone) {
    onLog?.(`Cloning ${owner}/${repo} → ${repoPath} (over ${transport().toUpperCase()})`);
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await run("git", [...credentialArgs(), "clone", "--quiet", remoteUrl(owner, repo), repoPath]);
  } else {
    await ensureRemote({ repoPath, owner, repo, onLog });
    onLog?.(`Fetching origin in ${repoPath}`);
    await run("git", [...credentialArgs(), "-C", repoPath, "fetch", "origin", "--prune", "--quiet"]);
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
      ...credentialArgs(),
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

module.exports = {
  ensureRepo,
  fetchPrHead,
  addWorktree,
  removeWorktree,
  // exported for the preflight check and its tests
  ensureRemote,
  transport,
  remoteUrl,
  credentialArgs,
  gitEnv,
};
