"use strict";

// The "is one already running?" probe.
//
// Everything that can start prsnooze (a terminal, a detached start, launchd,
// systemd) asks this first, so the answers have to be right in all three cases:
// nothing there, our own server there, someone else's server there. Getting the
// third one wrong is the dangerous one: it would let the manager report success
// for a port it does not own, or kill a process that isn't ours.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { probe, resolvePort, DEFAULT_PORT } = require("../lib/instance");

// Start a throwaway server that answers /api/config with `payload`.
function serveConfig(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const close = (server) => new Promise((r) => server.close(r));

test("a port with nothing on it is free", async () => {
  // Bind to get a port the OS just handed out, then let it go: nothing else
  // will have taken it by the time we ask.
  const { server, port } = await serveConfig({});
  await close(server);

  const res = await probe(port);
  assert.equal(res.state, "free");
  assert.equal(res.url, `http://localhost:${port}`);
});

test("our own server is recognised, and reports its host", async () => {
  const { server, port } = await serveConfig({ brand: "prsnooze", host: "ahsan-mini" });
  try {
    const res = await probe(port);
    assert.equal(res.state, "prsnooze");
    assert.equal(res.host, "ahsan-mini");
  } finally {
    await close(server);
  }
});

test("someone else's server on the port is foreign, not ours", async () => {
  const { server, port } = await serveConfig({ brand: "something-else" });
  try {
    assert.equal((await probe(port)).state, "foreign");
  } finally {
    await close(server);
  }
});

test("a listener that isn't HTTP at all is foreign, never free", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 500;
    res.end("<html>not json</html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.equal((await probe(port)).state, "foreign");
  } finally {
    await close(server);
  }
});

// ------------------------------------------------------------- the port -----

test("PORT in the environment beats .env, which beats the default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-port-"));
  try {
    assert.equal(resolvePort({ root, env: {} }), DEFAULT_PORT);

    fs.writeFileSync(path.join(root, ".env"), "# a comment\nPORT=9001\nAUTO_APPROVE=true\n");
    assert.equal(resolvePort({ root, env: {} }), 9001);

    // The server itself lets a real env var win over .env; the manager has to
    // agree, or it would look for the server on the wrong port.
    assert.equal(resolvePort({ root, env: { PORT: "9002" } }), 9002);

    // Junk in either place falls through rather than producing NaN.
    fs.writeFileSync(path.join(root, ".env"), "PORT=not-a-port\n");
    assert.equal(resolvePort({ root, env: {} }), DEFAULT_PORT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
