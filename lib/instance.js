"use strict";

// Is prsnooze already up on this machine?
//
// Every entry point that can start a server asks this first, so a second
// `npm start`, a `bin/prsnooze-service start`, or a launchd/systemd job firing
// on top of a server that is already listening reports "already running"
// instead of dying on EADDRINUSE. The check is a real HTTP request rather than
// a PID file because the server can be started four different ways (foreground,
// nohup, launchd, systemd) and the port is the one thing all of them share.
//
// Identification is /api/config's `brand`, which is already served for the
// page's own use, so nothing new is exposed, and something else squatting the
// port is told apart from our own server rather than being killed by mistake.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_PORT = 8284;

// free:     nothing is listening; safe to start.
// prsnooze: our server answered; starting again would be a duplicate.
// foreign:  something is listening but it isn't prsnooze; starting would
//            fail on EADDRINUSE and killing it would be someone else's problem.
const STATES = ["free", "prsnooze", "foreign"];

// Exit codes for the CLI form below, so a shell script can branch on them
// without parsing text.
const EXIT = { prsnooze: 0, free: 3, foreign: 4 };

function probe(port = DEFAULT_PORT, { host = "127.0.0.1", timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    const url = `http://localhost:${port}`;
    const done = (state, extra = {}) => resolve({ state, port, url, ...extra });

    const req = http.get({ host, port, path: "/api/config", timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        // A config payload is a few hundred bytes. Anything pouring out is not
        // us, and we are not going to buffer it to find that out.
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json && json.brand === "prsnooze") {
            return done("prsnooze", { host: json.host || null });
          }
        } catch {}
        done("foreign", { reason: `HTTP ${res.statusCode} from something else` });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      // Listening but not answering. Could be a wedged prsnooze, could be
      // anything; either way this port is not ours to bind.
      done("foreign", { reason: "listening but no reply within the timeout" });
    });

    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") return done("free");
      done("foreign", { reason: err.code || err.message });
    });
  });
}

// The port prsnooze will actually use: an explicit env var wins, then PORT in
// the project's .env, then the default. Deliberately mirrors server.js's own
// precedence (env before .env) so the manager and the server never disagree
// about where to look.
function resolvePort({ root = path.resolve(__dirname, ".."), env = process.env } = {}) {
  const fromEnv = parseInt(env.PORT || "", 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const fromFile = parseInt(readEnvFile(path.join(root, ".env")).PORT || "", 10);
  if (Number.isInteger(fromFile) && fromFile > 0) return fromFile;
  return DEFAULT_PORT;
}

function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

module.exports = { probe, resolvePort, readEnvFile, DEFAULT_PORT, STATES, EXIT };

// CLI form, used by bin/prsnooze-service: prints the state on stdout and
// encodes it in the exit code as well.
//
//   node lib/instance.js         → resolve the port from .env, then probe
//   node lib/instance.js 9000    → probe port 9000
//   node lib/instance.js --port  → just print the resolved port
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    if (arg === "--port") {
      process.stdout.write(`${resolvePort()}\n`);
      return;
    }
    const port = parseInt(arg || "", 10) || resolvePort();
    const res = await probe(port);
    process.stdout.write(`${res.state}\n`);
    process.exitCode = EXIT[res.state] ?? 4;
  })();
}
