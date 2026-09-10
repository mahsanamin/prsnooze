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
  process.env.PRSNOOZE_HOME = path.join(home, ".prsnooze");
  process.env.REVIEW_PROVIDERS = "claude,codex";
  process.env.CODEX_BIN = "/bin/true";
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
    const settingRequests = [];
    page.on("request", (request) => {
      if (request.url() === `${base}/api/settings` && request.method() === "POST") settingRequests.push(request.postDataJSON());
    });
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
    await page.locator('input[data-provider="codex"]').uncheck();
    await page.locator("#settings-password").fill("ui-test-only");
    await page.locator("#settings-save").click();
    await page.waitForFunction(() => document.querySelector("#settings-backdrop").hidden);
    assert.deepEqual(settingRequests[0].disabledProviders, ["codex"]);
    assert.deepEqual((await (await page.request.get(`${base}/api/config`)).json()).admission.disabledProviders, ["codex"]);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#profile-avatar").src.endsWith("/avatars/coral.svg"));
    assert.equal(await page.locator('#provider-select option[value="codex"]').evaluate((option) => option.disabled), true);
    assert.equal(await page.locator('#provider-select option[value="claude"]').evaluate((option) => option.disabled), false);
    // Real desktop-file upload: canvas resize/encode, save, HTTP delivery,
    // browser decode and persistence after reload, under the hidden data home.
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => !document.querySelector("#settings-save").disabled);
    assert.equal(await page.locator("#settings-password").isVisible(), false);
    assert.equal(await page.locator("#settings-unlocked").isVisible(), true);
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext("2d").fillRect(0, 0, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#avatar-upload").setInputFiles({ name: "my-picture.png",
      mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(() => {
      const img = document.querySelector("#settings-avatar-preview");
      return img.src.startsWith("data:image/") && img.naturalWidth === 256;
    });
    await page.locator("#settings-save").click();
    await page.waitForFunction(() => document.querySelector("#settings-backdrop").hidden);
    await page.reload();
    await page.waitForFunction(() => {
      const img = document.querySelector("#profile-avatar");
      return img.src.includes("/api/profile/avatar?") && img.complete && img.naturalWidth === 256;
    });
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => !document.querySelector("#settings-save").disabled);
    await page.locator('input[data-provider="claude"]').uncheck();
    await page.locator("#settings-save").click();
    await page.waitForFunction(() => document.querySelector("#settings-backdrop").hidden);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#submit-btn").textContent === "Provider disabled");
    assert.equal(await page.locator("#submit-btn").isDisabled(), true);
    await page.locator("#profile-toggle").click();
    await page.waitForFunction(() => !document.querySelector("#settings-save").disabled);
    await page.locator('input[data-provider="codex"]').check();
    await page.locator("#settings-save").click();
    await page.waitForFunction(() => document.querySelector("#settings-backdrop").hidden);
    await page.waitForFunction(() => !document.querySelector("#submit-btn").disabled);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#provider-select").value === "codex");
    assert.equal(await page.locator("#provider-pick").isVisible(), false);
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
    assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }).includes("ui-test-only")), false);
    assert.equal(settingRequests.length, 4);
    assert.ok(settingRequests.every((body) => !("password" in body)));
    await page.locator("#settings-lock").click();
    await page.waitForFunction(() => !document.querySelector("#settings-credentials").hidden);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("prsnooze:settings-session")), null);
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
    await page.locator("#settings-close").click();
    await page.setViewportSize({ width: 1440, height: 960 });
    // A display-only review fixture: no CLI execution or GitHub review.
    await page.route("**/api/jobs/ui-fixture/**", (route) => route.fulfill({ json: { events: [] } }));
    await page.evaluate(async () => {
      await loadConfig();
      applySnapshot({ jobs: [{ id: "ui-fixture", state: "done", provider: "claude",
        prUrl: "https://github.com/example/demo/pull/1", title: "Example review",
        createdAt: Date.now(), finishedAt: Date.now(), outcome: "commented" }] });
      selectReview("ui-fixture");
    });
    assert.equal(await page.evaluate(() => document.body.classList.contains("hero-mode")), false);
    assert.equal(await page.locator("#provider-select").inputValue(), "codex");
    assert.equal(await page.locator("#provider-pick").isVisible(), false);
    assert.equal(await page.locator(".topbar #composer").count(), 0);
    // Stress the actual crowded-header case with both providers and a long
    // model label, without submitting a real review.
    await page.evaluate(() => {
      applyPublicSettings({ admission: { ...instanceSettings, disabledProviders: [] } });
      document.querySelector("#model-chip").hidden = false;
      document.querySelector("#model-chip").textContent = "Opus 5 (1M context) · effort: xhigh";
    });
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 960 });
      const geometry = await page.evaluate(() => {
        const top = document.querySelector(".topbar").getBoundingClientRect();
        const row = document.querySelector("#composer-top").getBoundingClientRect();
        const input = document.querySelector("#pr-url").getBoundingClientRect();
        const button = document.querySelector("#submit-btn").getBoundingClientRect();
        return { below: row.top >= top.bottom, aligned: Math.abs(row.width - top.width) < 2,
          inputWidth: input.width, fits: button.right <= innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(geometry.below, true);
      assert.equal(geometry.aligned, true);
      assert.equal(geometry.fits, true);
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.inputWidth > (width >= 1024 ? 500 : 65));
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screenshot({ path: path.join(home, "review.png") });
    assert.deepEqual(errors, []);
    console.log(`Settings UI passed: desktop/mobile, offline avatars, custom upload/reload in hidden data home, old server, failed config/retry. Screenshots: ${home}`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
