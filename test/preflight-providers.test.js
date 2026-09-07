"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getProvider } = require("../lib/providers");

const ROOT = path.resolve(__dirname, "..");

function executable(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runPreflight({ defaultProvider, codexWorks, reviewProviders = "claude,codex" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-preflight-"));
  const home = path.join(dir, "home");
  const binDir = path.join(dir, "bin");
  const sandboxRoot = path.join(dir, "repo");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(sandboxRoot, "bin"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "bin", "start.js"), path.join(sandboxRoot, "bin", "start.js"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(sandboxRoot, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, ".env.example"), path.join(sandboxRoot, ".env.example"));

  // Stands in for a healthy host, so it has to answer `auth status` too. Left
  // as a --version-only stub, the auth check reads "claude 1.0" as its JSON and
  // this harness stops representing a working machine.
  const claude = executable(binDir, "claude", `
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","email":"tester@example.com","subscriptionType":"team"}'
  exit 0
fi
printf '%s\\n' 'claude 1.0'`);
  const codex = codexWorks
    ? executable(binDir, "codex", "printf '%s\\n' 'codex 1.0'")
    : path.join(binDir, "missing-codex");
  executable(binDir, "git", "printf '%s\\n' 'git version 2.50.0'");
  executable(binDir, "gh", `
if [ "$1" = "--version" ]; then printf '%s\\n' 'gh version 2.0'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "git-credential" ]; then printf '%s\\n' 'username=tester' 'password=token'; exit 0; fi
exit 1`);
  executable(binDir, "ssh", "printf '%s\\n' 'Hi tester! You have successfully authenticated.' >&2; exit 1");

  return spawnSync(process.execPath, [path.join(sandboxRoot, "bin", "start.js"), "--check"], {
    cwd: sandboxRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      REVIEW_PROVIDERS: reviewProviders,
      DEFAULT_REVIEW_PROVIDER: defaultProvider,
      CLAUDE_BIN: claude,
      CODEX_BIN: codex,
      PRSNOOZE_HOME: path.join(dir, "data"),
      PRSNOOZE_GIT_TRANSPORT: "ssh",
    },
  });
}

test("an unavailable non-default provider is reported but does not block startup", () => {
  const result = runPreflight({ defaultProvider: "claude", codexWorks: false });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Codex CLI on PATH/);
  assert.match(result.stdout, /optional provider/);
  assert.match(result.stdout, /all checks passed/);
});

test("an unavailable default provider still fails preflight", () => {
  const result = runPreflight({ defaultProvider: "codex", codexWorks: false });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Codex CLI on PATH/);
  assert.match(result.stdout, /preflight failed/);
});

test("an empty supported-provider set fails before the server starts", () => {
  const result = runPreflight({
    defaultProvider: "claude",
    codexWorks: true,
    reviewProviders: "not-a-provider",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /at least one review provider configured/);
  assert.match(result.stdout, /no supported provider ids/);
});

// A host whose service cannot reach the keychain sees claude report
// {"loggedIn": false, "authMethod": "none"} with a non-zero exit. The old check
// only tested that ~/.claude/ existed, so preflight printed a green tick while
// every review failed on "OAuth session expired and could not be refreshed",
// and the host went looking for the fault in prsnooze.
function fakeClaude(dir, { json, exit }) {
  const bin = path.join(dir, "claude-auth-fake");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${json}'\nexit ${exit}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("an unauthenticated reviewer fails preflight instead of passing with a caveat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-authcheck-"));
  const bin = fakeClaude(dir, { json: '{"loggedIn":false,"authMethod":"none"}', exit: 1 });

  await assert.rejects(
    () => getProvider("claude").checkAuth({ bin }),
    (e) => {
      assert.match(e.message, /every review will fail/);
      // The message has to name the actual cause, or the host debugs the wrong thing.
      assert.match(e.message, /keychain/);
      assert.match(e.message, /launchd|systemd/);
      return true;
    },
  );
});

test("the JSON is read even though claude exits non-zero when logged out", async () => {
  // execFile rejects on a non-zero exit, but claude has already printed the
  // answer to stdout. Reading only the happy path would lose the reason.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-authcheck2-"));
  const bin = fakeClaude(dir, { json: '{"loggedIn":false,"authMethod":"none"}', exit: 1 });
  await assert.rejects(
    () => getProvider("claude").checkAuth({ bin }),
    (e) => !/could not run/.test(e.message),
  );
});

test("a logged-in reviewer reports the account, so the tick means something", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-authcheck3-"));
  const bin = fakeClaude(dir, {
    json: '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.com","subscriptionType":"team"}',
    exit: 0,
  });
  assert.equal(await getProvider("claude").checkAuth({ bin }), "a@b.com, team plan");
});
