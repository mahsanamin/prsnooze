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
const { ensureRepo, fetchPrHead, addWorktree, removeWorktree } = require("./git-ops");
const { approvalBlock, workingTreeBlock } = require("./review-prompt");
const { getProvider } = require("./providers");
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

function resolveJobProvider(job, config) {
  // New jobs are stamped with a provider before they enter the queue. A saved
  // job without one therefore predates provider support and its session id is
  // a Claude session id. Never reinterpret that legacy data through today's
  // default provider.
  const id = job.provider || "claude";
  let provider = config.providers instanceof Map ? config.providers.get(id) : null;
  if (!provider) {
    const env = { ...process.env };
    if (config.claudeBin) env.CLAUDE_BIN = config.claudeBin;
    if (config.codexBin) env.CODEX_BIN = config.codexBin;
    if (config.codexModel) env.CODEX_MODEL = config.codexModel;
    provider = getProvider(id, { env });
  }
  if (!provider) {
    const err = new Error(`unsupported review provider: ${id}`);
    err.code = "UNSUPPORTED_PROVIDER";
    throw err;
  }
  job.provider = provider.id;
  return provider;
}

function runProviderProcess({ provider, job, helpers, options, log }) {
  return new Promise((resolve, reject) => {
    const ee = provider.run({ ...options, bin: provider.bin, model: provider.model });
    job.agentPid = ee.pid || null;
    // Keep the old field populated for restored jobs and older clients. New
    // code uses agentPid and provider.
    job.claudePid = ee.pid || null;
    helpers.emit({
      kind: provider.id === "claude" ? "claude_started" : "agent_started",
      provider: provider.id,
      pid: ee.pid || null,
    });
    let lastResult = null;

    const onAbort = () => {
      log(`Cancellation requested, sending SIGTERM to ${provider.label}`);
      try { ee.kill("SIGTERM"); } catch {}
    };
    helpers.signal?.addEventListener("abort", onAbort, { once: true });

    ee.on("event", (event) => {
      if (event.kind === "result") lastResult = event;
      if (event.kind === "system" && event.model) job.model = event.model;
      if (event.kind === "tool_use" && event.tool === "Bash") {
        const outcome = detectOutcomeFromBashCommand(event.full?.command || event.summary || "");
        if (outcome) {
          job.outcome = outcome;
          helpers.emit({ kind: "outcome_detected", outcome });
        }
      }
      helpers.emit(event);
    });
    ee.on("error", (error) => {
      helpers.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`${provider.label} spawn error: ${error.message}`));
    });
    ee.on("exit", ({ code, signal, stderrTail }) => {
      helpers.signal?.removeEventListener("abort", onAbort);
      job.agentPid = null;
      job.claudePid = null;
      if (code === 0) return resolve({ result: lastResult });
      const err = new Error(
        `${provider.label} exited with code=${code} signal=${signal || "none"}.\nLast stderr:\n${stderrTail || "(empty)"}`,
      );
      // Keep the original Claude error code stable for clients and saved logs.
      err.code = provider.id === "claude" ? "CLAUDE_NONZERO" : "PROVIDER_NONZERO";
      reject(err);
    });
  });
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
  const provider = resolveJobProvider(job, config);

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
  let checkout = { sha: null, ref: null };
  let atPrHead = false;
  const repoPath = await withRepoLock(repoKey, async () => {
    helpers.emit({ kind: "phase", phase: "syncing_repo" });
    const rp = await ensureRepo({
      owner: meta.owner,
      repo: meta.repo,
      reposDir: config.reposDir,
      onLog: (m) => log(m),
    });
    await provider.prepareWorkspace(rp, { onLog: (m) => log(m) });

    helpers.emit({ kind: "phase", phase: "creating_worktree" });
    // Put the worktree on the PR head, not the base branch: the reviewer reads
    // whole files, and the review's file:line links point at the head SHA, so
    // reading the pre-change file would quote lines that don't line up. Doing
    // the fetch and the checkout here also keeps them out of claude's hands —
    // the reviewed repo's own permission rules can refuse a `git checkout`
    // outright, and a headless run has no one to approve it.
    const headRef = await fetchPrHead({
      repoPath: rp,
      prNumber: meta.number,
      headSha: meta.headRefOid,
      onLog: (m) => log(m),
    });
    atPrHead = !!headRef;
    checkout = await addWorktree({
      repoPath: rp,
      worktreePath,
      baseBranch: meta.baseRefName,
      ref: headRef,
      onLog: (m) => log(m),
    });
    return rp;
  });
  job.repoPath = repoPath;
  job.worktreePath = worktreePath;
  log(
    atPrHead
      ? `Worktree is at ${(checkout.sha || meta.headRefOid || "").slice(0, 8)} — the PR head.`
      : `Worktree is at the base branch ${meta.baseRefName} — the PR head couldn't be fetched, so file contents are pre-change.`,
  );
  helpers.emit({
    kind: "worktree_ready",
    path: worktreePath,
    sha: checkout.sha,
    atPrHead,
  });

  // 4. Resolve the project's review skill (so we can inline its body into
  //    the prompt — skills with `disable-model-invocation: true` can't be
  //    dispatched by the model via the Skill tool).
  // Read the project skill from the base branch, not the worktree: the worktree
  // is the PR's own code now, and the review playbook is not the PR's to edit.
  const { skill, attempted } = await resolveReviewSkill(worktreePath, {
    repoPath,
    baseRef: `origin/${meta.baseRefName}`,
    onLog: (m) => log(m),
    provider,
  });
  if (skill) {
    job.skill = { name: skill.name, path: skill.path, source: skill.source };
    helpers.emit({
      kind: "skill_resolved",
      name: skill.name,
      path: skill.path,
      pathDisplay: tildify(skill.path),
      source: skill.source, // "project" | "user" | "bundled"
      ref: skill.ref || null, // the git ref a project skill was read from
      bodyLength: skill.body.length,
    });
    const sourceWord =
      skill.source === "project"
        ? "project"
        : skill.source === "user"
          ? "user-level"
          : "bundled";
    log(
      `Using ${sourceWord} review skill: ${skill.name} (${tildify(skill.path)}${skill.ref ? ` @ ${skill.ref}` : ""})`,
    );
  } else {
    // Only reached if even the bundled skill is missing (corrupted install).
    helpers.emit({
      kind: "skill_missing",
      attempted: attempted.map((p) => tildify(p)),
    });
    log(`No review skill found anywhere (including bundled fallback) — running a generic review.`);
  }

  // 5. Spawn the selected provider in the worktree and stream normalized events.
  helpers.emit({ kind: "phase", phase: "reviewing" });
  const runStartedAt = Date.now();
  log(`Starting ${provider.label} in ${worktreePath}`);
  const result = await runProviderProcess({
    provider,
    job,
    helpers,
    log,
    options: {
      prUrl: meta.url,
      skill,
      approval,
      headSha: meta.headRefOid,
      headRepoOwner: meta.headRepoOwner,
      headRepoName: meta.headRepoName,
      triviality: meta.triviality,
      confidenceThreshold: config.confidenceThreshold,
      cwd: worktreePath,
      checkedOutSha: checkout.sha,
      atPrHead,
      baseBranch: meta.baseRefName,
    },
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
    provider: provider.id,
    durationMs: result.result?.durationMs,
    numTurns: result.result?.numTurns,
    totalCostUsd: result.result?.totalCostUsd,
    sessionId: result.result?.sessionId,
    finalText: result.result?.result,
    usage: result.result?.usage,
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
function buildVerifyPrompt({ meta, approval, checkout = null, providerLabel = "Claude" }) {
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
    // The worktree was rebuilt for this run, on the author's new head. Say so:
    // the resumed session remembers the OLD checkout, and the whole job is to
    // judge the new one.
    ...(checkout
      ? [
          ...workingTreeBlock({
            checkedOutSha: checkout.sha,
            atPrHead: checkout.atPrHead,
            baseBranch: meta.baseRefName,
          }),
          ``,
        ]
      : []),
    `${providerLabel} is running non-interactively without approval prompts. Execute the checks end to end.`,
  ].join("\n");
}

/**
 * Re-run a finished review to VALIDATE that the author addressed the comments,
 * by resuming the original provider session (not starting a fresh one). It
 * recreates the worktree at the same path and re-checks it out at the PR's
 * current head, which is the point of this run: the fixes we're verifying are
 * the commits the author pushed since the first pass.
 */
async function runVerifyJob(job, helpers, config) {
  const log = (msg, extra = {}) => helpers.emit({ kind: "log", message: msg, ...extra });
  const provider = resolveJobProvider(job, config);
  const sessionId = job.resumeSessionId || job.sessionId || job.summary?.sessionId;
  if (!sessionId) {
    const err = new Error(`no ${provider.label} session recorded, so this review cannot resume; run a fresh review instead.`);
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
  let checkout = { sha: null, ref: null };
  let atPrHead = false;
  const repoPath = await withRepoLock(repoKey, async () => {
    helpers.emit({ kind: "phase", phase: "syncing_repo" });
    const rp = await ensureRepo({ owner: meta.owner, repo: meta.repo, reposDir: config.reposDir, onLog: (m) => log(m) });
    await provider.prepareWorkspace(rp, { onLog: (m) => log(m) });
    helpers.emit({ kind: "phase", phase: "creating_worktree" });
    await removeWorktree({ repoPath: rp, worktreePath, onLog: () => {} }).catch(() => {}); // clear any leftover
    // The head has moved since the first pass — that's the point of this run —
    // so re-fetch it and land the worktree on the fixes we're verifying.
    const headRef = await fetchPrHead({ repoPath: rp, prNumber: meta.number, headSha: meta.headRefOid, onLog: (m) => log(m) });
    atPrHead = !!headRef;
    checkout = await addWorktree({ repoPath: rp, worktreePath, baseBranch: meta.baseRefName, ref: headRef, onLog: (m) => log(m) });
    return rp;
  });
  job.repoPath = repoPath;
  job.worktreePath = worktreePath;
  log(
    atPrHead
      ? `Worktree is at ${(checkout.sha || meta.headRefOid || "").slice(0, 8)} — the PR head.`
      : `Worktree is at the base branch ${meta.baseRefName} — the PR head couldn't be fetched, so file contents are pre-change.`,
  );
  helpers.emit({ kind: "worktree_ready", path: worktreePath, sha: checkout.sha, atPrHead });

  helpers.emit({ kind: "phase", phase: "reviewing" });
  const runStartedAt = Date.now();
  log(`Resuming ${provider.label} session ${sessionId.slice(0, 8)} in ${worktreePath}`);
  const verifyPrompt = buildVerifyPrompt({
    meta,
    approval,
    checkout: { sha: checkout.sha, atPrHead },
    providerLabel: provider.label,
  });

  const result = await runProviderProcess({
    provider,
    job,
    helpers,
    log,
    options: {
      prUrl: meta.url,
      cwd: worktreePath,
      resumeSessionId: sessionId,
      promptText: verifyPrompt,
    },
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
    provider: provider.id,
    durationMs: result.result?.durationMs, numTurns: result.result?.numTurns,
    totalCostUsd: result.result?.totalCostUsd, sessionId: result.result?.sessionId, finalText: result.result?.result,
    usage: result.result?.usage,
    rubric,
  });
  job.mode = null; // back to normal for any future action
}

// detectOutcomeFromBashCommand is exported for its tests — the shapes it has to
// recognise are a regression list, not an implementation detail.
module.exports = {
  runReviewJob,
  runVerifyJob,
  detectOutcomeFromBashCommand,
  buildVerifyPrompt,
  resolveJobProvider,
};
