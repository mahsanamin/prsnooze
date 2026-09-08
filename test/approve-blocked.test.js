"use strict";

// The right password, and the approval still doesn't land.
//
// The password authorises a person; it never certified the PR. This is the
// endpoint half of lib/approval-gate.js (unit-tested in
// approval-gate-blockers.test.js): the refusal has to happen before `gh pr
// review --approve` runs, come back as something other than a password error,
// and leave a trace on the job — "I typed the password and nothing happened"
// has to be answerable later.
//
// `gh` is a shim on PATH, so nothing here touches GitHub, and the shim's log is
// how the test proves no approval was posted.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const PASSWORD = "correct-horse-battery-staple";
const PR_URL = "https://github.com/o/r/pull/7";
const HEAD = "deadbeef";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-blocked-"));
const GH_LOG = path.join(tmp, "gh.log");
// The shim reads this file for its graphql answer, so a test can change the
// PR's state between requests without restarting the server.
const PR_STATE = path.join(tmp, "pr.json");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/bin/sh\necho "$@" >> ${JSON.stringify(GH_LOG)}\n` +
    `case "$1 $2" in\n` +
    `  "api graphql") cat ${JSON.stringify(PR_STATE)} ;;\n` +
    `  *) case "$1" in\n       api) echo host-bot ;;\n       *) echo '{"number":7,"state":"OPEN"}' ;;\n     esac ;;\n` +
    `esac\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PRSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prsnooze-home-"));
process.env.MANUAL_APPROVE_PASSWORD = PASSWORD;

const { start, jobs } = require("../server");

function setPr({ threads = [], reviews = [], latestReviews = [], state = "OPEN" } = {}) {
  fs.writeFileSync(
    PR_STATE,
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 7,
            state,
            isDraft: false,
            reviewDecision: null,
            headRefOid: HEAD,
            author: { login: "someone-else" },
            reviewThreads: { nodes: threads },
            reviews: { nodes: reviews },
            latestOpinionatedReviews: { nodes: latestReviews },
          },
        },
      },
    }),
  );
}

const ghLines = (needle) =>
  (fs.existsSync(GH_LOG) ? fs.readFileSync(GH_LOG, "utf8").split("\n") : []).filter((l) => l.includes(needle));
const approvalsPosted = () => ghLines("pr review").length;

let server;
let base;

test.before(async () => {
  server = start(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { try { server.close(); } catch {} });

// A fresh job per test: the endpoint mutates the one it approves, and a shared
// job would make the order of these tests matter.
let n = 0;
function newJob() {
  const id = `j${++n}`;
  jobs.set(id, {
    id, prUrl: PR_URL, state: "done", events: [], createdAt: Date.now(),
    prMeta: { number: 7, authorLogin: "someone-else" },
  });
  return id;
}
const approve = (id) =>
  fetch(`${base}/api/jobs/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });

test("an unresolved critical comment refuses the approval, and nothing is posted", async () => {
  setPr({
    threads: [
      {
        isResolved: false,
        isOutdated: false,
        path: "lib/auth.js",
        line: 41,
        comments: { nodes: [{ body: "🔴 the token is compared with `==`", author: { login: "alice" } }] },
      },
    ],
  });
  const id = newJob();
  const before = approvalsPosted();
  const r = await approve(id);

  // 409, not 401: the password was right. A 401 would send the browser back to
  // the password field, which is the one thing that wasn't wrong.
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, "OPEN_CRITICAL_COMMENTS");
  assert.match(body.error, /lib\/auth\.js:41/);
  assert.match(body.error, /@alice/);
  assert.equal(body.blockers.length, 1);
  assert.equal(approvalsPosted(), before, "no approval may reach GitHub");
  assert.notEqual(jobs.get(id).outcome, "approved");
});

test("the refusal is recorded on the job", async () => {
  setPr({ latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "bob" } }] });
  const id = newJob();
  const r = await approve(id);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "CHANGES_REQUESTED");
  const logged = jobs.get(id).events.filter((e) => /Approval refused/.test(e.message || ""));
  assert.equal(logged.length, 1, "recorded once, not twice");
  assert.match(logged[0].message, /CHANGES_REQUESTED/);
});

test("prsnooze's own critical findings on the current head refuse a force-approve", async () => {
  setPr({
    reviews: [
      {
        state: "COMMENTED",
        body: "## Findings\n\n### 🔴 Critical\n- `lib/pay.js:88` — rounds before tax.",
        author: { login: "host-bot" },
        commit: { oid: HEAD },
      },
    ],
  });
  const id = newJob();
  const before = approvalsPosted();
  const r = await approve(id);
  assert.equal(r.status, 409);
  assert.equal(approvalsPosted(), before);
});

test("a clean PR still approves — the gate blocks findings, not approving", async () => {
  setPr({
    threads: [
      {
        isResolved: true,
        isOutdated: false,
        path: "lib/auth.js",
        line: 41,
        comments: { nodes: [{ body: "🔴 was broken, now fixed", author: { login: "alice" } }] },
      },
    ],
    reviews: [{ state: "COMMENTED", body: "🟡 minor: spacing", author: { login: "host-bot" }, commit: { oid: HEAD } }],
  });
  const id = newJob();
  const r = await approve(id);
  assert.equal(r.status, 200, JSON.stringify(await r.json().catch(() => ({}))));
  assert.equal(jobs.get(id).outcome, "approved");
  assert.equal(ghLines(`pr review ${PR_URL} --approve`).length, 1);
});

test("an unreadable PR holds the approval rather than posting it blind", async () => {
  fs.writeFileSync(PR_STATE, "not json at all");
  const id = newJob();
  const before = approvalsPosted();
  const r = await approve(id);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "UNVERIFIED");
  assert.equal(approvalsPosted(), before);
});
