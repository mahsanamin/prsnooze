const path = require("node:path");
const os = require("node:os");
const {
  fetchPrMetadata,
  getSelfLogin,
  hasOwnReviewOnSha,
} = require("./github");
const { ensureRepo, addWorktree, removeWorktree } = require("./git-ops");
const { runClaude } = require("./claude-runner");
const { resolveReviewSkill } = require("./skill-resolver");

// Recognize the various "post to PR" shapes Claude might use and tag the
// outcome. Returns "approved" | "changes_requested" | "commented" | null.
function detectOutcomeFromBashCommand(cmd) {
  if (typeof cmd !== "string") return null;
  // gh pr review forms — match any of the verbs
  const reviewMatch = cmd.match(/gh\s+pr\s+review\b[\s\S]*?--(approve|comment|request-changes)\b/);
  if (reviewMatch) {
    if (reviewMatch[1] === "approve") return "approved";
    if (reviewMatch[1] === "request-changes") return "changes_requested";
    return "commented";
  }
  // Plain `gh pr comment` (no review wrapper)
  if (/gh\s+pr\s+comment\b/.test(cmd)) return "commented";
  return null;
}

function tildify(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * Orchestrate one PR review.
 *
 * job:    { id, prUrl, createdAt, ... }
 * helpers: { emit(event), signal }
 * config: { reposDir, worktreesDir, claudeBin, keepWorktreeOnSuccess }
 */
async function runReviewJob(job, helpers, config) {
  const log = (msg, extra = {}) => helpers.emit({ kind: "log", message: msg, ...extra });

  // 1. Resolve PR metadata
  helpers.emit({ kind: "phase", phase: "resolving" });
  log(`Looking up PR ${job.prUrl}`);
  const meta = await fetchPrMetadata(job.prUrl);
  job.prMeta = meta;
  helpers.emit({
    kind: "pr_meta",
    title: meta.title,
    number: meta.number,
    nameWithOwner: meta.nameWithOwner,
    baseRefName: meta.baseRefName,
    headRefName: meta.headRefName,
    authorLogin: meta.authorLogin,
    isDraft: meta.isDraft,
    url: meta.url,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
    prodAdditions: meta.prodAdditions,
    prodDeletions: meta.prodDeletions,
    prodFiles: meta.prodFiles,
    testAdditions: meta.testAdditions,
    testDeletions: meta.testDeletions,
    testFiles: meta.testFiles,
  });
  log(
    `PR #${meta.number} "${meta.title}" — base=${meta.baseRefName}, head=${meta.headRefName} ` +
      `(+${meta.additions}/-${meta.deletions}, ${meta.changedFiles} files; ` +
      `prod +${meta.prodAdditions}/-${meta.prodDeletions} in ${meta.prodFiles}, ` +
      `tests +${meta.testAdditions}/-${meta.testDeletions} in ${meta.testFiles})`,
  );

  // Cheap pre-flight skip: if our own gh identity already reviewed this exact
  // commit SHA, refuse to re-review. Saves an entire Claude run on no-ops
  // (e.g., a colleague resubmitting a stale URL).
  if (config.skipIfAlreadyReviewed !== false) {
    const selfLogin = await getSelfLogin();
    if (selfLogin && hasOwnReviewOnSha(meta.reviews, meta.headRefOid, selfLogin)) {
      const existing = meta.reviews.find(
        (r) => r?.commit?.oid === meta.headRefOid && r?.author?.login === selfLogin,
      );
      helpers.emit({
        kind: "skipped",
        reason: "already_reviewed_by_self",
        detail: `@${selfLogin} already posted a ${existing?.state?.toLowerCase() || "review"} on commit ${meta.headRefOid.slice(0, 7)}`,
        outcome: existing?.state === "APPROVED" ? "approved" : existing?.state === "CHANGES_REQUESTED" ? "changes_requested" : "commented",
      });
      log(`Skipped — already reviewed by @${selfLogin} on this commit.`);
      job.skipped = true;
      job.outcome = existing?.state === "APPROVED" ? "approved" : "commented";
      return;
    }
  }

  if (meta.triviality) {
    log(`Triviality hint: this PR looks ${meta.triviality.kind}-only — reviewer will keep it terse.`);
  }
  if (meta.isDraft) {
    log(`Note: PR is marked as DRAFT — reviewing anyway (you submitted it).`);
  }

  // Decide auto-approval policy: size caps apply to PROD lines/files only.
  // Test churn is exempt (lower regression risk by construction). The
  // reviewer's criticality check still catches risky test changes.
  const prodLines = meta.prodAdditions + meta.prodDeletions;
  const sizeOk =
    prodLines <= config.autoApproveMaxLines &&
    meta.prodFiles <= config.autoApproveMaxFiles;
  const approval = {
    autoApprove: !!config.autoApprove,
    sizeOk,
    stats: {
      additions: meta.additions,
      deletions: meta.deletions,
      changedFiles: meta.changedFiles,
      prodAdditions: meta.prodAdditions,
      prodDeletions: meta.prodDeletions,
      prodFiles: meta.prodFiles,
      testAdditions: meta.testAdditions,
      testDeletions: meta.testDeletions,
      testFiles: meta.testFiles,
    },
    maxLines: config.autoApproveMaxLines,
    maxFiles: config.autoApproveMaxFiles,
  };
  let approvalReason;
  if (!approval.autoApprove) {
    approvalReason = "auto-approve disabled in config";
  } else if (!approval.sizeOk) {
    approvalReason =
      `PR too large in prod code (${prodLines} prod lines / ${meta.prodFiles} prod files; ` +
      `limit ${config.autoApproveMaxLines}/${config.autoApproveMaxFiles}) — tests excluded from the count`;
  } else {
    const testNote =
      meta.testFiles > 0
        ? ` (tests excluded: +${meta.testAdditions}/-${meta.testDeletions} in ${meta.testFiles} file${meta.testFiles === 1 ? "" : "s"})`
        : "";
    approvalReason = `eligible — prod ${prodLines}L / ${meta.prodFiles}F within caps${testNote}; final call delegated to reviewer based on criticality`;
  }
  helpers.emit({
    kind: "approval_policy",
    autoApprove: approval.autoApprove,
    sizeOk: approval.sizeOk,
    reason: approvalReason,
    stats: approval.stats,
    maxLines: approval.maxLines,
    maxFiles: approval.maxFiles,
  });

  // 2. Ensure repo cloned/fetched
  helpers.emit({ kind: "phase", phase: "syncing_repo" });
  const repoPath = await ensureRepo({
    owner: meta.owner,
    repo: meta.repo,
    reposDir: config.reposDir,
    onLog: (m) => log(m),
  });
  job.repoPath = repoPath;

  // 3. Create worktree from base branch
  helpers.emit({ kind: "phase", phase: "creating_worktree" });
  const worktreePath = path.resolve(config.worktreesDir, job.id);
  await addWorktree({
    repoPath,
    worktreePath,
    baseBranch: meta.baseRefName,
    onLog: (m) => log(m),
  });
  job.worktreePath = worktreePath;
  helpers.emit({ kind: "worktree_ready", path: worktreePath });

  // 4. Resolve the project's review skill (so we can inline its body into
  //    the prompt — skills with `disable-model-invocation: true` can't be
  //    dispatched by the model via the Skill tool).
  const { skill, attempted } = await resolveReviewSkill(worktreePath);
  if (skill) {
    job.skill = { name: skill.name, path: skill.path, source: skill.source };
    helpers.emit({
      kind: "skill_resolved",
      name: skill.name,
      path: skill.path,
      pathDisplay: tildify(skill.path),
      source: skill.source, // "project" | "user" | "bundled"
      bodyLength: skill.body.length,
    });
    const sourceWord =
      skill.source === "project"
        ? "project"
        : skill.source === "user"
          ? "user-level"
          : "bundled";
    log(`Using ${sourceWord} review skill: ${skill.name} (${tildify(skill.path)})`);
  } else {
    // Only reached if even the bundled skill is missing (corrupted install).
    helpers.emit({
      kind: "skill_missing",
      attempted: attempted.map((p) => tildify(p)),
    });
    log(`No review skill found anywhere (including bundled fallback) — running a generic review.`);
  }

  // 5. Spawn claude in the worktree, stream events
  helpers.emit({ kind: "phase", phase: "reviewing" });
  log(`Starting claude in ${worktreePath}`);
  const result = await new Promise((resolve, reject) => {
    const ee = runClaude({
      prUrl: meta.url,
      skill,
      approval,
      headSha: meta.headRefOid,
      headRepoOwner: meta.headRepoOwner,
      headRepoName: meta.headRepoName,
      triviality: meta.triviality,
      confidenceThreshold: config.confidenceThreshold,
      cwd: worktreePath,
      claudeBin: config.claudeBin,
    });

    let lastResult = null;

    const onAbort = () => {
      log("Cancellation requested — sending SIGTERM to claude");
      try {
        ee.kill("SIGTERM");
      } catch {}
    };
    helpers.signal?.addEventListener("abort", onAbort, { once: true });

    ee.on("event", (e) => {
      if (e.kind === "result") lastResult = e;
      // Detect outcome (approved/commented/changes_requested) by sniffing
      // Bash tool calls as they happen.
      if (e.kind === "tool_use" && e.tool === "Bash") {
        const cmd = e.full?.command || e.summary || "";
        const outcome = detectOutcomeFromBashCommand(cmd);
        if (outcome) {
          job.outcome = outcome;
          helpers.emit({ kind: "outcome_detected", outcome });
        }
      }
      helpers.emit({ kind: "claude", ...e });
    });
    ee.on("error", (e) => {
      helpers.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`claude spawn error: ${e.message}`));
    });
    ee.on("exit", ({ code, signal, stderrTail }) => {
      helpers.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve({ result: lastResult });
      } else {
        const err = new Error(
          `claude exited with code=${code} signal=${signal || "none"}.\nLast stderr:\n${stderrTail || "(empty)"}`,
        );
        err.code = "CLAUDE_NONZERO";
        reject(err);
      }
    });
  });

  // 5. Cleanup
  helpers.emit({ kind: "phase", phase: "cleanup" });
  if (config.keepWorktreeOnSuccess) {
    log(`Keeping worktree ${worktreePath} (KEEP_WORKTREES_ON_SUCCESS=true)`);
  } else {
    await removeWorktree({ repoPath, worktreePath, onLog: (m) => log(m) });
  }

  helpers.emit({
    kind: "summary",
    durationMs: result.result?.durationMs,
    numTurns: result.result?.numTurns,
    totalCostUsd: result.result?.totalCostUsd,
    sessionId: result.result?.sessionId,
    finalText: result.result?.result,
  });
}

module.exports = { runReviewJob };
