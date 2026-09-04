# PR Snooze agent guide

Read this file before changing the repository. Keep it provider-neutral unless
a rule genuinely belongs to one CLI.

## What this project does

PR Snooze accepts a GitHub pull-request URL, prepares an isolated worktree,
runs a selected coding-agent CLI, streams its activity to the browser, and
lets that agent post one GitHub review using the host's `gh` identity.

This is security-sensitive automation. The provider runs without interactive
approval prompts or a sandbox. Do not weaken the network warning, GitHub
identity safeguards, worktree isolation, or review policy.

## Architecture and ownership

- `server.js` owns HTTP/WebSocket APIs, persistence, and provider discovery.
- `lib/queue.js` owns concurrency and cancellation.
- `lib/review-job.js` owns the provider-neutral review lifecycle.
- `lib/providers/` owns CLI-specific commands and event normalization.
- `lib/skill-resolver.js` owns provider-specific skill locations.
- `public/` renders only the normalized event and provider contracts.
- `skills/default-review/SKILL.md` is the last-resort review policy.

Do not put a provider-specific output format or command branch in the queue,
shared job lifecycle, or browser. Add or change an adapter instead. The full
adapter contract and AGY checklist are in `docs/provider-adapters.md`.

## Compatibility invariants

- Claude remains the default unless configuration explicitly selects another
  provider.
- A saved job with no `provider` field is an old Claude job.
- A review must resume with the same provider and session ID that created it.
- Keep existing Claude event names and error codes compatible where clients or
  saved logs can observe them.
- Provider-native events must be normalized to the shared event contract before
  they reach `review-job`, persistence, or the browser.
- A provider that cannot report plan limits or a model must return an explicit
  unsupported result. Do not invent values.
- Read a project review skill from the PR's base revision, not from code the PR
  can modify. Keep the bundled fallback working.
- Keep GitHub outcome reconciliation after every run. A command-looking event
  is not proof that GitHub accepted a review.
- Never offer resume when no resumable session ID was recorded.

## Codex stream invariants

These rules come from a real `codex exec --json` review, not only a fixture:

- `Reading additional input from stdin...` on stderr is normal for a non-TTY
  run with empty stdin. Filter that exact notice without hiding other stderr.
- Recognized lifecycle events that intentionally produce no UI output, such as
  `turn.started`, stay quiet. Do not render them as raw `other` events.
- Codex can emit a non-fatal `item.completed` whose item type is `error` for a
  notice such as a shortened skill description. Render it as a notice/log line.
- A real failure still comes from `turn.failed`, a top-level error, a spawn
  error, or a non-zero process exit.
- Unknown event or item types must remain visible as `other`. Quieting known
  noise must never hide schema drift.
- Preserve the thread ID, final agent message, turn count, token usage, command
  events, and non-zero stderr tail.

When Codex changes its JSONL schema, update recognition, normalization, and
fixtures together.

## Required validation before delivery

Do not report a change as green merely because `npm test` passes. Before
committing or pushing, run every applicable repository gate:

```sh
npm ci
npm test
npm audit --audit-level=moderate
npm audit signatures
bash -n bin/docker-server bin/prsnooze-service
docker compose config
docker build -t prsnooze:verify .
```

Also run `git diff --check` and syntax-check changed JavaScript. CI tests Node
20 and Node 22, so do not use APIs outside the declared `node >=20` floor.

For any provider adapter or event-parser change, fixtures are necessary but not
sufficient. Run the installed real CLI in JSON/non-interactive mode inside a
disposable local git repository, with a prompt that forbids network calls and
writes. Inspect stdout and stderr for:

- the real event types and field names;
- expected quiet events and harmless notices;
- visible genuine errors and unknown events;
- session ID, final result, and usage capture;
- successful cancellation and non-zero exit handling when those paths change.

Do not post a real GitHub review merely to smoke-test unless the user explicitly
authorizes the target PR. If a full test PR is provided, verify the browser log,
GitHub outcome, persisted job, cleanup, and same-provider resume end to end.

After pushing, inspect all GitHub checks for the pushed commit. A badge such as
`3 / 4` means one required check failed. Open the failed job and either fix it
or clearly report the unresolved failure. Never call a delivery complete while
its required checks are red.

## Change discipline

- Preserve unrelated user changes and keep patches scoped.
- Add regression tests for every bug fix, especially provider event handling.
- Never commit `.env`, auth files, tokens, provider session data, cloned repos,
  worktrees, or captured output containing source code or secrets.
- Keep documentation and `.env.example` aligned with runtime behavior.
- `CLAUDE.md` is only a bridge to this file. Put durable project guidance here.
