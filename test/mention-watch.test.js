"use strict";

// The mention watch queues reviews under the host's GitHub identity, on a
// timer, with nobody watching. These tests pin who can trigger it and that a
// mention is acted on once.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMentionWatcher, mentions } = require("../lib/mention-watch");
const { normalizeSettings } = require("../lib/instance-settings");

const PR = "https://github.com/acme/app/pull/12";
const LOGIN = "hostdev";
const T0 = Date.parse("2026-10-05T10:00:00Z");

function comment(over = {}) {
  return {
    key: "issue-comment:1",
    body: `@${LOGIN} can you review this?`,
    author: "teammate",
    authorType: "User",
    association: "MEMBER",
    createdAt: T0 + 60_000,
    url: `${PR}#issuecomment-1`,
    ...over,
  };
}

function setup({ comments = [comment()], login = LOGIN, enqueue, isPrActive } = {}) {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-mentions-"));
  let clock = T0;
  const queued = [];
  const searches = [];
  const watcher = createMentionWatcher({
    dataHome,
    getLogin: async () => login,
    enqueue: enqueue || (async (request) => { queued.push(request); return { jobId: `job-${queued.length}` }; }),
    isPrActive,
    reader: {
      searchMentionedPrs: async (who, since) => { searches.push({ who, since }); return [PR]; },
      commentsSince: async () => comments,
    },
    now: () => clock,
  });
  watcher.configure({ enabled: true, intervalMinutes: 30 });
  watcher.stop();
  return { watcher, queued, searches, dataHome, tick: (ms) => { clock += ms; } };
}

test("a collaborator's comment mention queues one review, once", async () => {
  const { watcher, queued, tick } = setup();
  tick(30 * 60_000);
  await watcher.pollOnce();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].prUrl, PR);
  assert.equal(queued[0].requestedBy.source, "mention");
  assert.match(queued[0].requestedBy.label, /@teammate mentioned @hostdev/);
  tick(30 * 60_000);
  await watcher.pollOnce();
  assert.equal(queued.length, 1, "the same comment must not queue a second review");
  assert.equal(watcher.status().lastError, null);
});

test("only owners, members and collaborators can trigger a review", async () => {
  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", ""]) {
    const { watcher, queued, tick } = setup({ comments: [comment({ association })] });
    tick(60_000 * 30);
    await watcher.pollOnce();
    assert.equal(queued.length, 0, `${association || "missing"} association must not trigger`);
  }
});

test("bots, the host's own comments, quotes and code samples do not count", async () => {
  const ignored = [
    comment({ key: "a", author: "dependabot[bot]", authorType: "Bot" }),
    comment({ key: "b", author: LOGIN, association: "OWNER" }),
    comment({ key: "c", body: `> @${LOGIN} can you review this?\nthanks` }),
    comment({ key: "d", body: "```\n@" + LOGIN + "\n```" }),
    comment({ key: "e", body: `cc @${LOGIN}-bot and mail me at x@${LOGIN}` }),
  ];
  const { watcher, queued, tick } = setup({ comments: ignored });
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 0);
});

test("mentions from before the watch was turned on are ignored", async () => {
  const { watcher, queued, searches, tick } = setup({ comments: [comment({ createdAt: T0 - 60 * 60_000 })] });
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 0);
  assert.equal(searches[0].who, LOGIN);
});

test("a PR already under review is not queued again", async () => {
  const { watcher, queued, tick } = setup({ isPrActive: () => true });
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 0);
});

test("a mention refused by admission is retried on the next check", async () => {
  let refuse = true;
  const queued = [];
  const { watcher, tick } = setup({
    enqueue: async (request) => {
      if (refuse) throw new Error("This PRSnooze instance is not accepting new reviews.");
      queued.push(request);
      return { jobId: "job-1" };
    },
  });
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 0);
  assert.match(watcher.status().lastError, /not accepting new reviews/);
  refuse = false;
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 1);
  assert.equal(watcher.status().lastError, null);
});

test("without a signed-in gh account it reports the problem and queues nothing", async () => {
  const { watcher, queued, tick } = setup({ login: null });
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 0);
  assert.match(watcher.status().lastError, /gh is not signed in/);
});

test("handled comments survive a restart", async () => {
  const { watcher, queued, dataHome, tick } = setup();
  tick(60_000 * 30);
  await watcher.pollOnce();
  assert.equal(queued.length, 1);
  const again = [];
  const restarted = createMentionWatcher({
    dataHome,
    getLogin: async () => LOGIN,
    enqueue: async (request) => { again.push(request); return {}; },
    reader: { searchMentionedPrs: async () => [PR], commentsSince: async () => [comment()] },
    now: () => T0 + 60 * 60_000,
  });
  await restarted.pollOnce();
  assert.equal(again.length, 0);
});

test("mention matching is a whole login, case-insensitive", () => {
  assert.equal(mentions("hey @HostDev please look", LOGIN), true);
  assert.equal(mentions("@hostdev", LOGIN), true);
  assert.equal(mentions("@hostdevs", LOGIN), false);
  assert.equal(mentions("@hostdev-team", LOGIN), false);
  assert.equal(mentions("x@hostdev", LOGIN), false);
  assert.equal(mentions("anything", null), false);
});

test("settings default the watch off and keep the interval in range", () => {
  assert.deepEqual(normalizeSettings({}).mentionWatch, { enabled: false, intervalMinutes: 5 });
  assert.deepEqual(normalizeSettings({}).autoResume, { enabled: false, intervalMinutes: 5 });
  assert.equal(normalizeSettings({ mentionWatch: { enabled: true, intervalMinutes: 1 } }).mentionWatch.intervalMinutes, 5);
  assert.equal(normalizeSettings({ mentionWatch: { intervalMinutes: 9999 } }).mentionWatch.intervalMinutes, 240);
  assert.equal(normalizeSettings({ mentionWatch: { enabled: "yes" } }).mentionWatch.enabled, false);
});
