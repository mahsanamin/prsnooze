# prsnooze

> 👀 You snooze. It reviews. A browser-based PR reviewer that runs Claude Code headlessly on your machine.

A teammate pastes a GitHub PR URL into a web form. The host machine — already logged into Claude Code, `gh`, and SSH — clones the repo, makes a fresh worktree from the PR's base branch, runs `claude -p` with the project's review skill, streams the live tool calls to the browser, and posts review comments back to GitHub. While you sleep.

---

## ⚠️  Read this first — safety

prsnooze runs **`claude --dangerously-skip-permissions`**. That means:

- Claude has full file, network, and tool access in the worktree with **no confirmation prompts**.
- Anyone who can reach the web UI can trigger a Claude session on your machine.
- The host's `gh` identity is who posts reviews on GitHub. Anyone using prsnooze is effectively reviewing-as-you.

To run this safely:

1. **Don't expose the web UI to the public internet.** Bind to LAN or Tailscale. There is no auth.
2. **Use a fine-grained GitHub PAT**, not a classic admin token, scoped to:
   - the specific repos you want reviewed,
   - "Pull requests: Read and write" + "Contents: Read".
   Set it via `gh auth login` (pick "Token") or environment variable.
3. **Vet the review skill.** `aa-review-pr` / `review-pr` is what actually reads code and posts comments. Read it before trusting it.
4. **Run on a machine you don't mind issuing networked actions on your behalf.**

**Use at your own risk.**

---

## How it works

```mermaid
sequenceDiagram
  participant U as Teammate
  participant W as Web UI
  participant S as Server
  participant CL as claude -p
  participant GH as GitHub

  U->>W: paste PR URL
  W->>S: POST /api/review
  S->>GH: gh pr view (resolve base branch)
  S->>S: clone or fetch repo, git worktree add
  S->>CL: spawn in worktree (stream-json, auto-approval)
  CL-->>W: live tool calls via SSE
  CL->>GH: skill posts review
  S->>S: remove worktree (success) / keep (failure)
```

Project-level rules are honored automatically: the worktree is a full checkout, so `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, and `.claude/settings.json` from the repo are picked up by Claude Code as usual. The prompt explicitly nudges Claude to follow them.

---

## Two ways to run

### Local quickstart (no Docker)

```sh
git clone https://github.com/<you>/prsnooze.git
cd prsnooze
npm install
npm start
```

`npm start` runs preflight checks (Node, git, claude, claude login, gh, gh auth, GitHub SSH, data dir writable), prints the safety warning, and starts the server.

Data lives in `~/.prsnooze/` (clones, worktrees, job state) — out of the project tree.

### Docker (recommended for shared deployments)

The Docker image bundles `node`, `git`, `gh`, and Claude Code — colleagues can deploy without setting up any of those locally.

```sh
git clone https://github.com/<you>/prsnooze.git
cd prsnooze

bin/docker-server start          # build + start in background
bin/docker-server claude-login   # one-time: complete Claude OAuth
bin/docker-server gh-login       # one-time: gh auth (use a fine-grained PAT)
```

Then visit **http://localhost:8284**.

| Command | Purpose |
|---|---|
| `bin/docker-server start` | build (if needed) + start in background |
| `bin/docker-server stop` | stop the container |
| `bin/docker-server restart` | restart without rebuild |
| `bin/docker-server rebuild` | rebuild image, recreate container |
| `bin/docker-server ssh` | drop into a bash shell inside the container |
| `bin/docker-server claude-login` | run `claude` interactively to log in |
| `bin/docker-server gh-login` | run `gh auth login` |
| `bin/docker-server logs` | tail container logs |
| `bin/docker-server status` | show container status |
| `bin/docker-server url` | print the listen URL |

Each is also available as `npm run docker:<command>`.

Auth and data persist in named docker volumes (`prsnooze-claude`, `prsnooze-gh`, `prsnooze-data`) — `rebuild` does **not** wipe your login or your cached repos. To reset everything:

```sh
docker compose down -v
docker volume rm prsnooze-claude prsnooze-gh prsnooze-data
```

---

## Requirements

| | Local | Docker |
|---|---|---|
| Node.js ≥ 20 | host needs it | bundled |
| `claude` CLI + login | host needs it | bundled, log in via `docker-server claude-login` |
| `gh` CLI + auth | host needs it | bundled, log in via `docker-server gh-login` |
| git + SSH | host needs it (SSH for clones) | bundled, but uses HTTPS via gh token |
| Review skill | (optional — bundled default used if none) | (optional — bundled default used if none) |

---

## GitHub authentication

prsnooze posts reviews **as the user the host is logged in as**. Use the smallest credential that works:

- **Recommended: fine-grained Personal Access Token** (https://github.com/settings/personal-access-tokens). Scope to the specific repos you want reviewed, with:
  - **Pull requests: Read and write** (post review comments)
  - **Contents: Read** (read the diff)
- Set via `gh auth login` → choose "Paste an authentication token" and paste the PAT.
- Avoid **classic** PATs unless you can't help it — they grant access to all your repos.

If you use SSH for cloning (local mode), make sure your SSH key is registered: https://github.com/settings/keys.

---

## Configuration

Defaults are in `.env.example`. Anything in `.env` overrides them.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8284` | HTTP port |
| `PRSNOOZE_HOME` | `~/.prsnooze` | Root for repos / worktrees / outputs |
| `REPOS_DIR` | `$PRSNOOZE_HOME/repos` | Where repos are cloned |
| `WORKTREES_DIR` | `$PRSNOOZE_HOME/worktrees` | Where worktrees are added |
| `OUTPUTS_DIR` | `$PRSNOOZE_HOME/outputs` | Where job state is persisted |
| `KEEP_WORKTREES_ON_SUCCESS` | `false` | If `true`, keep worktrees after a successful review |
| `CLAUDE_BIN` | `claude` | Path to the claude CLI |
| `AUTO_APPROVE` | `true` | If `true`, the reviewer **approves** PRs that are small, clean, and low-risk (no critical/major issues AND none of the criticality red flags — see below). Otherwise the review is posted via `--comment`. |
| `AUTO_APPROVE_MAX_LINES` | `100` | Max **production** lines (`additions + deletions`, test files excluded). Over this → review-only. |
| `AUTO_APPROVE_MAX_FILES` | `5` | Max **production** files changed. Over this → review-only. |
| `CONFIDENCE_THRESHOLD` | `80` | Default noise filter — findings below this confidence are dropped. **The project's review skill takes precedence**: if the inlined skill defines its own filter, that wins. Set `0` to disable. |
| `SKIP_IF_ALREADY_REVIEWED` | `true` | If your gh user already posted a review on the same commit SHA, skip without spawning Claude. Prevents accidental double-reviews on resubmits. |
| `HERO_IMAGE` | `/heroes/sleepy-cat.svg` | Landscape image on the home page (path or URL) |

### How auto-approval decides

Auto-approve fires (`gh pr review --approve`) only when **all** of the following hold:

1. `AUTO_APPROVE=true` in your config.
2. The PR is small **in production code**: `prodAdditions + prodDeletions ≤ AUTO_APPROVE_MAX_LINES` **and** `prodFiles ≤ AUTO_APPROVE_MAX_FILES`. Test files are filtered out before the count — see [test-file detection](#test-file-detection). (Server-side hard guard — the reviewer is told "don't approve" if either cap is exceeded, regardless of what it finds.)
3. The reviewer found no critical and no major issues.
4. The reviewer sees **none** of these criticality red flags in the diff:
   - auth / authn / authz / sessions / tokens / credentials
   - payments / billing / money handling
   - DB schema, migrations, data-shape changes
   - CI/CD, build scripts, deployment configs
   - public-API removal or signature change
   - non-trivial refactor that changes call-site behavior
   - adding, removing, or version-bumping a dependency
   - anything where regression risk can't be bounded from the diff

If any of the above fails, the review is still posted — just as `--comment`, not `--approve`. The web UI shows whether auto-approval was eligible, blocked by size, or disabled, plus the prod/test breakdown.

#### Test-file detection

A file is classified as **test code** (and therefore excluded from the size cap) if its path matches any of:

- `tests/`, `test/`, `__tests__/`, `spec/`, `e2e/`, `cypress/`, `integration-tests/`, `src/test/`
- `*.test.{js,jsx,ts,tsx,mjs,cjs}`, `*.spec.{js,jsx,ts,tsx,mjs,cjs}`
- `*_test.go`
- `test_*.py`, `*_test.py`
- `*_spec.rb`
- `*Tests.{java,kt,scala,groovy}`, `*Test.{java,kt,scala,groovy}`, `*Spec.{java,kt,scala,groovy}`, `*IntegrationTests.{java,kt,scala,groovy}`

Everything else counts as production code. If your project uses a non-standard test layout, edit `TEST_PATH_PATTERNS` in `lib/github.js`.

### Customizing the hero image

Three SVG defaults ship in `public/heroes/`:

| Path | Style |
|---|---|
| `/heroes/sleepy-cat.svg` | Orange tabby curled up under a starry sky (default) |
| `/heroes/pink-panther.svg` | Smug pink long-cat. "cool. calm. reviewing." |
| `/heroes/moon-night.svg` | Crescent moon with stars and rolling hills |

To use one: `HERO_IMAGE=/heroes/pink-panther.svg` in `.env`.

To use **your own**: drop a JPEG/PNG/SVG into `public/heroes/` and point at it (`HERO_IMAGE=/heroes/my-cat.jpg`), or use any public URL (`HERO_IMAGE=https://i.example.com/my-banner.jpg`). Aim for a landscape aspect ratio (~16:7 or wider).

---

## Review skills

prsnooze inlines a review skill's body into the prompt at runtime (Claude Code can't dispatch a skill marked `disable-model-invocation: true` via the Skill tool, so dispatch is unreliable; inlining is bulletproof).

Resolution order, first hit wins:

1. `<worktree>/.claude/skills/aa-review-pr/SKILL.md` — project, preferred
2. `<worktree>/.claude/skills/review-pr/SKILL.md` — project, alternate name
3. `~/.claude/skills/aa-review-pr/SKILL.md` — your user-level skill
4. `~/.claude/skills/review-pr/SKILL.md`
5. **`<prsnooze>/skills/default-review/SKILL.md`** — bundled with this repo. Always present, so this is the floor: every review uses a structured playbook, never a vibes-only "do a thoughtful review."

The web UI's `skill_resolved` event tags the source as `[project]` / `[user]` / `[bundled]` so you can tell at a glance which playbook ran.

The bundled default is designed for headless use: no interactive prompts, severity-tagged findings, explicit "post exactly once" guard, compatible with prsnooze's auto-approve policy. Skim `skills/default-review/SKILL.md` to see what gets inlined. To customize per-project, drop a `aa-review-pr/SKILL.md` into your project's `.claude/skills/`; prsnooze picks it up automatically.

## Concurrency

One review at a time by default — additional submissions queue FIFO, and the topbar shows queue depth. To review several PRs at once, set **`MAX_CONCURRENT_REVIEWS`** to the number you want (e.g. `3`). Each review gets its own worktree and Claude session; only the quick per-repo git prep (`fetch` + `worktree add`) takes turns, so same-repo reviews never race on the shared clone.

## Manual approve (host only)

prsnooze deliberately doesn't auto-approve risky or large PRs — those come back as *commented*, leaving the merge decision to a human. When the UI is opened from **the host's own browser** (i.e. `localhost` — teammates reaching it over the LAN don't see this), an **✓ Approve PR** button appears on any finished review that wasn't auto-approved. It doesn't approve for you: it copies the exact command

```
gh pr review <pr-url> --approve
```

to your clipboard so you run it in your own terminal. `gh` is already required (and authenticated) for prsnooze to work, so nothing extra to install. There's no setting and no server-side approval endpoint — the write happens under your own `gh` identity, by your own hand.

## File layout

| Path | Purpose |
|---|---|
| `bin/start.js` | Local preflight + bootstrap |
| `bin/docker-server` | Docker dispatcher (start/stop/ssh/login/etc) |
| `Dockerfile` / `docker-compose.yml` | Container definition |
| `server.js` | Express app, SSE, queue wiring, `.env` loader |
| `lib/queue.js` | Concurrency-capped worker pool with EventEmitter |
| `lib/repo-lock.js` | Per-repo serialization for git prep (safe concurrency) |
| `lib/review-job.js` | Per-job orchestrator |
| `lib/git-ops.js` | `gh repo clone`, `git fetch`, `git worktree add/remove` |
| `lib/github.js` | PR URL parser + `gh pr view` wrapper |
| `lib/claude-runner.js` | Spawns `claude -p`, parses stream-json |
| `public/` | UI (vanilla JS + EventSource) |
| `~/.prsnooze/` (host) or `prsnooze-data` volume (docker) | Runtime state |

## Troubleshooting

- **`gh pr view failed`** — run `gh auth status` (or `bin/docker-server ssh` then `gh auth status`).
- **`Base branch not found on origin`** — the PR's base branch was deleted, or the cached clone is stale. prsnooze fetches before every worktree, so it usually means the branch really is gone.
- **Claude exits non-zero** — the worktree is preserved at `~/.prsnooze/worktrees/<jobId>` (or in the container at `/home/prsnooze/.prsnooze/worktrees/<jobId>`). `cd` in and run `claude` interactively to reproduce.
- **Review feels generic** — prsnooze searches for a project-level `aa-review-pr` or `review-pr` skill in the worktree's `.claude/skills/`, then at `~/.claude/skills/`, then falls back to the bundled `skills/default-review/SKILL.md` in this repo. The web UI's `skill_resolved` event shows which one was used (`[project]` / `[user]` / `[bundled]`). For project-specific review rubrics, add an `aa-review-pr/SKILL.md` to your project — prsnooze inlines its body into the prompt.

## Roadmap

- GitHub webhook (auto-trigger on PR open)
- Optional bearer-token auth on the web UI
- Persistent queue (survive restart)
- Pluggable skill names via env

## License

[MIT](LICENSE).
