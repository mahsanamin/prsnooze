"use strict";

// Capture the real UI with fictional data in a disposable, credential-free
// container. No review is submitted; external browser requests are blocked.
// Usage: NODE_PATH=<playwright modules> CHROMIUM_PATH=<optional browser>
//   node scripts/capture-readme.js /tmp/prsnooze-review.png
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { chromium } = require("playwright");

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Pass a screenshot output path");
  if (fs.existsSync(path.join(__dirname, "..", ".env"))) {
    throw new Error("Use a clean container or checkout without .env for screenshots");
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-readme-"));
  Object.assign(process.env, {
    PRSNOOZE_HOME: home, PRSNOOZE_HOST: "Alex (demo)",
    REVIEW_PROVIDERS: "claude,codex", DEFAULT_REVIEW_PROVIDER: "codex",
    CLAUDE_BIN: "/bin/true", CODEX_BIN: "/bin/true", GH_BIN: "/bin/true",
    HERO_IMAGE: "/heroes/sleepy-cat.svg", PRSNOOZE_SETTINGS_PASSWORD: "demo-only",
  });
  const fixtureTime = Date.now();
  const jobs = [
    { id: "demo-codex", provider: "codex", title: "Handle empty search results gracefully",
      outcome: "commented", number: 42, offset: 0 },
    { id: "demo-claude", provider: "claude", title: "Add keyboard navigation tests",
      outcome: "approved", number: 41, offset: 600_000 },
    { id: "demo-docs", provider: "codex", title: "Clarify local development setup",
      outcome: "approved", number: 40, offset: 1200_000 },
  ].map((job) => ({ ...job, state: "done", sessionId: `${job.id}-session`,
    prUrl: `https://github.com/example/search-app/pull/${job.number}`,
    createdAt: fixtureTime - job.offset - 180_000, finishedAt: fixtureTime - job.offset,
    prMeta: { number: job.number, title: job.title, nameWithOwner: "example/search-app", authorLogin: "demo-author",
      additions: 48, deletions: 12, changedFiles: 3 },
    prStatus: { ok: true, state: "OPEN", checkedAt: fixtureTime },
    events: [
      { kind: "log", text: "Demo: prepared a separate checkout at the PR head." },
      { kind: "log", text: "Demo: loaded the project's review rules." },
      { kind: "log", text: "Demo: checked search handling and regression tests." },
    ],
    summary: { durationMs: 180_000, numTurns: 8,
      finalText: job.id === "demo-codex"
        ? "**Review summary**\n\nThe empty-results state is clear and the existing search behavior is preserved.\n\n**Suggested follow-up**\n\nAdd a regression test for clearing a query while a request is still pending. An older response should not replace the empty state.\n\n**Checked**\n\n- Empty, loading, and successful results\n- Keyboard navigation through the search field\n- Tests covering the new empty-state message\n\n**Demo data:** this screenshot does not represent a real GitHub review."
        : "Demo review: no blocking findings in this example." },
  }));
  const server = require("../server").start(0);
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base || route.request().method() !== "GET") return route.abort();
      if (url.pathname === "/api/model" || url.pathname === "/api/usage") return route.fulfill({ json: { ok: false } });
      const job = jobs.find((entry) => url.pathname.startsWith(`/api/jobs/${entry.id}`));
      if (job) {
        const json = url.pathname.endsWith("/pr-state") ? job.prStatus
          : url.pathname.endsWith("/resume-check") ? { resumable: true, reason: "New replies are ready to review." }
          : job;
        return route.fulfill({ json });
      }
      return route.continue();
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#profile-avatar").naturalWidth > 0);
    await page.evaluate((jobs) => { applySnapshot({ jobs }); selectReview(jobs[0].id); }, jobs);
    await page.locator(".summary-detail").waitFor();
    await page.locator('button.resume[data-resume-id="demo-codex"]').waitFor();
    await page.locator("#provider-select").selectOption("codex");
    await page.evaluate(async () => {
      document.querySelector("#profile-avatar").src = "/avatars/aurora.svg";
      await document.fonts.ready;
    });
    await page.waitForFunction(() => document.querySelector("#profile-avatar").complete);
    assert.equal(await page.locator("#host-name").textContent(), "by Alex (demo)");
    assert.equal(await page.locator("#recent-list .srow").count(), 3);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: output, animations: "disabled" });
    console.log(`Captured fictional demo UI: ${output}`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
