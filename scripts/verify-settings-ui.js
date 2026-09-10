"use strict";

// Run with Playwright available in NODE_PATH and CHROMIUM_PATH set if using a
// system browser. This uses an isolated data home and never queues a review.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { chromium } = require("playwright");

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-ui-"));
  process.env.PRSNOOZE_HOME = home;
  process.env.REVIEW_PROVIDERS = "claude";
  process.env.CLAUDE_BIN = "/bin/true";
  process.env.GH_BIN = "/bin/true";
  process.env.PRSNOOZE_SETTINGS_PASSWORD = "ui-test-only";
  const server = require("../server").start(0);
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox"] });
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // No internet images/fonts allowed: all profile pictures must work offline.
    await page.route("**/*", (route) => route.request().url().startsWith(base)
      ? route.continue() : route.abort());
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#profile-avatar").naturalWidth > 0);
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => !document.querySelector("#settings-save").disabled);
    assert.equal(await page.locator("#settings-backdrop").isVisible(), true);
    assert.equal(await page.locator(".avatar-choice").count(), 20);
    await page.waitForFunction(() => [...document.querySelectorAll(".avatar-choice img")]
      .every((img) => img.complete && img.naturalWidth > 0));
    await page.locator('[aria-label="Use Coral avatar"]').click();
    await page.locator("#settings-password").fill("ui-test-only");
    await page.locator("#settings-save").click();
    await page.waitForFunction(() => document.querySelector("#settings-backdrop").hidden);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#profile-avatar").src.endsWith("/avatars/coral.svg"));
    const cover = await page.evaluate(() => {
      const style = getComputedStyle(document.body, "::after");
      return { opacity: Number(style.opacity), mask: style.maskImage, image: style.backgroundImage };
    });
    assert.ok(cover.opacity >= 0.8);
    assert.equal(cover.mask, "none");
    assert.match(cover.image, /sleepy-cat/);
    await page.screenshot({ path: path.join(home, "desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => !document.querySelector("#settings-save").disabled);
    assert.equal(await page.locator("#settings-backdrop").isVisible(), true);
    await page.screenshot({ path: path.join(home, "mobile.png") });
    await page.locator("#settings-close").click();

    // Reproduce a pulled checkout served by the old, still-running process.
    await page.route("**/api/config", (route) => route.fulfill({ json: { host: "Old server" } }));
    await page.reload();
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => document.querySelector("#settings-error").textContent.includes("older version"));
    assert.equal(await page.locator("#settings-save").isDisabled(), true);
    assert.ok(await page.locator("#profile-avatar").evaluate((img) => img.naturalWidth > 0));
    await page.locator("#settings-close").click();
    await page.unroute("**/api/config");

    await page.route("**/api/config", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    await page.reload();
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => document.querySelector("#settings-error").textContent.includes("Could not load"));
    assert.equal(await page.locator("#settings-save").isDisabled(), true);
    await page.locator("#settings-close").click();
    await page.unroute("**/api/config");
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => !document.querySelector("#settings-save").disabled);
    assert.deepEqual(errors, []);
    console.log(`Settings UI passed: desktop/mobile, offline avatars, save/reload, old server, failed config/retry. Screenshots: ${home}`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
