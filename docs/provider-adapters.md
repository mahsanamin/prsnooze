# Provider adapters

PR Snooze keeps review orchestration independent from the AI CLI. Claude and
Codex implement the same adapter contract in `lib/providers/`; a future AGY
integration should do the same.

An entry in `lib/providers/index.js` supplies:

- a stable `id`, display `label`, binary, and optional model setting;
- `run(options)`, returning an event emitter with `event`, `exit`, and `error`;
- `prepareWorkspace(path)`, for provider-specific trust setup;
- project and user skill directories;
- optional model and plan-usage readers;
- preflight metadata: its unsafe command, installation hint, authentication
  check, and authentication hint.

The adapter translates native CLI output into these stable events:

- `system`, including the session ID and model when known;
- `assistant_text`;
- `tool_use` and `tool_result`;
- one final `result`, including the resumable session ID and usage when known;
- `stderr` for diagnostic output.

The shared job runner owns PR resolution, git worktrees, review policy,
GitHub reconciliation, cleanup, persistence, cancellation, and resuming. The
browser learns available providers from `/api/config`, so it needs no new
provider-specific branch.

Startup builds its preflight list from the same registry. Every configured
provider is checked. A failure for the effective default blocks an interactive
start, while a non-default failure is a visible warning so another working
provider can still serve reviews.

To add AGY later:

1. Add `lib/providers/agy.js` to spawn its non-interactive CLI and normalize its
   stream.
2. Register it in `lib/providers/index.js`, including its skill locations,
   workspace preparation, unsafe command, and CLI/auth preflight metadata.
3. Add its CLI and persistent auth directory to the Docker setup, plus a login
   helper if its authentication is interactive.
4. Add focused tests for fresh runs, resumed runs, event normalization,
   cancellation, and non-zero exits.
5. Add `agy` to `REVIEW_PROVIDERS` once its CLI contract is verified.

Do not put provider-specific behavior in `server.js`, the queue, or
`public/app.js`. If AGY cannot resume sessions, leave the result session ID
empty; PR Snooze will keep the review readable but will not offer resume.
