---
name: prsnooze-default-review
description: Default PR-review playbook bundled with prsnooze. Used when the project being reviewed has no `aa-review-pr` / `review-pr` skill at the project or user level. Language-agnostic; respects whatever project conventions it finds.
---

# Default PR review (prsnooze)

A pragmatic, language-agnostic PR review playbook. You're running headlessly: no user, no interactive prompts. Execute every step in order.

## Inputs

- A GitHub PR URL is in the enclosing prompt.
- Current working directory is a fresh git worktree of the PR's base branch.

## Steps

### 1. Read the diff and the PR description

```sh
gh pr view  <N> --json title,body,baseRefName,headRefName,files,additions,deletions
gh pr diff  <N>
```

Read the title and description carefully — the description is the author's claim about what the PR does. Most of the review consists of checking that the diff matches that claim.

### 2. Discover project conventions

Look (in this order) for anything that constrains style/architecture:

- `CLAUDE.md` and `AGENTS.md` at repo root or under `.claude/`
- `.claude/settings.json` (allowed/denied tools, per-project)
- `CONTRIBUTING.md`, `README.md`
- Language-specific config: `.editorconfig`, `pyproject.toml`, `package.json` scripts, `Makefile`, `build.gradle`

**Project conventions outrank generic best practices.** If `CLAUDE.md` says "we use snake_case for module-level constants," don't flag camelCase as a finding here — that's not a defect in this project's frame.

### 3. Read the touched files in full

For each non-trivial file in `files[]`, read it (not just the hunks). Diffs lie — surrounding code can change a change's meaning. Skip giant generated files (lockfiles, snapshots).

### 4. Apply the universal checklist

Walk the diff with each lens in turn.

**Correctness**
- Does the code do what the PR description claims?
- Edge cases: null/undefined/empty, off-by-one, zero items, integer overflow
- Error handling: caught, propagated, or silently swallowed?
- Concurrency: shared state mutated safely? Races possible?

**Security**
- Hardcoded secrets (tokens, keys, credentials) — even in tests
- Injection: SQL, command, log, XSS, path traversal, SSRF
- Auth / authz changes — who can now do what they couldn't before?
- Sensitive data in logs, error messages, telemetry, URLs
- Cryptography: rolled-your-own vs library; weak algorithms

**Regressions**
- Removed behavior callers may still depend on
- Public-API contract changes (signature, return type, error semantics)
- Default values that flipped meaning

**Observability**
- New failure modes have logs / metrics
- Error messages help an on-call human (include context, not just "failed")

**Tests**
- New behavior has tests
- Tests verify behavior, not implementation details
- Edge cases and failure paths covered, not just the happy path
- Existing tests still pass conceptually (no `@Ignore` / `it.skip` slipped in)

**Performance**
- Quadratic loops where linear suffices
- N+1 queries in a request path
- Unnecessary allocations or copies in hot paths

**Clarity**
- Names match purpose; magic values extracted to constants
- Comments explain WHY (non-obvious constraints / decisions), never WHAT
- Dead code, commented-out blocks, debug prints removed

### 5. Tag every finding by severity

- 🔴 **Critical** — incidents, data loss, security holes
- 🟠 **Major** — correctness gap, regression risk, missing test coverage of a meaningful path, breaking change without migration
- 🟡 **Minor** — small bug unlikely to fire, redundant code, missing-but-non-critical log
- ⚪ **Nit** — naming, formatting, comment style

Use the *lowest* applicable severity. Inflated severity is noise.

### 6. Write the review body

Structure:

```markdown
## Summary
One sentence — what does this PR actually do?

## Findings

### 🔴 Critical
- `path/to/file.ext:LN` — issue. Why it matters. Suggested fix.

### 🟠 Major
- `path/to/file.ext:LN` — …

### 🟡 Minor
- `path/to/file.ext:LN` — …

(Skip any section that has no findings — don't write empty headers.)

## Verdict
One line — "Approve, no concerns." / "Needs the criticals fixed before merge."
```

If you find nothing of substance, say so explicitly: *"Reviewed the diff in full, no concerns found."* Empty reviews look like you didn't actually look.

### 7. Post the review — exactly once

Write the body to a temp file (avoids quoting hell), then post **one** call:

```sh
cat > /tmp/prsnooze-review-<N>.md <<'EOF'
…review body…
EOF
gh pr review <N> --comment --body-file /tmp/prsnooze-review-<N>.md
```

If the enclosing prsnooze prompt grants `--approve` authority (small PR, no criticality flags, no critical/major findings), use that verb instead:

```sh
gh pr review <N> --approve --body-file /tmp/prsnooze-review-<N>.md
```

**Trust gh's exit code**. If it returns success, your review is posted. Do **not** retry, do **not** also post a plain comment as a "backup". A failed post will exit non-zero — only then handle the error.

## What NOT to do

- Don't approve a PR you didn't actually read through.
- Don't post the same review twice for any reason.
- Don't ask the user clarifying questions. You're headless — there's nobody to ask.
- Don't refactor the PR's code yourself. You're a reviewer, not the author.
- Don't be exhaustive about nits. Five nits drown out one critical.
- Don't speculate ("could maybe fail under X if Y"). Say it concretely or skip it.
