"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// The page has to be able to tell a visitor how to reach THIS instance, which
// means the config it loads carries the instance's identity, whether remote
// control is switched on, and the install command. These assertions pin the
// contract between server.js and the browser, since nothing else would notice
// a rename until the card silently rendered blanks.

test("the page is given what it needs to write the setup commands", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const config = server.slice(server.indexOf('app.get("/api/config"'));
  const block = config.slice(0, config.indexOf("});"));

  assert.match(block, /instance:\s*\{\s*shortId/, "the page needs the instance short id for refs");
  assert.match(block, /remote:\s*\{\s*enabled/, "the page needs to know whether remote control is on");
  assert.match(block, /installCommand/, "the page needs an install command to show");
});

test("the shared token is never sent to the browser", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const config = server.slice(server.indexOf('app.get("/api/config"'));
  const block = config.slice(0, config.indexOf("});"));

  // Only the boolean may cross. Shipping the value would hand remote control of
  // this machine to anyone who can open the page.
  assert.ok(!/REMOTE_TOKEN\s*[,}]/.test(block), "the raw token must not be in the config payload");
  assert.match(block, /REMOTE_TOKEN\.trim\(\)\.length > 0/, "only the enabled flag should be derived from it");
});

test("the install command can be repointed by a fork or a mirror", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /process\.env\.PRSNOOZE_INSTALL_COMMAND/);
});

test("the card exists in the page and every command has a copy button", () => {
  for (const id of ["cli-toggle", "cli-backdrop", "cli-install", "cli-token", "cli-add", "cli-use"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  // Each copy button must name a command element that actually exists, or it
  // copies an empty string and looks broken.
  const targets = [...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 4, "every command line should be copyable");
  for (const target of targets) {
    const inPage = html.includes(`id="${target}"`);
    const inScript = app.includes(`id="${target}"`);
    assert.ok(inPage || inScript, `copy button targets #${target}, which is never rendered`);
  }
});

test("a host on localhost is warned that the URL is useless to colleagues", () => {
  // The whole point of the card is handing a colleague a line that works. A
  // localhost origin does not, and only the page can notice that.
  assert.match(app, /localhost\|127\\?\.0\\?\.0\\?\.1/);
  assert.match(app, /LAN or Tailscale/);
});

test("only the host is told how to switch remote access on", () => {
  // Matches how the usage chip already behaves: the person who can fix it is
  // the only one who gets the fix.
  const card = app.slice(app.indexOf("function renderCliCard"));
  assert.match(card, /else if \(isHost\)/);
  assert.match(card, /PRSNOOZE_REMOTE_TOKEN=\$\(openssl rand -hex 32\)/);
});

test("the card says what sharing the token actually costs", () => {
  // A setup guide that hides the consequence is how someone ends up handing out
  // control of their machine without realising.
  assert.match(app, /spending this[\s\S]{0,40}host's plan/);
  assert.match(app, /GitHub identity/);
});
