const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

function approvalBlock(approvalCtx) {
  const { autoApprove, sizeOk, stats, maxLines, maxFiles } = approvalCtx;

  if (!autoApprove) {
    return [
      "Post the review as `gh pr review <N> --comment --body <file>`.",
      "Do not approve or request changes.",
    ];
  }
  if (!sizeOk) {
    const prodLines = (stats?.prodAdditions ?? 0) + (stats?.prodDeletions ?? 0);
    return [
      "APPROVAL POLICY (auto-approve disabled for this PR — too much prod code):",
      `  ${prodLines} prod lines across ${stats?.prodFiles ?? "?"} prod files`,
      `  (threshold for auto-approve: ≤${maxLines} prod lines AND ≤${maxFiles} prod files;`,
      "   test files are excluded from the count).",
      "Post via `gh pr review <N> --comment --body <file>`. Do NOT approve,",
      "even if you find no issues. Bigger prod changes need human eyes.",
    ];
  }
  return [
    "APPROVAL POLICY (auto-approve enabled — small PR by prod-code count,",
    "criticality check below). Note: test files are exempt from the size",
    "gate; the system already filtered them out before reaching you. So a",
    "large test churn does NOT block approval on size grounds.",
    "",
    "You MAY use `gh pr review <N> --approve --body <file>` ONLY IF ALL hold:",
    "  (a) No critical and no major issues. (minor / nit / style only, or",
    "      nothing at all, is fine.)",
    "  (b) NO criticality red flags in the diff. Treat ANY of these as",
    "      automatic 'don't approve, just comment':",
    "        • auth / authn / authz / sessions / tokens / credentials",
    "        • payments / billing / money handling / invoicing",
    "        • DB schema, migration, or data-shape changes",
    "        • CI/CD, build scripts, deployment configs, infra-as-code",
    "        • public-API removal or signature change",
    "        • non-trivial refactor that changes call-site behavior",
    "        • adding, removing, or version-bumping a dependency",
    "        • anything where a regression could happen and you can't",
    "          bound the blast radius from the diff alone",
    "",
    "Otherwise (any red flag, or any critical/major issue), post via",
    "`gh pr review <N> --comment --body <file>` even if you found no",
    "individual issues. The rule: bigger or risky → review only, no",
    "approval. Be conservative — when in doubt, comment, don't approve.",
    "",
    "Severity reminder: 'major' = correctness, security, data loss, or",
    "breaking-change risk. 'minor / nit / style' alone does NOT block",
    "approval — but the red flags above DO, independently of severity.",
    "",
    "Pick exactly ONE call. Do not also post a plain comment.",
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
  ];

  if (typeof confidenceThreshold === "number" && confidenceThreshold > 0) {
    lines.push(
      `Confidence threshold: only surface findings you are ≥ ${confidenceThreshold}%`,
      "confident are real defects in this codebase. Below that, drop them",
      "silently — your job is to be a high-signal reviewer, not a comprehensive",
      "one. Calibrate honestly: for clear correctness/security issues you'll",
      "usually be at >90%. Don't downgrade an obvious finding because you're",
      "unsure how the team will react.",
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
  approval: approvalCtx = { autoApprove: true, sizeOk: true },
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
}) {
  const ee = new EventEmitter();
  const prompt = buildPrompt({
    prUrl,
    skill,
    approval,
    headSha,
    headRepoOwner,
    headRepoName,
    triviality,
    confidenceThreshold,
  });

  const args = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  const child = spawn(claudeBin, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  ee.pid = child.pid;
  ee.kill = (sig = "SIGTERM") => child.kill(sig);

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
