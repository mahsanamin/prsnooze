"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

  const claude = executable(binDir, "claude", "printf '%s\\n' 'claude 1.0'");
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
