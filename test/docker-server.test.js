"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("docker status reports the provider versions inside the running container", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-docker-status-"));
  const docker = path.join(dir, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
case "$*" in
  "compose version") exit 0 ;;
  "compose ps") printf '%s\\n' 'NAME       STATUS' 'prsnooze   running' ;;
  "ps --format {{.Names}}") printf '%s\\n' prsnooze ;;
  "exec prsnooze node bin/provider-versions.js")
    printf '%s\\n' 'Claude: 2.1.260 (Claude Code)' 'Codex: codex-cli 0.153.2' ;;
  *) printf 'unexpected docker call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);
  fs.chmodSync(docker, 0o755);

  const result = spawnSync("bin/docker-server", ["status"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /provider versions/);
  assert.match(result.stdout, /Claude: 2\.1\.260 \(Claude Code\)/);
  assert.match(result.stdout, /Codex: codex-cli 0\.153\.2/);
});
