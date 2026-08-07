const path = require("node:path");
const os = require("node:os");
const {
  fetchPrMetadata,
  findMatchingTests,
  getSelfLogin,
  hasOwnReviewOnSha,
  fetchOwnPostsSince,
  outcomeFromOwnPosts,
} = require("./github");
const { ensureRepo, addWorktree, removeWorktree } = require("./git-ops");
const { runClaude, approvalBlock } = require("./claude-runner");
const { resolveReviewSkill } = require("./skill-resolver");
const { withRepoLock, repoLockBusy } = require("./repo-lock");

// Parse the "APPROVAL: <verb> — score=<N>, hits=[<codes>], reducers=[<codes>]"
// line the smart-gate prompt asks the model to emit. Returns null if absent
// or unparseable.
function parseApprovalRubric(finalText) {
  if (typeof finalText !== "string") return null;
  const m = finalText.match(
    /APPROVAL:\s*(approve|comment)\s*[—-]\s*score=(-?\d+)(?:,\s*hits=\[([^\]]*)\])?(?:,\s*reducers=\[([^\]]*)\])?/i,
  );
  if (!m) return null;
  const split = (s) =>
    (s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    verb: m[1].toLowerCase(),
    score: parseInt(m[2], 10),
    hits: split(m[3]),
    reducers: split(m[4]),
  };
}

/**
 * Settle a job's outcome against GitHub once the Claude run is over.
 *
 * The Bash sniffer gives us something to show live, but it is a guess. GitHub is
 * the record of what was actually posted, so it wins whenever we can reach it.
 * If we can't reach it, we keep the guess but mark the result unverified rather
 * than asserting "nothing was posted" — which is what the UI used to claim any
 * time the sniffer missed a posting form.
 */
async function settleOutcome(job, helpers, { since, log }) {
  const guessed = job.outcome || null;
  let posts;
  try {
    posts = await fetchOwnPostsSince(job.prUrl, since);
  } catch (e) {
    posts = { checked: false, reason: e.message };
  }
  const verified = outcomeFromOwnPosts(posts);

  if (!verified) {
    // Couldn't ask GitHub. Keep whatever we saw, and be honest about it.
    job.outcome = guessed || "no_new_findings";
    job.outcomeVerified = false;
    helpers.emit({
      kind: "outcome_detected",
      outcome: job.outcome,
      verified: false,
      detail: posts?.reason ? `couldn't confirm with GitHub: ${posts.reason}` : "couldn't confirm with GitHub",
    });
    log(`Outcome ${job.outcome} (unconfirmed — ${posts?.reason || "GitHub lookup failed"}).`);
    return;
  }

  job.outcome = verified;
  job.outcomeVerified = true;
  const found = [];
  if (posts.reviews?.length) found.push(`${posts.reviews.length} review(s): ${posts.reviews.join(", ")}`);
  if (posts.comments) found.push(`${posts.comments} PR comment(s)`);
  if (posts.inline) found.push(`${posts.inline} inline comment(s)`);
  helpers.emit({ kind: "outcome_detected", outcome: verified, verified: true, detail: found.join(" · ") || "nothing posted" });

  if (guessed && guessed !== verified) {
    log(`Outcome corrected: saw \`${guessed}\` in the commands, GitHub says ${verified} (${found.join(" · ") || "nothing posted"}).`);
  } else if (verified === "no_new_findings") {
    log("Confirmed with GitHub: nothing was posted on this PR during the run.");
  } else {
    log(`Confirmed with GitHub: ${found.join(" · ")}.`);
  }
}

// Optimistic, live outcome guess from the Bash commands Claude runs, so the UI
// can show a verdict the moment it posts rather than at the end of the run.
// Deliberately a guess: settleOutcome() reconciles it with GitHub before
// the job finishes, because this can both miss a post and count one that failed.
function detectOutcomeFromBashCommand(cmd) {
  if (typeof cmd !== "string") return null;
  // `gh pr review` with a long OR short verb flag (-a/-c/-r are easy to miss).
  const reviewMatch = cmd.match(/gh\s+pr\s+review\b[\s\S]*?(--(?:approve|comment|request-changes)|\s-(?:a|c|r)\b)/);
  if (reviewMatch) {
    const flag = reviewMatch[1].trim();
    if (flag === "--approve" || flag === "-a") return "approved";
    if (flag === "--request-changes" || flag === "-r") return "changes_requested";
    return "commented";
  }
  // Plain `gh pr comment`, and the REST forms of both.
  if (/gh\s+pr\s+comment\b/.test(cmd)) return "commented";
  if (/gh\s+api\b[\s\S]*\/pulls\/\d+\/reviews\b/.test(cmd)) {
    if (/event=APPROVE\b/.test(cmd)) return "approved";
    if (/event=REQUEST_CHANGES\b/.test(cmd)) return "changes_requested";
    return "commented";
  }
  if (/gh\s+api\b[\s\S]*\/(issues|pulls)\/\d+\/comments\b/.test(cmd)) return "commented";
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
    headRefOid: meta.headRefOid,
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

  // Auto-approval is now purely a config toggle. Findings + criticality (in
  // the model prompt) decide the final call. Stats still emitted so the UI
  // can show the prod/test breakdown for context.
  const matchedTests = findMatchingTests(meta.fileBreakdown);
  const approval = {
    autoApprove: !!config.autoApprove,
    matchedTests,
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
  };
  const approvalReason = approval.autoApprove
    ? "eligible — final call delegated to reviewer based on findings and criticality"
    : "auto-approve disabled in config";
  helpers.emit({
    kind: "approval_policy",
    autoApprove: approval.autoApprove,
    reason: approvalReason,
    stats: approval.stats,
    matchedTests,
  });

  // 2 + 3. Sync the repo and create the worktree — serialized PER REPO so
  // concurrent reviews of the same repo never race on the shared `.git`.
  // Different repos run this in parallel; same-repo reviews take turns for
  // just this ~10s of git plumbing, then their reviews run concurrently.
  const repoKey = `${meta.owner}/${meta.repo}`;
  if (repoLockBusy(repoKey)) {
    log(`Another review of ${repoKey} is preparing the repo — waiting my turn…`);
  }
  const worktreePath = path.resolve(config.worktreesDir, job.id);
  const repoPath = await withRepoLock(repoKey, async () => {
    helpers.emit({ kind: "phase", phase: "syncing_repo" });
    const rp = await ensureRepo({
      owner: meta.owner,
      repo: meta.repo,
      reposDir: config.reposDir,
      onLog: (m) => log(m),
    });

    helpers.emit({ kind: "phase", phase: "creating_worktree" });
    await addWorktree({
      repoPath: rp,
      worktreePath,
      baseBranch: meta.baseRefName,
      onLog: (m) => log(m),
    });
    return rp;
  });
  job.repoPath = repoPath;
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
  const runStartedAt = Date.now();
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

    // Record the child PID so a later server startup can detect and reap this
    // review if we die before it finishes (see server hydrateJobs). Persisted
    // via the coarse "claude_started" event.
    job.claudePid = ee.pid || null;
    helpers.emit({ kind: "claude_started", pid: ee.pid || null });

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
      job.claudePid = null;
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

  // Reconcile the outcome with GitHub. The command sniffer above is a guess: it
  // can miss a posting form it doesn't recognise, and it can't see that a
  // command failed. Claiming "no comment was posted" when one WAS is the worst
  // way to be wrong, so ask GitHub what we actually posted during this run.
  await settleOutcome(job, helpers, { since: runStartedAt, log });

  // 5. Cleanup
  helpers.emit({ kind: "phase", phase: "cleanup" });
  if (config.keepWorktreeOnSuccess) {
    log(`Keeping worktree ${worktreePath} (KEEP_WORKTREES_ON_SUCCESS=true)`);
  } else {
    // Serialized per repo: `worktree remove`/`prune` mutate the shared `.git`
    // and must not overlap another same-repo job's `worktree add`.
    await withRepoLock(repoKey, () =>
      removeWorktree({ repoPath, worktreePath, onLog: (m) => log(m) }),
    );
  }

  const rubric = parseApprovalRubric(result.result?.result);
  if (rubric) {
    job.rubric = rubric;
    helpers.emit({ kind: "rubric", ...rubric });
  }

  helpers.emit({
    kind: "summary",
    durationMs: result.result?.durationMs,
    numTurns: result.result?.numTurns,
    totalCostUsd: result.result?.totalCostUsd,
    sessionId: result.result?.sessionId,
    finalText: result.result?.result,
    rubric,
  });
}

/**
 * The prompt sent when resuming a finished review to check the author's fixes.
 *
 * Pure, and exported, because two of its rules are regressions worth pinning:
 * it must carry the approval gate (a resume that can't approve leaves a PR
 * stuck forever once its findings are fixed), and it must post with
 * `gh pr review` rather than `gh pr comment` (an issue comment sets no review
 * state, so branch protection and `reviewDecision` never see it).
 */
function buildVerifyPrompt({ meta, approval }) {
  return [
    `You previously reviewed this pull request: ${meta.url}`,
    `Since then the author may have pushed commits AND replied to your comments. Re-check the`,
    `CURRENT state, and treat their replies as part of the evidence — a reply may resolve a point,`,
    `push back on it with information you didn't have, or misunderstand it.`,
    ``,
    `Gather the current state first:`,
    `  - \`gh pr diff ${meta.number}\` — the latest diff.`,
    `  - \`gh api repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/comments --paginate\` — inline`,
    `    comments and, crucially, the replies to yours (see in_reply_to_id).`,
    `  - \`gh pr view ${meta.number} --json comments,reviews\` — PR-level discussion.`,
    ``,
    `Then, for every point you raised earlier, classify it as one of:`,
    `  ADDRESSED  — the code now handles it (say which commit/file).`,
    `  ANSWERED   — the author explained why it's not an issue and they are right; concede plainly.`,
    `  STILL OPEN — not fixed and the reply doesn't resolve it; say what remains, briefly.`,
    ``,
    `Report a concise follow-up covering only what changed in your assessment. Keep it short: do NOT`,
    `repeat your original review, and do NOT re-raise points you now consider ANSWERED.`,
    ``,
    `Post exactly ONE review via \`gh pr review ${meta.number}\`, with the verb the approval policy`,
    `below picks. Use \`gh pr review\`, never \`gh pr comment\`: a resume has to leave a real review`,
    `state on the PR (APPROVED or COMMENTED), not a loose issue comment that no branch-protection`,
    `rule can see.`,
    ``,
    ...approvalBlock(approval),
    ``,
    `You are running with --dangerously-skip-permissions; execute the checks end to end.`,
  ].join("\n");
}

/**
 * Re-run a finished review to VALIDATE that the author addressed the comments,
 * by RESUMING the original Claude session (not starting a fresh one). Recreates
 * the worktree at the SAME path so `claude --resume <sessionId>` finds the
 * session (stored on disk keyed by cwd). The diff is read live via `gh pr diff`,
 * so the recreated base-branch worktree still reflects the author's new commits.
 */
async function runVerifyJob(job, helpers, config) {
  const log = (msg, extra = {}) => helpers.emit({ kind: "log", message: msg, ...extra });
  const sessionId = job.resumeSessionId || job.sessionId || job.summary?.sessionId;
  if (!sessionId) {
    const err = new Error("no Claude session recorded — can't resume; run a fresh review instead.");
    err.code = "NO_SESSION";
    throw err;
  }

  helpers.emit({ kind: "phase", phase: "resolving" });
  const meta = await fetchPrMetadata(job.prUrl);
  job.prMeta = meta;
  helpers.emit({
    kind: "pr_meta",
    title: meta.title, number: meta.number, nameWithOwner: meta.nameWithOwner, headRefOid: meta.headRefOid,
    baseRefName: meta.baseRefName, headRefName: meta.headRefName, authorLogin: meta.authorLogin,
    isDraft: meta.isDraft, url: meta.url, additions: meta.additions, deletions: meta.deletions,
    changedFiles: meta.changedFiles, prodAdditions: meta.prodAdditions, prodDeletions: meta.prodDeletions,
    prodFiles: meta.prodFiles, testAdditions: meta.testAdditions, testDeletions: meta.testDeletions, testFiles: meta.testFiles,
  });
  log(`Verify fixes — resuming the original review of PR #${meta.number} to check if comments were addressed.`);

  // The resume gets the SAME approval gate as a first-pass review, in reReview
  // mode. Without it the resumed prompt had no rule for approve-vs-comment, so
  // a PR whose every finding had been fixed still came back as a plain comment:
  // the gate simply was not in the conversation.
  const matchedTests = findMatchingTests(meta.fileBreakdown);
  const approval = {
    autoApprove: !!config.autoApprove,
    matchedTests,
    reReview: true,
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
  };
  helpers.emit({
    kind: "approval_policy",
    autoApprove: approval.autoApprove,
    reason: approval.autoApprove
      ? "eligible — re-scored on the current head now that the author has pushed fixes"
      : "auto-approve disabled in config",
    stats: approval.stats,
    matchedTests,
  });

  const repoKey = `${meta.owner}/${meta.repo}`;
  const worktreePath = path.resolve(config.worktreesDir, job.id); // SAME path as the original review
  const repoPath = await withRepoLock(repoKey, async () => {
    helpers.emit({ kind: "phase", phase: "syncing_repo" });
    const rp = await ensureRepo({ owner: meta.owner, repo: meta.repo, reposDir: config.reposDir, onLog: (m) => log(m) });
    helpers.emit({ kind: "phase", phase: "creating_worktree" });
    await removeWorktree({ repoPath: rp, worktreePath, onLog: () => {} }).catch(() => {}); // clear any leftover
    await addWorktree({ repoPath: rp, worktreePath, baseBranch: meta.baseRefName, onLog: (m) => log(m) });
    return rp;
  });
  job.repoPath = repoPath;
  job.worktreePath = worktreePath;
  helpers.emit({ kind: "worktree_ready", path: worktreePath });

  helpers.emit({ kind: "phase", phase: "reviewing" });
  const runStartedAt = Date.now();
  log(`Resuming claude session ${sessionId.slice(0, 8)} in ${worktreePath}`);
  const verifyPrompt = buildVerifyPrompt({ meta, approval });

  const result = await new Promise((resolve, reject) => {
    const ee = runClaude({
      prUrl: meta.url,
      cwd: worktreePath,
      claudeBin: config.claudeBin,
      resumeSessionId: sessionId,
      promptText: verifyPrompt,
    });
    job.claudePid = ee.pid || null;
    helpers.emit({ kind: "claude_started", pid: ee.pid || null });
    let lastResult = null;
    const onAbort = () => { try { ee.kill("SIGTERM"); } catch {} };
    helpers.signal?.addEventListener("abort", onAbort, { once: true });
    ee.on("event", (e) => {
      if (e.kind === "result") lastResult = e;
      if (e.kind === "tool_use" && e.tool === "Bash") {
        const outcome = detectOutcomeFromBashCommand(e.full?.command || e.summary || "");
        if (outcome) { job.outcome = outcome; helpers.emit({ kind: "outcome_detected", outcome }); }
      }
      helpers.emit({ kind: "claude", ...e });
    });
    ee.on("error", (e) => { helpers.signal?.removeEventListener("abort", onAbort); reject(new Error(`claude spawn error: ${e.message}`)); });
    ee.on("exit", ({ code, signal, stderrTail }) => {
      helpers.signal?.removeEventListener("abort", onAbort);
      job.claudePid = null;
      if (code === 0) resolve({ result: lastResult });
      else { const err = new Error(`claude exited with code=${code} signal=${signal || "none"}.\nLast stderr:\n${stderrTail || "(empty)"}`); err.code = "CLAUDE_NONZERO"; reject(err); }
    });
  });

  await settleOutcome(job, helpers, { since: runStartedAt, log });

  helpers.emit({ kind: "phase", phase: "cleanup" });
  if (!config.keepWorktreeOnSuccess) {
    await withRepoLock(repoKey, () => removeWorktree({ repoPath, worktreePath, onLog: (m) => log(m) }));
  }
  const rubric = parseApprovalRubric(result.result?.result);
  if (rubric) {
    job.rubric = rubric;
    helpers.emit({ kind: "rubric", ...rubric });
  }

  helpers.emit({
    kind: "summary",
    durationMs: result.result?.durationMs, numTurns: result.result?.numTurns,
    totalCostUsd: result.result?.totalCostUsd, sessionId: result.result?.sessionId, finalText: result.result?.result,
    rubric,
  });
  job.mode = null; // back to normal for any future action
}

// detectOutcomeFromBashCommand is exported for its tests — the shapes it has to
// recognise are a regression list, not an implementation detail.
module.exports = { runReviewJob, runVerifyJob, detectOutcomeFromBashCommand, buildVerifyPrompt };
