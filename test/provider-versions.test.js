"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fakeProvider(dir, name, version) {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("provider version reporting follows the configured registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-provider-versions-"));
  const claudeBin = fakeProvider(dir, "claude", "2.1.260 (Claude Code)");
  const codexBin = fakeProvider(dir, "codex", "codex-cli 0.153.2");

  const result = spawnSync(process.execPath, ["bin/provider-versions.js"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      REVIEW_PROVIDERS: "codex,claude",
      CLAUDE_BIN: claudeBin,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "Codex: codex-cli 0.153.2",
    "Claude: 2.1.260 (Claude Code)",
    "",
  ].join("\n"));
});
