# prsnooze — specs

A self-serve browser app that lets colleagues request a PR review from "virtual Ahsan". They paste a GitHub PR URL; the host machine (with `claude`, `gh`, and SSH already authenticated) creates a git worktree from the PR's base branch, runs Claude Code headlessly with the `aa-review-pr` skill (or `review-pr` fallback), streams progress live to the browser, and lets the skill post review comments back to GitHub.

## Workflow per review

1. Colleague submits PR URL via web form.
2. Server enqueues job, returns `jobId`. Browser opens an SSE stream for live tail.
3. Worker dequeues:
   - `gh pr view <url> --json …` — extract owner, repo, baseRefName, state, title.
   - Reject if PR is closed/merged or `gh` can't see it.
   - Ensure repo cloned at `./repos/<owner>/<repo>` (clone if absent, fetch if present).
   - `git worktree add ./worktrees/<jobId> origin/<baseBranch>`.
   - **Resolve the project review skill**: look for `<worktree>/.claude/skills/aa-review-pr/SKILL.md`, then `review-pr/SKILL.md`, then the same names at `~/.claude/skills/`. Strip frontmatter and inline the body into the prompt (skills with `disable-model-invocation: true` can't be dispatched by the model via the Skill tool — inlining is the workaround).
   - Spawn `claude -p "<prompt with PR URL + inlined skill body + headless overrides>" --dangerously-skip-permissions --output-format stream-json --verbose` in the worktree.
   - Parse NDJSON output, forward summarized events over SSE, persist all events to `outputs/jobs/<jobId>.json`.
   - On success: remove worktree. On failure: keep worktree, surface its path in the error message.
4. The skill itself posts comments to GitHub via `gh` (uses the host's `gh` identity).

## Decisions

- **Repo storage**: prsnooze manages its own clones under `./repos/<owner>/<repo>`. No dependency on user's existing checkouts.
- **Concurrency**: single-worker FIFO queue. One review at a time.
- **Worktree cleanup**: auto-delete on success, keep on failure (debugging).
- **Auth**: none. Bind `0.0.0.0`, trust LAN/Tailscale.
- **Live UX**: SSE with `--output-format stream-json --verbose`. Browser sees Claude's tool calls in real time.

## State machine

```
queued → resolving → cloning|fetching → worktree → reviewing → cleanup → done
                                                           ↓
                                                        failed (any step)
```

## HTTP API

- `POST /api/review {prUrl}` → `{jobId}`
- `GET  /api/jobs` → list of recent jobs (most recent first)
- `GET  /api/jobs/:id` → full job state
- `GET  /api/jobs/:id/events` → SSE stream (replays buffered events on connect, then live)
- `GET  /` → static SPA

## Layout

```
.
├── package.json
├── .env.example
├── .gitignore
├── server.js
├── lib/
│   ├── queue.js
│   ├── review-job.js
│   ├── git-ops.js
│   ├── github.js
│   └── claude-runner.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── repos/        # runtime, gitignored
├── worktrees/    # runtime, gitignored
└── outputs/
    └── jobs/<jobId>.json
```

## Out of scope (v1)

- GitHub webhook auto-trigger on PR open
- Multi-tenant auth
- Docker packaging
- Persistent queue / restart recovery
- Automatic retries

## Reference

The `claude -p` browser-wrapper pattern is borrowed from `/Volumes/Work/Personal/repos/ccfire`. prsnooze keeps the bones (Express, vanilla JS, `child_process.spawn`, on-disk job log) and replaces the multi-turn chat workflow with one-shot PR reviews.
