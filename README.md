# prsnooze

> **Paste a PR link. Get a real review on GitHub about a minute later.** Nobody had to be asked.

![prsnooze showing a finished review: the PR, what it checked, and the review it posted](docs/prsnooze-2026-08.png)

## The problem

Your PR is ready. You drop it in Slack: *"anyone free to review this?"*

Then you wait. Not because the review is hard — because getting a person's attention is hard. They're in a meeting, heads-down, or asleep. A ten-minute review takes half a day to *start*.

## What prsnooze is

One person on your team runs prsnooze on their machine. It's a web page.

Anyone on your network opens that page, pastes a GitHub PR URL, and clicks **Review PR**. A minute later the review is on the PR — specific comments about the actual diff, posted under that person's GitHub account. If the change is genuinely small and safe, it approves it outright.

| Before | After |
|---|---|
| "Can someone review my PR?" → wait | Paste the link. Done. |
| Hours before the first look | First-pass review in about a minute |
| Your reviewer context-switches out of their work | Your reviewer isn't interrupted at all |
| Review quality depends on who's free | Every review runs the same playbook — your project's own |

## Why not just buy a review bot

**Because your team is already paying for Claude or Codex, and that budget is sitting idle.**

prsnooze doesn't have its own account, key, or bill. It drives the Claude Code or Codex CLI that the host is already logged into, using their existing subscription on their own machine. Pick the reviewer from the page. Nothing new to buy, no per-PR metering, no finance conversation.

It's also not an autonomous agent wandering your repos. It runs when a human asks, on the one PR they named, and stops. You can watch every command it runs, live.

| | A hosted review bot | prsnooze |
|---|---|---|
| Cost | org API key, billed per PR | nothing extra, uses the Claude or Codex plan you already have |
| Runs when | on every push, whether you wanted it or not | when someone pastes a link |
| Reviews against | its own generic idea of "good code" | your project's review skill and repository guidance |
| Your code goes | to a third-party service | nowhere — it's your teammate's laptop |

## Try it in two minutes

```sh
git clone https://github.com/mahsanamin/prsnooze.git
cd prsnooze
npm install
npm start
```

`npm start` checks your setup, tells you anything that's missing, and prints a URL — by default **http://localhost:8284**. Open it, paste a PR link, watch it work.

That command runs in your terminal, so it stops when you close it. Once it's working, one more command keeps it up for good, through crashes and reboots: `bin/prsnooze-service install` ([Keep it running](#keep-it-running)).

That's the whole thing. To let colleagues use it, share that URL over your LAN or Tailscale — but read the next section first.

## ⚠️ Read this before you share the URL

prsnooze runs the selected provider without approval prompts or a sandbox. For Claude that is `--dangerously-skip-permissions`; for Codex it is `--dangerously-bypass-approvals-and-sandbox`. That means:

- The reviewer can read, write and run anything inside the checkout, with no confirmation prompts.
- **Anyone who can reach the page can start an AI review session on your machine.**
- Reviews are posted as *you*. Anyone using it is reviewing under your GitHub identity.

So:

1. **Don't put it on the public internet.** LAN or Tailscale only. There is no login on the page.
2. **Use a fine-grained GitHub token** scoped to the repos you actually want reviewed (Pull requests: read+write, Contents: read). Not a classic all-repos token.
3. Run it on a machine you don't mind seeing network activity from.

## Keep it running

`npm start` lives in your terminal. Close the window, sleep the laptop, reboot the machine, and prsnooze is gone until someone remembers to start it again. One command fixes that for good:

```sh
bin/prsnooze-service install
```

That hands prsnooze to the machine's own supervisor (launchd on macOS, systemd on Linux). It starts by itself at login or boot, comes straight back if it crashes, and writes to `~/.prsnooze/logs/server.log`.

### On macOS, check the reviewer can still log in

Claude Code keeps its credentials in your **login keychain**, and a service run by
launchd cannot always read it. When that happens the reviewer has no credentials
at all, and every review dies on Claude's own message:

```
Failed to authenticate: OAuth session expired and could not be refreshed
```

It is confusing because `claude auth status` in *your* terminal says you are
logged in. The service is in a different session, and there it reports
`{"loggedIn": false, "authMethod": "none"}`. Nothing about prsnooze, your PR, or
your network is wrong.

**Startup tells you.** Look at the log right after installing:

```
Claude is logged in... ok    ahsan.amin@wego.com, team plan     <- good
Claude is logged in... fail  claude reports authMethod "none"   <- reviews will fail
```

If it fails, pick one:

- **Skip the supervisor.** `bin/prsnooze-service uninstall`, then
  `bin/prsnooze-service start`. That runs it with `nohup` from your own shell, so
  it keeps your session's keychain access and survives closing the terminal. The
  cost is real: it does not come back after a reboot.
- **Give Claude a long-lived token.** Run `claude setup-token`, then copy the
  value it prints into prsnooze's `.env` as
  `CLAUDE_CODE_OAUTH_TOKEN=<token>`. Keep that file private. Restart with
  `bin/prsnooze-service restart` (or run `install` if it is not installed yet).
  The service and its startup check then use the token instead of relying on
  your interactive login keychain, while automatic restart keeps working.

Codex is unaffected: `codex login` writes to `~/.codex`, which a service reads
without trouble. If only your Claude reviews fail, this is why.

After that, everything is one command:

| command | what it does |
|---|---|
| `bin/prsnooze-service start` | start it if it isn't already up |
| `bin/prsnooze-service stop` | stop it, however it was started |
| `bin/prsnooze-service restart` | bounce it, which is what to run after editing `.env` |
| `bin/prsnooze-service status` | up or down, on what URL, and what is supervising it |
| `bin/prsnooze-service logs -f` | follow the log |
| `bin/prsnooze-service install` | hand it to launchd/systemd (safe to re-run) |
| `bin/prsnooze-service uninstall` | undo that |

All of them also work as `npm run service:<command>`.

**Running one twice is not a mistake.** `start` on a server that is already up prints the URL and changes nothing: it never binds a second time and never kills the one already working. Plain `npm start` does the same, so the person who forgot it was running gets *"prsnooze is already running at http://…"* instead of a stack trace. Two servers reviewing the same PR is the failure this prevents.

A few host-specific things worth knowing:

- **macOS**: launchd user agents start at *login*, not at power-on. If the machine reboots unattended and nobody logs in, nothing is listening. Turn on automatic login (System Settings → Users & Groups) for a machine your team relies on.
- **Linux**: user services stop at logout unless lingering is on. `install` enables it for you; if it can't, it tells you the `sudo loginctl enable-linger` line to run. The macOS path is the one that's been run end to end so far, so if systemd misbehaves on your box, please open an issue.
- **Docker**: nothing to install. `docker-compose.yml` already says `restart: unless-stopped`, so `bin/docker-server start` survives reboots as long as Docker itself starts with the machine.
- **Git works without your terminal, by design.** prsnooze clones into its own `~/.prsnooze/repos/` over HTTPS, using the token `gh` is already authenticated with. A service gets its own empty ssh-agent and never the loaded one from your shell, so anything depending on an SSH key would work when you test it by hand and fail every night. There is no key in this path to be missing. `bin/prsnooze-service doctor` runs the checks the same way the service sees them, if you ever want to be sure.
- **Settings live in `.env`, not your shell profile.** A service doesn't read your shell. `install` records the `PATH` it saw (so `claude`, `gh` and `git` stay findable) along with `PORT` and `PRSNOOZE_HOME` if you set them, so re-run `install` after moving any of those tools.

## Everyone can see what's left of your plan

Claude reviews come out of one person's subscription, so the top bar shows how much of it is still there. Codex reports token use for each completed review, but does not expose the same plan-window report through its documented non-interactive interface, so the plan meter is hidden while Codex is selected.

It's deliberately visible to everyone, not just the host: whoever is about to paste a PR link is the person spending the plan, and "the session limit resets at 9pm" is a much better answer than a review that mysteriously fails. The numbers come from the CLI's own `/usage` report, which costs nothing to ask for — no tokens, no API call.

The same panel ends with a month-to-date total — *6 reviews · ≈$11.49 at API rates* — read from prsnooze's own review history. That one is a total, not a limit: Claude's plan resets by session and by week, so there's no monthly tank to run dry. It's there to answer "how much has this thing actually eaten of my plan this month".

If the host's `claude` runs on an API key instead of a subscription there are no plan windows to report, and the meter simply doesn't appear.

## The model doing the reviewing is on screen

Claude reviews use the host CLI's selected model, which the page reads from `/model`. Codex also uses its CLI default unless `CODEX_MODEL` is set. An explicit Codex model can be shown before a run; otherwise prsnooze records the concrete model from Codex's own session record when the review finishes.

It's there because it's the shortest explanation of how a review reads: the same PR comes back very differently on Haiku than on Opus. Each finished review also keeps the model it actually ran on in its stats, so a review from last month still tells you what read that diff after the host has moved on to something else. Changing it is a host-side thing through the provider CLI or `CODEX_MODEL`, not a control on this page.

## What it does, step by step

```mermaid
sequenceDiagram
  participant U as Teammate
  participant P as prsnooze
  participant C as Claude or Codex
  participant G as GitHub

  U->>P: paste PR URL
  P->>G: read the PR (gh pr view)
  P->>P: clone/fetch, git worktree add at the PR head
  P->>C: review this diff, using this project's rules
  C-->>U: live activity, streamed to the page
  C->>G: post the review
  P->>G: confirm what was actually posted
  P->>P: remove the worktree
```

Because it reviews inside a real checkout of your repo, repository guidance such as `CLAUDE.md` and `AGENTS.md` is available to the selected provider.

The worktree is checked out at **the PR's head commit**, so a file the reviewer opens is the code as proposed, and the `file:line` links in the review point at lines that actually exist there. prsnooze does that fetch and checkout itself before the selected provider starts, and tells the reviewer not to move the checkout. With Claude, a `permissions.ask` rule in the reviewed repo still refuses that action because a headless run has nobody to answer it.

For the same reason prsnooze marks its own clones under `~/.prsnooze/repos/` as trusted workspaces in `~/.claude.json` — the one-time dialog that normally grants that only appears in an interactive session, and until it's answered claude silently ignores the reviewed repo's `permissions.allow` list and its project-level skills. It's written once per repo, it never creates the file, and it steps aside if claude is mid-write. `PRSNOOZE_TRUST_CLONES=false` turns it off.

## When it approves on its own

Auto-approve (`AUTO_APPROVE=true`, the default) fires only when **all** of these hold:

1. The reviewer found no critical and no major issues.
2. Its **risk score** for the diff is ≤ 20.
3. Nothing in the diff looks like a real behaviour change in a scary place.

How the score works — the reviewer looks for genuine behaviour changes, not just scary-looking filenames (a typo fix in an auth file is not an auth change):

| Signal | Score |
|---|---|
| Auth / payments / DB migration — real behaviour change | +50 each |
| CI/CD change, public API break | +30 each |
| Real refactor, or a new public endpoint | +20 each |
| Dependency bump — major / minor / patch | +25 / +10 / +2 |
| Unclear blast radius | +15 |
| *Comments, formatting or renames only* | −25 |
| *Tests or docs only* | −20 |
| *Matching test file also changed* | −15 |
| *New tests covering the changed paths* | −10 |

| Total | What it does |
|---|---|
| ≤ 20 | approves |
| 21 – 60 | comments |
| > 60 | comments, with a high-risk banner |

If auth, payments or a migration really changed, the reducers are capped at −20 — so a genuine top-3 change never auto-approves. When it can't tell, it comments. Set `AUTO_APPROVE=false` and it never approves anything.

## Reviews follow your project's rules

prsnooze looks for a review playbook in provider-specific project and user locations, then uses its bundled fallback:

1. Claude: `<repo>/.claude/skills/review-pr/SKILL.md`, then the matching user-level path.
2. Codex: `<repo>/.agents/skills/review-pr/SKILL.md` or `.codex/skills/review-pr/SKILL.md`, then matching user-level paths. Claude locations remain compatibility fallbacks.
3. `skills/default-review/SKILL.md`, bundled here so there is always a floor.

(`aa-review-pr` works as an alternate name at both levels.) The page shows which one ran, tagged `[project]` / `[user]` / `[bundled]`. To make reviews match how your team actually reviews, drop a `review-pr/SKILL.md` into your repo — nothing else to configure.

A project skill is read from the PR's **base** branch, not from the PR. A pull request that rewrites the review playbook is reviewed by the old one.

### The project's rules outrank the host's

Reviews run on somebody's laptop, and that used to decide how strict they were: one playbook won, so a repo with its own rules threw the host's away, and a repo with none made the host's personal file the whole standard. Now both go into the prompt, ranked:

| | Governs |
|---|---|
| The project's `review-pr/SKILL.md` | Review content. Wins every disagreement. |
| The host's own `~/.claude/skills/review-pr/SKILL.md` | A layer on top. It can add checks and be stricter. It cannot drop a check, lower a severity, or approve what the project's rules would comment on. |
| prsnooze's floor | Runs whenever a personal skill is in play: correctness, security, regressions and tests get checked, a real finding keeps its severity, and the repo's own `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md` (read from the base) outrank a personal preference. A project skill is exempt — a repo is allowed to set its own bar. |

Approval is the one place a personal skill is allowed an opinion, in one direction. A skill that says *comment* where the score says approve is followed. A skill that says *approve* where the score says comment is ignored. Strictest answer wins.

Provider integrations use a small adapter contract, so adding another reviewer does not change the queue, job lifecycle, persistence, or browser. See [Provider adapters](docs/provider-adapters.md).

## Reach your team's other instances from the terminal

If five people on your team run prsnooze, `snooze` lets you use all five without
opening a browser. Ask who has a review slot free, hand a PR to whoever does, and
resume that review later from the same terminal.

```sh
snooze add http://sara-mac:8383           # once per colleague, no secret needed
snooze reviewers                          # who you have added
snooze status                             # who can take work right now
snooze review https://github.com/o/r/pull/7
snooze resume 01a06b8a/job-9f8e           # after the author replies
```

`snooze status` prints the thing you actually want to know:

```
sara  01a06b8a  slot free (0/2 running)
  http://sara-mac:8383
  host sara (posts as @sara-gh)
  providers claude, codex (default claude)

1 of 1 instance has a slot free.
```

**No setup on the host, and no token to pass around.** That surprises people, so
here is the reasoning: the page already accepts an unauthenticated
`POST /api/review` from anyone who can reach the host, and the CLI asks for the
same thing from the same people. Requiring a secret on one path and not the
other bought no protection and cost every colleague a round trip to ask for it.

A host who wants the CLI surface locked sets `PRSNOOZE_REMOTE_TOKEN` in `.env`
and restarts, and their colleagues then also run `snooze token <value>`. Worth
knowing: that covers one of two doors. The page still queues reviews with no
credential, so protect the whole service with an authenticated reverse proxy or
an equivalent network boundary as well, or the secret is decoration.

**Know what you are spending.** A review runs on the machine you send it to. It
spends *that* host's Claude or Codex plan and posts the review under *their*
GitHub identity. That is the point, since a team's idle plans get used instead of
one person's, but it is never hidden: `snooze add` and `snooze review` both print
whose account will sign the review. By default, anyone who can reach the service
can queue work. If the host configures a CLI token, anyone holding it can use the
CLI surface, so treat it like a password and share it deliberately.

The CLI records a self-asserted requester label (by default
`<local-user>@<hostname>`) and the source address on every remotely dispatched
review or resume. Set `SNOOZE_REQUESTER` if the default is not meaningful. Because the team
uses one shared token, this is an audit hint, not cryptographic proof of who
made the request. Use HTTPS for peer URLs unless the connection already travels
inside an encrypted private network such as Tailscale; `snooze add` warns when
you configure plain HTTP to a non-local address.

A ref like `01a06b8a/job-9f8e` names the instance that holds the review session,
not your local nickname for it, so it means the same review in everyone's CLI and
`snooze resume` always goes back to the machine that ran the original. Resuming
goes through the same gate as the button on the page: if nothing changed since the
last look it says so and refuses, and tells you that `--force` would override it.

## Someone replied to the review — now what

Open the finished review and press **Resume review**. It continues the same provider session, so it already knows what it said the first time. A Claude review always resumes in Claude and a Codex review always resumes in Codex.

A resume can approve. Once nothing is left open, it re-scores the current head against the same table above and posts the verb that comes out, so a small PR whose findings the author fixed gets approved instead of sitting there forever. Fixing the findings doesn't buy down the score, though: a change that touches auth, a migration or CI/CD is still high-risk after the fixes land, so it comments again and the merge call stays with you.

Before it runs, it checks whether that's worth doing and tells you: *"2 new commits and 3 replies to your comments since your review."* If there's nothing new, or the PR is already approved, it says so — **Force resume** runs it anyway. On a merged or closed PR, force is disabled: there's no PR left to review.

## Setup, properly

| | Local | Docker |
|---|---|---|
| Node.js ≥ 20 | you need it | bundled |
| Claude Code or Codex CLI, logged in | you need at least one | both bundled, use `claude-login` and/or `codex-login` |
| `gh` CLI, authenticated | you need it | bundled — `bin/docker-server gh-login` |
| git | you need it | bundled |
| An SSH key | not needed — it clones over HTTPS with the gh token | same |
| Staying up after a reboot | `bin/prsnooze-service install` | already on (`restart: unless-stopped`) |

For local development, Node `22.23.2` is pinned in both `.nvmrc` and
`.tool-versions`. Run `nvm install` (and then `nvm use`), or use `asdf install`
or `mise install` after configuring that manager's Node.js plugin/backend. Node
20 remains supported by the package and CI compatibility matrix. The exact pin
tracks the Docker image rather than the versions already installed on any one
developer machine.

`bin/prsnooze-service install` records the absolute path of the `node` active
at install time so the supervisor can find it after login or reboot. Changing
the version-manager pin does not change an existing service; run the install
command again from a shell using the desired Node version to update it.

Docker is the easier route for a machine several people will use, since it brings its own `node`, `git`, `gh`, Claude Code, and Codex CLI:

```sh
bin/docker-server start          # build + run in the background
bin/docker-server claude-login   # once: sign in to Claude
bin/docker-server codex-login    # once: sign in to Codex
bin/docker-server gh-login       # once: gh auth (paste a fine-grained PAT)
```

Then open **http://localhost:8284**. Other commands: `stop`, `restart`, `rebuild`, `logs`, `status`, `ssh`, `url` — all but `url` also work as `npm run docker:<command>`. Logins and cached repos live in docker volumes, so `rebuild` doesn't sign you out.

The image installs exact provider versions from `docker/providers/package-lock.json`.
Dependabot proposes CLI upgrades as reviewable changes, so rebuilding the same
commit cannot silently change an adapter's JSON schema. `bin/docker-server
status` prints the versions actually running in the container.

Runtime data (clones, worktrees, past reviews) lives in `~/.prsnooze/`, outside the project. When it runs as a service, its log is there too, at `~/.prsnooze/logs/server.log`.

## Configuration

Everything has a working default. Copy `.env.example` to `.env` only if you want to change something.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8284` | HTTP port |
| `AUTO_APPROVE` | `true` | Allow it to approve clean, low-risk PRs. `false` = always just comment. |
| `MAX_CONCURRENT_REVIEWS` | `1` | Initial reviews-at-once value for a new data home. The avatar settings menu persists later changes. |
| `CONFIDENCE_THRESHOLD` | `80` | Drop findings below this confidence. `0` = show everything. |
| `SKIP_IF_ALREADY_REVIEWED` | `true` | Don't re-review a commit you've already reviewed. |
| `MANUAL_APPROVE_PASSWORD` | *unset* | Password for the manual **Approve PR** button (see below). Authorises the person; an open critical finding still refuses the approval. |
| `PRSNOOZE_SETTINGS_PASSWORD` | *unset* | Separate password for changing the instance picture, locking intake, setting the plan-usage floor, and changing concurrency. Unset makes settings read-only. |
| `PRSNOOZE_REMOTE_TOKEN` | *unset* | Optional shared secret for the `snooze` CLI's cross-instance API. Unset leaves it as open as the web page. |
| `PRSNOOZE_HOME` | `~/.prsnooze` | Where clones, worktrees and review history live. |
| `REVIEW_PROVIDERS` | `claude,codex` | Provider adapters to offer when their CLI is installed. |
| `DEFAULT_REVIEW_PROVIDER` | `claude` | Initially selected reviewer. |
| `CLAUDE_BIN` | `claude` | Path to the claude CLI, if it isn't on `PATH`. |
| `CODEX_BIN` | `codex` | Path to the Codex CLI, if it isn't on `PATH`. |
| `CODEX_MODEL` | *unset* | Optional model passed to Codex. Unset uses the Codex CLI default. |
| `PRSNOOZE_GIT_TRANSPORT` | `https` | How git reaches GitHub. `https` uses the gh token, so no SSH key or agent is involved. `ssh` if your key can read repos your gh token can't. |
| `KEEP_WORKTREES_ON_SUCCESS` | `false` | Keep the checkout after a successful review (for debugging). |
| `PRSNOOZE_TRUST_CLONES` | `true` | Mark prsnooze's own clones as trusted workspaces in `~/.claude.json`, so the reviewed repo's `.claude/` is honored. `false` = never touch that file. |
| `PRSNOOZE_HOST` | *detected* | The name the page shows — "on Ada's machine" by the logo, and the browser tab title. Falls back to `git config user.name`, then the OS username, then the hostname. |
| `HERO_IMAGE` | *unset* | Optional background image. Unset, the page draws its own night sky. |

## Instance picture and review intake

The large picture beside the PRSnooze logo identifies whose machine, GitHub
identity, and provider plan will handle a review. Every data home receives one
of 20 stable, distinct defaults; click the picture to choose another or upload
a PNG, JPEG, or WebP. Uploaded pictures are resized in the browser and stored
under `PRSNOOZE_HOME`, not in the repository.

The same menu controls admission at runtime. It can stop accepting new and
resumed reviews without interrupting work already queued or running, allow one
to four simultaneous reviews, require a minimum percentage of the Claude plan
to remain. Claude reviews are always refused while the active model is Fable. The Fable
guard fails closed if PRSnooze cannot confirm Claude's current model; a configured
usage floor similarly fails closed when Claude cannot report its plan windows.
Providers that do not expose plan telemetry are not measured against that floor.

These controls require `PRSNOOZE_SETTINGS_PASSWORD`, which is deliberately
separate from `MANUAL_APPROVE_PASSWORD`. Saving a setting never grants permission
to approve a PR, and the settings password is not stored in the browser.

Default profile art uses [Personas by Draftbit via DiceBear](https://www.dicebear.com/styles/personas/), licensed under CC BY 4.0.

## Approving by hand

Risky or large PRs come back as *commented* on purpose — the merge decision stays with a human. On any finished review there's an **Approve PR** button, gated by a shared password so it works over a proxy as well as on localhost.

The button is always there and always live. Clicking it confirms what's about to happen, then asks for the password — **every time**. There is no unlocking, nothing is armed, and nothing is remembered: no cookie, no session, no browser you have to remember to re-lock before you walk away from it.

Set `MANUAL_APPROVE_PASSWORD` to the secret you want to share. It's only ever compared on the server. Anything that doesn't match comes back *not authorized* — and so does every attempt on a host that never set one, which is the same flow and the same message on purpose: the page your team can reach doesn't get to find out whether approving is configured. Five wrong guesses from one IP locks the endpoint for a minute, doubling up to 30, since a shared password on a reachable page is otherwise guessable at network speed. You can't approve your own PR; GitHub wouldn't allow it anyway.

### The password authorises the person, not the PR

Knowing the password is necessary and not sufficient. Once it matches, prsnooze reads the PR and refuses the approval if:

- a reviewer's **changes-requested** review still stands (only they can clear it);
- an **unresolved review thread** reads as critical or major — 🔴 / 🟠, "blocker", "must fix", and the like, from anyone;
- **critical or major findings on the PR's current head** are unanswered, including prsnooze's own from this review;
- **GitHub can't be reached** to check. That one is held, not guessed: "I couldn't look" is not "there's nothing there".

Nits, minors, plain questions and resolved threads don't block. Neither do findings against a commit the author has since replaced — a review of code that no longer exists says nothing about the code you're approving.

The refusal names what's open and where, and says how to clear it: fix it, or have the reviewer who raised it resolve the thread. **There is no override.** No second password, no force flag, no "approve anyway" — if the finding is wrong, the answer is to talk to whoever owns the host and let them review it themselves. That is the point of the whole gate: the password exists so a colleague can approve a clean PR without you, not so they can stamp over a finding you left.

## When something goes wrong

- **The page won't load at all** — run `bin/prsnooze-service status`. If it says *stopped*, `bin/prsnooze-service start` brings it back; if it says *supervisor none*, it won't survive the next reboot until you run `install`.
- **`gh pr view failed`** — run `gh auth status`. This is the most common one.
- **`Permission denied (publickey)` on `git fetch`** — you're on `PRSNOOZE_GIT_TRANSPORT=ssh`, and the running server has no access to your shell's ssh-agent. Drop the setting to use the gh token over HTTPS instead (no key needed), or save the key's passphrase once with `ssh-add --apple-use-keychain ~/.ssh/<your-key>` on macOS. `bin/prsnooze-service doctor` tells you which side is broken.
- **`Failed to authenticate: OAuth session expired and could not be refreshed`** — the reviewer cannot reach the login keychain, which happens when launchd runs it. `claude auth status` in your terminal will still say you are logged in; that is the tell, not a contradiction. See [Keep it running](#keep-it-running).
- **`PR is merged, not OPEN`** — it only reviews open PRs.
- **The password was right and it still didn't approve** — that's the approval gate, not a bug. The dialog lists what's open on the PR. Fix it, resolve the thread, or ask the host's owner to review it. There is no override.
- **The provider exited non-zero** — the checkout is kept at `~/.prsnooze/worktrees/<job-id>`. Open it and run the selected provider there to inspect the failure.
- **Every review suddenly fails** — check the usage chip in the top bar first. A spent plan limit looks exactly like a broken tool.
- **The review feels generic** — it fell back to the bundled playbook. Add a `review-pr/SKILL.md` to your repo; the page tells you which one it used.

## License

[MIT](LICENSE)
