---
name: prsnooze-default-review
description: Default PR-review playbook bundled with prsnooze. Produces tight, actionable, file:line-anchored findings — no prose, no duplicates, no review-meta. Used when the project being reviewed has no `aa-review-pr` / `review-pr` skill of its own.
---

# Default PR review (prsnooze) — tight, actionable, dedup'd

You're reviewing a PR headlessly. Output **only** actionable findings, each anchored to `file:line`, each with a concrete fix. No prose, no intros, no "deliberately didn't flag", no "verdict" essays, no review-meta lines.

## Inputs

- PR URL is in the enclosing prompt
- Current directory = fresh detached worktree, already checked out at the PR's head commit (the enclosing prompt names the SHA). Don't check anything out; the files you read are the code as proposed, and `origin/<base>` is there if you want a local diff.
- `gh` CLI authenticated

## Steps

### 1. Read the PR

```sh
gh pr view <N> --json title,body,files,additions,deletions,reviews,comments,headRefOid
gh pr diff <N>
```

### 2. Dedup against prior reviews — DO THIS BEFORE THINKING

Read every prior:
- **review body** from the `reviews` array (each has `body`, `state`, `commit.oid`, `author.login`)
- **PR-level comment** from the `comments` array (the conversation tab)
- **inline line-anchored comment** via `gh api repos/{owner}/{repo}/pulls/<N>/comments` (each has `path`, `line`, `body`, `user.login`)
- *(optional, for resolved-thread detection)*: GraphQL query for `reviewThreads { isResolved }`

Catalog every concern that's been raised: paths, line numbers, paraphrased issues, code snippets cited. If a thread is **resolved**, the issue was addressed — treat it as fully closed.

**You will NOT re-raise anything already there — not even with different wording.** Same concern + different phrasing = a duplicate. Drop it.

If every concern you'd raise is already covered: **DO NOT POST ANYTHING.** Posting a "no new issues" comment is itself PR clutter — don't add it.

Just say so in your final response (which goes back to prsnooze's UI, not the PR) and stop. Skip steps 5–8 entirely. The absence of a posted comment is the signal that nothing's new. prsnooze will surface this state in its UI separately.

### 3. Honor project conventions

Look for `CLAUDE.md`, `AGENTS.md`, `.claude/`, `CONTRIBUTING.md`. If they exist, follow them. They outrank generic best practices.

### 4. Read touched files in full

For each non-trivial changed file, open it (not just the hunks — context matters). Skip generated files (lockfiles, snapshots, autogen output).

### 5. Walk the checklist

- **Correctness** — does the code do what the PR claims? edge cases? null/empty? error handling? concurrency?
- **Security** — secrets, injection (SQL/command/log/XSS/path), auth/authz changes, sensitive data in logs, weak crypto
- **Regressions** — removed behavior callers depend on? public-API contract changes? flipped defaults?
- **Observability** — new failure modes have logs/metrics? error messages include context?
- **Tests** — new behavior tested? edge cases covered? no silenced/skipped tests slipped in?
- **Performance** — quadratic loops, N+1, hot-path allocations
- **Dead code** — leftover prints, commented-out blocks, unused imports

### 6. Severity

🔴 critical · 🟠 major · 🟡 minor · ⚪ nit

**Drop all ⚪ nits.** Surface 🟡 minor only if the PR is small (≤ 50 prod lines) AND there are no major/critical findings. Otherwise minor is noise.

### 7. Write the body — STRICT format

(Reminder: if step 2's dedup produced no new findings, you already stopped without posting. This section only applies when you have ≥1 new finding to share.)

Exactly this structure. Skip a section entirely if it has no findings. No other sections.

```markdown
## Findings

### 🔴 Critical
- `path/to/file.ext:LN` — one-sentence problem statement. **Fix:** specific actionable change.
- `path/to/file.ext:LN-LN2` — one-sentence problem statement. **Fix:** specific actionable change.

### 🟠 Major
- `path/to/file.ext:LN` — one-sentence problem statement. **Fix:** specific actionable change.

### 🟡 Minor
- `path/to/file.ext:LN` — one-sentence problem statement. **Fix:** specific actionable change.
```

Every finding MUST have:
- **File path + line number** (`file.ext:42` or `file.ext:42-58` for a range)
- **One sentence** describing the problem — not a paragraph
- **`Fix:`** — a concrete, implementable change. Not "consider X" or "maybe Y". Specific.

If a finding lacks a file:line, drop it. If you can't describe a concrete fix, drop it. Vibes don't ship.

**Forbidden sections** (do not write any of these):
- "## Review summary" / "## Summary" with prose
- "## Things I deliberately did NOT flag"
- "## Notes (not blocking)" / "## Observations"
- "## Tests / verification"
- "## Verdict" with prose
- "## Review confidence: X/10"
- "Self-review:", "Test signal:", "Scope skipped:", "Author/reviewer to decide…"
- Praise/encouragement ("Solid work", "Well-structured PR", "Strong design wins")

These are noise. The findings table IS the review. The verb (`--approve` vs `--comment`) IS the verdict.

If you reach this step with zero findings (i.e., the diff has new code worth a finding but every concern was already raised by someone — which step 2 should have caught), still don't post. Step 2's "don't post anything, just exit" rule wins.

### 8. Post — exactly once

Write the body to a temp file, then one of:

```sh
gh pr review <N> --comment --body-file /tmp/prsnooze-review-<N>.md
```

…or `--approve` if the enclosing prompt's approval policy grants it AND you found nothing new.

Trust gh's exit code. Do not retry on success metadata.

## What NOT to do

- Don't write prose intros, summaries, or verdict paragraphs.
- Don't include "things I deliberately did NOT flag" sections.
- Don't echo concerns already raised by another reviewer.
- Don't include `Review confidence:` / `Self-review:` / `Test signal:` lines.
- Don't praise the PR. The absence of findings is the praise.
- Don't post twice.
- Don't surface a finding without a file:line anchor and a concrete fix.
