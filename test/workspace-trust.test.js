"use strict";

// Tests for the two halves of the fix for a headless review dying on a
// permission prompt.
//
// What happened: claude ran in a prsnooze worktree with
// --dangerously-skip-permissions, and `git checkout <headSha>` still came back
// "This Bash command contains multiple operations. The following part requires
// approval", then "Claude requested permissions to use Bash, but you haven't
// granted it yet." Two separate causes, one per half below:
//
//   1. The reviewed repo's .claude/settings.json listed
//      `Bash(git checkout:*)` under `permissions.ask`. Bypass mode silences
//      the *prompt*; it does not override an `ask` rule, and a headless run
//      has nobody to answer it. So prsnooze now does the checkout itself and
//      tells the reviewer not to move the worktree — workingTreeBlock().
//   2. The clone was never a trusted workspace, so claude dropped that repo's
//      `permissions.allow` list (and its project skills) on every run —
//      ensureWorkspaceTrusted().

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { workingTreeBlock } = require("../lib/claude-runner");

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-trust-"));
  const file = path.join(dir, ".claude.json");
  return { dir, file };
}

// The module reads the env at call time, so each test sets it and restores it.
async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const { ensureWorkspaceTrusted } = require("../lib/claude-trust");

const trust = (repoDir, cfgDir, extraEnv = {}) =>
  withEnv({ CLAUDE_CONFIG_DIR: cfgDir, PRSNOOZE_TRUST_CLONES: undefined, ...extraEnv }, () =>
    ensureWorkspaceTrusted(repoDir),
  );

// --------------------------------------------------------- workspace trust --

test("trust is granted for the clone, and nothing else in the config moves", async () => {
  const { dir, file } = sandbox();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  fs.writeFileSync(
    file,
    JSON.stringify({
      oauthAccount: { accountUuid: "keep-me" },
      numStartups: 41,
      projects: { "/somewhere/else": { hasTrustDialogAccepted: false, allowedTools: ["Read"] } },
    }),
  );

  const res = await trust(repo, dir);
  assert.equal(res.changed, true);
  assert.equal(res.reason, "granted");

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.projects[repo].hasTrustDialogAccepted, true);
  // Someone else's session data is not ours to rewrite.
  assert.deepEqual(after.oauthAccount, { accountUuid: "keep-me" });
  assert.equal(after.numStartups, 41);
  assert.deepEqual(after.projects["/somewhere/else"], {
    hasTrustDialogAccepted: false,
    allowedTools: ["Read"],
  });
});

test("an already-trusted clone is left alone, with no write at all", async () => {
  const { dir, file } = sandbox();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  fs.writeFileSync(file, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  const before = fs.statSync(file).mtimeMs;

  const res = await trust(repo, dir);
  assert.equal(res.changed, false);
  assert.equal(res.reason, "already");
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("a missing config is never created — no Claude Code here, no trust to grant", async () => {
  const { dir } = sandbox();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  // Note: sandbox() does not write the file.
  const res = await withEnv({ CLAUDE_CONFIG_DIR: dir, HOME: dir, PRSNOOZE_TRUST_CLONES: undefined }, () =>
    ensureWorkspaceTrusted(repo),
  );
  assert.equal(res.changed, false);
  assert.equal(res.reason, "no-config");
  assert.equal(fs.existsSync(path.join(dir, ".claude.json")), false);
});

test("PRSNOOZE_TRUST_CLONES=false keeps our hands off the config entirely", async () => {
  const { dir, file } = sandbox();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));

  const res = await trust(repo, dir, { PRSNOOZE_TRUST_CLONES: "false" });
  assert.equal(res.changed, false);
  assert.equal(res.reason, "disabled");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { projects: {} });
});

test("a config Claude Code is holding open is skipped, not forced", async () => {
  const { dir, file } = sandbox();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  const original = JSON.stringify({ projects: {} });
  fs.writeFileSync(file, original);
  // The same mkdir-based lock Claude Code takes around its own writes.
  fs.mkdirSync(`${file}.lock`);

  const res = await trust(repo, dir);
  assert.equal(res.changed, false);
  assert.equal(res.reason, "busy");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("an unparseable config is reported, never rewritten", async () => {
  const { dir, file } = sandbox();
  const repo = fs.mkdtempSync(path.join(dir, "repo-"));
  fs.writeFileSync(file, "{ this is not json");

  const res = await trust(repo, dir);
  assert.equal(res.changed, false);
  assert.equal(res.reason, "error");
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json");
});

// ------------------------------------------------------------ working tree --

test("at the PR head: names the commit and forbids moving the worktree", () => {
  const b = workingTreeBlock({
    checkedOutSha: "4322cc091b98852dd5160ddc1bee460170c12aaf",
    atPrHead: true,
    baseBranch: "main",
  }).join("\n");

  assert.match(b, /4322cc091b98852dd5160ddc1bee460170c12aaf/);
  assert.match(b, /the PR head/);
  assert.match(b, /Do NOT run `git checkout`/);
  assert.match(b, /origin\/main/);
  // The general case: the next repo will `ask` on something else.
  assert.match(b, /refused for permissions/);
  assert.match(b, /don't stop the review/);
});

test("fell back to base: says the files are pre-change, so nothing is misquoted", () => {
  const b = workingTreeBlock({ checkedOutSha: null, atPrHead: false, baseBranch: "develop" }).join("\n");

  assert.match(b, /PRE-change/);
  assert.match(b, /gh pr diff/);
  assert.doesNotMatch(b, /Every file you read is/);
});
