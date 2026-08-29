"use strict";

// bin/prsnooze-service, the thing that keeps prsnooze up.
//
// The promise being tested is the one people actually rely on: running `start`
// again on a server that is already running is a no-op with a friendly message,
// not a second server and not an EADDRINUSE crash. That is what makes it safe
// to put in a login item, a cron, or a teammate's muscle memory.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "bin", "prsnooze-service");
const shellless = process.platform === "win32";

// A port nothing is on: bind to 0, read what the OS gave us, hand it back.
// Every sandbox gets its own, so these tests never collide with each other or
// with a prsnooze the developer happens to be running.
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-svc-"));
  const port = await freePort();
  return {
    home,
    port,
    // HOME is redirected too, so the test can never see (or install into) the
    // real user's LaunchAgents / systemd directory.
    env: { ...process.env, HOME: home, PRSNOOZE_HOME: path.join(home, "data"), PORT: String(port) },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

const run = (args, env) => execFileP("bash", [SCRIPT, ...args], { env, cwd: ROOT });

test("help lists the commands and doesn't need a server", { skip: shellless }, () => {
  const out = execFileSync("bash", [SCRIPT, "help"], { encoding: "utf8" });
  for (const cmd of ["start", "stop", "restart", "status", "install"]) {
    assert.match(out, new RegExp(`\\b${cmd}\\b`));
  }
});

test("status on a stopped server says so, and exits non-zero", { skip: shellless }, async () => {
  const box = await sandbox();
  try {
    await assert.rejects(
      () => run(["status"], box.env),
      (err) => {
        // Non-zero exit is the contract for scripts asking "is it up?".
        assert.equal(err.code, 1);
        assert.match(err.stdout, /stopped/);
        // Nothing was installed in this sandbox, and it must say so rather
        // than implying it will survive a reboot.
        assert.match(err.stdout, /supervisor\s+none/);
        return true;
      },
    );
  } finally {
    box.cleanup();
  }
});

test("start is safe to run twice: the second one changes nothing", { skip: shellless, timeout: 90_000 }, async () => {
  const box = await sandbox();
  try {
    const first = await run(["start"], box.env);
    assert.match(first.stdout, /started/);

    const status = await run(["status"], box.env);
    assert.match(status.stdout, /running/);

    const second = await run(["start"], box.env);
    assert.match(second.stdout, /already running/);
    assert.match(second.stdout, /nothing started/);

    // The real point: one server, not two. The pid answering the port after
    // the second start is the same one the first start left there.
    const after = await run(["status"], box.env);
    const pid = (s) => (s.match(/pid\s+(\d+)/) || [])[1];
    assert.ok(pid(status.stdout), "status should report the pid it found");
    assert.equal(pid(after.stdout), pid(status.stdout));
  } finally {
    try {
      await run(["stop"], box.env);
    } catch {}
    box.cleanup();
  }
});

test("stop on an already-stopped server is not an error", { skip: shellless }, async () => {
  const box = await sandbox();
  try {
    const out = await run(["stop"], box.env);
    assert.match(out.stdout, /not running/);
  } finally {
    box.cleanup();
  }
});
