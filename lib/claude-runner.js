const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

function approvalBlock(approvalCtx) {
  const { autoApprove, matchedTests = [] } = approvalCtx;

  if (!autoApprove) {
    return [
      "Post the review as `gh pr review <N> --comment --body <file>`.",
      "Do not approve or request changes.",
    ];
  }

  const testHint =
    matchedTests.length > 0
      ? `The PR touches matching-name test files for these prod files: ${matchedTests.join(", ")}. Apply the matching-name test reducer (−15) when scoring.`
      : "No matching-name test files were changed alongside prod files in this PR.";

  return [
    "APPROVAL POLICY (auto-approve enabled). PR size does not gate approval.",
    "Findings + a criticality risk score decide the call.",
    "",
    "━━━ STEP 1 — Detect red-flag hits (real behavior changes, not adjacency) ━━━",
    "",
    "For each category below, ask: \"Does this diff CHANGE the behavior of X,",
    "or does it just edit files near X?\" Only real behavior changes count.",
    "",
    "  Not a hit (examples):",
    "    - typo fix in an error message inside an auth-related file",
    "    - added // TODO or /* */ comment in a migration file",
    "    - renamed a private helper method with all callers updated in the diff",
    "    - patch version bump of a dep already present, no code changes",
    "",
    "  Hit (examples):",
    "    - added, removed, or reordered a permission/auth check",
    "    - changed how a token is minted, stored, or validated",
    "    - modified DDL (CREATE, ALTER, DROP) in a migration",
    "    - major version bump of a framework dep",
    "    - renamed/removed a symbol used across multiple files",
    "",
    "Categories:",
    "  (T1) Auth / authn / authz / sessions / tokens / credentials",
    "  (T2) Payments / billing / money handling / invoicing",
    "  (T3) DB schema, migration, or data-shape changes",
    "  (M1) CI/CD, build scripts, deployment configs, infra-as-code",
    "  (M2) Public-API removal or signature change",
    "  (M3) Non-trivial refactor changing call-site behavior",
    "  (M4) Dep add/remove/version-bump",
    "  (M5) New endpoint or public API added",
    "  (U1) Unbounded blast radius — you can't tell from the diff who's affected",
    "",
    "━━━ STEP 2 — Compute the risk score ━━━",
    "",
    "Start at 0. For each REAL hit from Step 1:",
    "",
    "  T1 auth / T2 payments / T3 migration:  +50",
    "  M1 CI/CD:                              +30",
    "  M2 public API break:                   +30",
    "  M3 real refactor:                      +20",
    "  M4 dep bump:  major +25 / minor +10 / patch +2",
    "  M5 new endpoint:                       +20",
    "  U1 unbounded blast radius:             +15 (compounding — add per unclear scope)",
    "",
    "Then apply reducers (negative points):",
    "",
    "  Diff is comments-only / formatting-only / rename-only:    −25",
    "  Diff is test-files-only or docs-only:                     −20",
    "  Matching-name tests changed in same PR (from context):    −15",
    "  New tests added exercising the changed paths:             −10",
    "",
    `Context for the reducer: ${testHint}`,
    "",
    "REDUCER CAP: If any of T1, T2, T3 fired in Step 1, reducers can subtract",
    "at most −20 total. A real top-3 change never auto-approves.",
    "",
    "━━━ STEP 3 — Decide ━━━",
    "",
    "  Score ≤ 20  → `gh pr review <N> --approve --body <file>`",
    "  Score 21–60 → `gh pr review <N> --comment --body <file>`",
    "  Score > 60  → `gh pr review <N> --comment --body <file>`",
    "                AND prepend the review body with a warning banner:",
    "                > ⚠️ **High-risk change** — score X, hits: [comma-list of category codes]",
    "",
    "━━━ Override — \"when in doubt, comment\" ━━━",
    "",
    "If you are uncertain whether a change is a real hit vs. adjacency, or",
    "whether the blast radius is bounded, err toward hitting it and toward",
    "unbounded. The cost of a false approval is much higher than the cost of",
    "a false comment. Never let sub-20 scores come from a judgment call you",
    "weren't confident about.",
    "",
    "━━━ Findings gate (unchanged, overrides score) ━━━",
    "",
    "If you found any critical or major issues, ignore the score entirely and",
    "post `--comment`. Findings block approval regardless of score.",
    "",
    "━━━ Reporting ━━━",
    "",
    "In your final message back to prsnooze (NOT in the PR review body itself,",
    "unless it's the high-risk banner), state on a single line:",
    "  APPROVAL: <approve|comment> — score=<N>, hits=[<codes>], reducers=[<codes>]",
    "So the UI can display the reasoning. Example:",
    "  APPROVAL: comment — score=50, hits=[T1], reducers=[]",
    "  APPROVAL: approve — score=5, hits=[M4-patch], reducers=[matching-tests]",
    "",
    "Pick exactly ONE gh call. Do not also post a plain comment.",
  ];
}

function defaultPreferencesBlock({
  confidenceThreshold,
  headSha,
  headRepoOwner,
  headRepoName,
  triviality,
}) {
  const lines = [
    "────────── DEFAULT PREFERENCES ──────────",
    "These are prsnooze's defaults. THE INLINED SKILL BELOW IS AUTHORITATIVE",
    "— wherever it specifies something different, FOLLOW THE SKILL. These",
    "defaults only fill gaps the skill doesn't address.",
    "",
    "DEDUP (critical — never skipped, even if the skill is silent on it):",
    "Before writing ANYTHING, read what's already been said on this PR:",
    "  1. `gh pr view <N> --json reviews,comments`",
    "       → review summaries (with body + state) + PR-level comments",
    "  2. `gh api repos/{owner}/{repo}/pulls/{N}/comments`",
    "       → inline line-anchored review comments (path, line, body)",
    "  3. Optional (for resolved-thread detection):",
    "       gh api graphql -f query='query{repository(owner:\"O\",name:\"R\"){",
    "       pullRequest(number:N){reviewThreads(first:100){nodes{isResolved,",
    "       comments(first:100){nodes{body,path,line,author{login}}}}}}}}'",
    "",
    "Catalog what's been raised — paths, line numbers, paraphrased concerns,",
    "code citations. You will NOT re-raise anything already there, not even",
    "with different wording. Same concern + different phrasing = a duplicate.",
    "Drop it. If a thread is marked RESOLVED, the concern was addressed —",
    "definitely don't re-raise it.",
    "",
    "If every concern you'd raise is already covered: DO NOT POST ANYTHING.",
    "Posting a \"no new issues\" comment is itself PR clutter — don't do it.",
    "Just say so in your final message (which goes back to the prsnooze UI,",
    "not the PR) and exit. Skip the `gh pr review` / `gh pr comment` step",
    "entirely. The absence of a comment is the signal that nothing's new.",
    "",
    "REVIEW STYLE (default — skill may override format details):",
    "  - Output only actionable findings anchored to `file:line`.",
    "  - Each finding = ONE sentence + a `Fix:` with a specific change",
    "    a tool or dev can implement immediately.",
    "  - No prose intros, no \"Review summary\" with description of the PR,",
    "    no \"Things I deliberately did NOT flag\" sections, no \"Verdict\"",
    "    paragraphs, no review-meta lines (\"Review confidence: X/10\",",
    "    \"Self-review:\", \"Test signal:\", \"Scope skipped:\", etc.).",
    "  - No praise. The absence of findings is the praise.",
    "  - Drop nits entirely. Drop minors unless the PR is small AND there",
    "    are no majors/criticals.",
    "  - If a finding lacks file:line or a concrete fix → drop it. Vibes",
    "    don't ship.",
    "",
  ];

  if (typeof confidenceThreshold === "number" && confidenceThreshold > 0) {
    lines.push(
      `Confidence threshold: only surface findings you are ≥ ${confidenceThreshold}%`,
      "confident are real defects in this codebase. Below that, drop them",
      "silently. Calibrate honestly: for clear correctness/security issues",
      "you'll usually be at >90%. Don't downgrade an obvious finding.",
      "",
    );
  }

  if (headSha && headRepoOwner && headRepoName) {
    lines.push(
      "Location format: when citing line numbers in findings, prefer",
      "clickable links over plain paths:",
      `  https://github.com/${headRepoOwner}/${headRepoName}/blob/${headSha}/<path>#L<line>`,
      "or `…#L<start>-L<end>` for ranges. The SHA is pinned so the link",
      "doesn't drift if the branch advances.",
      "",
    );
  }

  if (triviality?.kind === "docs") {
    lines.push(
      "Triviality hint: every changed file in this PR is documentation",
      "(README/CHANGELOG/markdown). Keep the review terse and skip prose-level",
      "nits. A 1-line approval body is fine.",
      "",
    );
  } else if (triviality?.kind === "deps") {
    lines.push(
      "Triviality hint: every changed file in this PR is a dependency",
      "manifest or lockfile (package.json, go.sum, pom.xml, etc). Focus",
      "ONLY on: known-vulnerable versions, major-version bumps with",
      "breaking changes, license incompatibilities. Skip everything else.",
      "",
    );
  }

  lines.push("─────────────────────────────────────────");
  return lines;
}

function buildPrompt({
  prUrl,
  skill,
  approval: approvalCtx = { autoApprove: true, matchedTests: [] },
  headSha,
  headRepoOwner,
  headRepoName,
  triviality,
  confidenceThreshold = 80,
}) {
  const approval = approvalBlock(approvalCtx);
  const defaults = defaultPreferencesBlock({
    confidenceThreshold,
    headSha,
    headRepoOwner,
    headRepoName,
    triviality,
  });

  if (skill && skill.body) {
    const sourceLabel =
      skill.source === "project"
        ? "the project's PR-review skill (checked into this repo)"
        : skill.source === "user"
          ? "your user-level PR-review skill (~/.claude/skills/)"
          : "the bundled prsnooze default PR-review skill";
    return [
      `Review this pull request: ${prUrl}`,
      "",
      `The instructions below are ${sourceLabel} (\`${skill.name}\`),`,
      `copied into this message because skill dispatch via the Skill tool`,
      `is unreliable here — do not try to invoke any Skill yourself.`,
      `Treat every step as binding.`,
      "",
      "────────── HEADLESS-MODE OVERRIDES ──────────",
      "The skill assumes an interactive user. You have none. When the skill says:",
      `  - "ask which PR" → use ${prUrl}; do NOT ask.`,
      "  - \"ask which comments to post\" → post every critical and major item;",
      "    skip nits / style-only notes.",
      "  - any other clarifying question → proceed with the most reasonable",
      "    interpretation; do not stop.",
      "Post exactly ONE review to the PR. If `gh` returns success metadata,",
      "trust it — do not retry.",
      "",
      ...approval,
      "─────────────────────────────────────────────",
      "",
      ...defaults,
      "",
      `────────── PROJECT SKILL (AUTHORITATIVE — supersedes defaults above): ${skill.name} ──────────`,
      skill.body.trim(),
      "─────────────────────────────────────────────────────────────────────────",
      "",
      "You are running with --dangerously-skip-permissions. Do not ask for",
      "tool confirmation. Execute the steps end to end.",
    ].join("\n");
  }

  // Fallback: even the bundled skill was unreadable (broken install).
  return [
    `Review this pull request: ${prUrl}`,
    "",
    "NOTE: No review skill resolved (including the bundled prsnooze default).",
    "This usually means a broken install. Doing a generic review.",
    "",
    "Read the diff with `gh pr diff`, explore the touched files, and post a",
    "single, well-structured review — not multiple. Cover correctness,",
    "security, observability, and tests.",
    "",
    ...approval,
    "",
    ...defaults,
    "",
    "You are running with --dangerously-skip-permissions. Do not ask for",
    "tool confirmation. Execute the review end to end.",
  ].join("\n");
}

function summarizeToolUse(item) {
  const name = item.name || "tool";
  const input = item.input || {};
  if (name === "Bash" && typeof input.command === "string") {
    return { tool: name, summary: input.command.slice(0, 240), full: input };
  }
  if ((name === "Read" || name === "Edit" || name === "Write") && input.file_path) {
    return { tool: name, summary: input.file_path, full: input };
  }
  if (name === "Grep" && input.pattern) {
    const where = input.path ? ` in ${input.path}` : "";
    return { tool: name, summary: `${input.pattern}${where}`, full: input };
  }
  if (name === "Glob" && input.pattern) {
    return { tool: name, summary: input.pattern, full: input };
  }
  if (name === "WebFetch" && input.url) {
    return { tool: name, summary: input.url, full: input };
  }
  // Generic fallback: short JSON preview
  let summary = "";
  try {
    summary = JSON.stringify(input).slice(0, 240);
  } catch {
    summary = "";
  }
  return { tool: name, summary, full: input };
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && c.type === "tool_use").map(summarizeToolUse);
}

/**
 * Run claude headlessly in a worktree. Returns an EventEmitter that emits:
 *   "event" -> { kind, ...payload }   for every parsed event
 *   "exit"  -> { code, signal }
 *   "error" -> Error                  for spawn-level errors
 *
 * kinds: "system", "assistant_text", "tool_use", "tool_result", "result", "raw_unparseable", "stderr"
 */
function runClaude({
  prUrl,
  skill = null,
  approval = null,
  headSha,
  headRepoOwner,
  headRepoName,
  triviality,
  confidenceThreshold = 80,
  cwd,
  claudeBin = "claude",
  resumeSessionId = null,
  promptText = null,
}) {
  const ee = new EventEmitter();
  // promptText (used by "verify fixes") overrides the built review prompt.
  const prompt =
    promptText ||
    buildPrompt({
      prUrl,
      skill,
      approval,
      headSha,
      headRepoOwner,
      headRepoName,
      triviality,
      confidenceThreshold,
    });

  // With resumeSessionId we resume the ORIGINAL review conversation instead of
  // starting a fresh one, so Claude keeps its full context.
  const args = (resumeSessionId ? ["--resume", resumeSessionId] : []).concat([
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);

  const child = spawn(claudeBin, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group (session leader) so a single signal to the negative
    // PID reaps the whole tree — claude plus the gh/git/ripgrep/MCP helpers it
    // spawns — instead of leaving orphaned grandchildren behind.
    detached: true,
  });

  ee.pid = child.pid;
  ee.kill = (sig = "SIGTERM") => {
    // Signal the whole process group first; fall back to the lone child if the
    // group send fails (e.g. it already exited).
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };

  let stdoutBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      handleLine(line);
    }
  });

  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
    ee.emit("event", { kind: "stderr", text: chunk });
  });

  child.on("error", (e) => ee.emit("error", e));
  child.on("close", (code, signal) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
    ee.emit("exit", { code, signal, stderrTail: stderrBuf.split("\n").slice(-50).join("\n") });
  });

  function handleLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      ee.emit("event", { kind: "raw_unparseable", line });
      return;
    }
    const t = obj.type;
    if (t === "system") {
      ee.emit("event", {
        kind: "system",
        subtype: obj.subtype,
        sessionId: obj.session_id,
        model: obj.model,
        cwd: obj.cwd,
        tools: obj.tools,
      });
      return;
    }
    if (t === "assistant" && obj.message) {
      const text = extractAssistantText(obj.message.content);
      if (text) ee.emit("event", { kind: "assistant_text", text });
      for (const tu of extractToolUses(obj.message.content)) {
        ee.emit("event", { kind: "tool_use", ...tu });
      }
      return;
    }
    if (t === "user" && obj.message) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === "tool_result") {
            const out =
              typeof c.content === "string"
                ? c.content
                : Array.isArray(c.content)
                  ? c.content
                      .map((x) => (typeof x?.text === "string" ? x.text : ""))
                      .join("")
                  : "";
            ee.emit("event", {
              kind: "tool_result",
              isError: !!c.is_error,
              preview: out.slice(0, 400),
              length: out.length,
            });
          }
        }
      }
      return;
    }
    if (t === "result") {
      ee.emit("event", {
        kind: "result",
        isError: !!obj.is_error,
        result: obj.result,
        durationMs: obj.duration_ms,
        totalCostUsd: obj.total_cost_usd,
        numTurns: obj.num_turns,
        usage: obj.usage,
        sessionId: obj.session_id,
      });
      return;
    }
    ee.emit("event", { kind: "other", raw: obj });
  }

  return ee;
}

module.exports = { runClaude, buildPrompt };
