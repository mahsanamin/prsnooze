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

## Cross-instance invariants

The `snooze` CLI lets one machine queue work on another. That makes remote
control a security surface, not a convenience feature.

- Remote control is opt-in. With no `PRSNOOZE_REMOTE_TOKEN` set, every
  `/api/remote/*` route answers 503. Never make it default-on, and never fall
  back to unauthenticated access.
- Authenticate before any side effect. No remote route may read job data, queue
  a review, or resume one before the token check passes.
- A missing token and a wrong token get the identical answer, with no detail,
  the same way the approve password behaves.
- Compare the token in constant time. Do not use `===` on secrets.
- Do not add auth to the routes the browser page already calls. Sharing that URL
  over a LAN with no credential is documented behaviour; remote control is the
  new capability and gets the new namespace.
- The browser route and the remote route must share one implementation for
  queueing (`enqueueReview`) and resuming (`resumeReviewJob`). The resume gate,
  its refusal reasons, and what `force` overrides cannot differ by caller.
- A review ref is `<instance-short-id>/<job-id>`. It carries the instance id, not
  the caller's local nickname, so a ref means the same review in every CLI and
  resume returns to the machine holding the session.
- An instance id must survive a restart, and must not block startup if it cannot
  be persisted.
- Any command that dispatches work must state whose GitHub identity will post the
  review and whose plan pays for it. Do not quiet that down.
- Reading plan usage shells out to a provider CLI, so keep it opt-in
  (`?usage=1`). A status sweep across peers must not pay for it by default.

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

The Docker provider CLIs are exact dependencies in `docker/providers/`. Keep
that lockfile and its Dependabot entry: an image rebuild at one commit must not
silently move an adapter to a different CLI schema. Treat a provider bump as an
adapter compatibility change and run the real-CLI checks below. Pin only a CLI
version that has completed those checks; do not freeze an incidental version
merely because an earlier unpinned image happened to install it.

## Claude stream invariants

- `rate_limit_event` is recognized subscription telemetry, not review output.
  Keep it out of the raw `other` log unless the UI gains a deliberate,
  structured use for it.
- Unknown Claude event types and known types whose required fields are missing
  must remain visible as `other`, for the same schema-drift reason as unknown
  Codex events. Do not use handled event names as fallback silence rules.

## Provider preflight and model reporting

- Preflight every provider configured in `REVIEW_PROVIDERS`. A failing default
  provider blocks an interactive start; a failing non-default provider is
  reported as unavailable but does not take down a host whose default works.
- Keep each provider's binary, auth check, hints, and unsafe command in the
  provider registry. Adding AGY must not add another provider-name branch to
  `bin/start.js`.
- Codex's public JSONL stream currently omits its model. Read the concrete model
  from that run's own `turn_context` rollout record after exit. If neither the
  run nor the CLI reports a model, leave it unknown rather than guessing from
  the catalog. Model enrichment is optional and bounded; failure or timeout
  must never prevent the provider's `exit` event.

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

The audit job deliberately pins its npm client and retries the audit once. The
Node 22 image's bundled npm has intermittently fallen back to the retiring Quick
Audit endpoint and falsely failed clean lockfiles. Do not remove that pin or
retry without validating the Bulk Advisory path in CI.

## Change discipline

- Preserve unrelated user changes and keep patches scoped.
- Add regression tests for every bug fix, especially provider event handling.
- Never commit `.env`, auth files, tokens, provider session data, cloned repos,
  worktrees, or captured output containing source code or secrets.
- Keep documentation and `.env.example` aligned with runtime behavior.
- `CLAUDE.md` is only a bridge to this file. Put durable project guidance here.
