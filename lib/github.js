const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;

function parsePrUrl(input) {
  const url = String(input || "").trim();
  const m = url.match(PR_URL_RE);
  if (!m) {
    const err = new Error(
      `Not a GitHub PR URL: "${url}". Expected https://github.com/<owner>/<repo>/pull/<number>`,
    );
    err.code = "INVALID_PR_URL";
    throw err;
  }
  const [, owner, repo, numStr] = m;
  return {
    url,
    owner,
    repo: repo.replace(/\.git$/, ""),
    number: Number(numStr),
    nameWithOwner: `${owner}/${repo.replace(/\.git$/, "")}`,
  };
}

/**
 * A PR that is merged or closed is NOT a failure. Nothing went wrong; there is
 * simply no PR left to review, usually because it merged while the job sat in
 * the queue. `skip` tells the queue to end the job cleanly, so it reads as
 * skipped instead of a red ✗ the user is expected to go and look at.
 */
function notOpenError(rawState) {
  const state = String(rawState || "").toLowerCase();
  const err = new Error(`PR is ${state}, not open, so there is nothing to review.`);
  err.code = "PR_NOT_OPEN";
  err.skip = true;
  err.skipReason = "pr_not_open";
  err.skipMessage =
    state === "merged"
      ? "Nothing to review: this PR was already merged."
      : "Nothing to review: this PR is closed.";
  return err;
}

async function fetchPrMetadata(prUrl) {
  const parsed = parsePrUrl(prUrl);
  const fields = [
    "number",
    "title",
    "state",
    "url",
    "baseRefName",
    "headRefName",
    "author",
    "isDraft",
    "mergeable",
    "additions",
    "deletions",
    "changedFiles",
    "files",
    "headRefOid",
    "headRepository",
    "headRepositoryOwner",
    "reviews",
  ].join(",");
  let stdout;
  try {
    ({ stdout } = await execFileP("gh", ["pr", "view", parsed.url, "--json", fields], {
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (e) {
    const err = new Error(
      `gh pr view failed for ${parsed.url}. Check that gh is authenticated (gh auth status) and you can access this repo.\n${e.stderr || e.message}`,
    );
    err.code = "GH_FAILED";
    err.cause = e;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (e) {
    const err = new Error(`Could not parse gh output as JSON: ${e.message}`);
    err.code = "GH_PARSE";
    throw err;
  }
  if (data.state && data.state !== "OPEN") throw notOpenError(data.state);
  const files = Array.isArray(data.files) ? data.files : [];
  const sizeBreakdown = classifyDiffFiles(files);
  const triviality = classifyTriviality(files);
  const headRepoOwner = data.headRepositoryOwner?.login || parsed.owner;
  const headRepoName = data.headRepository?.name || parsed.repo;

  return {
    ...parsed,
    title: data.title || "",
    state: data.state || "",
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    headRefOid: data.headRefOid || "",
    headRepoOwner,
    headRepoName,
    authorLogin: data.author?.login || "",
    isDraft: !!data.isDraft,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changedFiles ?? 0,
    reviews: Array.isArray(data.reviews) ? data.reviews : [],
    triviality,
    ...sizeBreakdown,
  };
}

// Memoized self-login (the gh-authenticated user) — used to detect "have I
// already reviewed this commit?" so we don't double-post.
let _selfLogin = null;
async function getSelfLogin() {
  if (_selfLogin) return _selfLogin;
  try {
    const { stdout } = await execFileP("gh", ["api", "user", "--jq", ".login"], {
      maxBuffer: 1024 * 1024,
    });
    _selfLogin = stdout.trim();
    return _selfLogin;
  } catch {
    return null; // network/auth issue — caller decides
  }
}

function hasOwnReviewOnSha(reviews, sha, selfLogin) {
  if (!Array.isArray(reviews) || !sha || !selfLogin) return false;
  return reviews.some(
    (r) =>
      r?.commit?.oid === sha &&
      r?.author?.login === selfLogin &&
      ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(r?.state),
  );
}

// Coarse "is this PR trivial enough to keep the review terse?" classifier.
// Returns null when not trivial, or { kind } when it matches a known shape.
function classifyTriviality(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const paths = files.map((f) => f.path || f.filename || "");
  const allDocs = paths.every((p) =>
    /(^|\/)(README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE)(\.|$)|\.(md|mdx|rst|txt)$/i.test(p),
  );
  if (allDocs) return { kind: "docs" };
  const depsManifests = [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)go\.mod$/,
    /(^|\/)go\.sum$/,
    /(^|\/)Pipfile\.lock$/,
    /(^|\/)poetry\.lock$/,
    /(^|\/)requirements.*\.txt$/,
    /(^|\/)Gemfile\.lock$/,
    /(^|\/)Cargo\.lock$/,
    /(^|\/)Cargo\.toml$/,
    /(^|\/)build\.gradle(\.kts)?$/,
    /(^|\/)pom\.xml$/,
  ];
  const allDeps = paths.every((p) => depsManifests.some((re) => re.test(p)));
  if (allDeps) return { kind: "deps" };
  return null;
}

// Path patterns that mark a file as test code, across common ecosystems.
// Order matters only for performance — anything matching = test.
const TEST_PATH_PATTERNS = [
  /(^|\/)tests?\//i,                               // tests/, test/
  /(^|\/)__tests?__\//i,                            // __tests__/
  /(^|\/)spec\//i,                                  // spec/
  /(^|\/)e2e\//i,                                   // e2e/
  /(^|\/)cypress\//i,                               // cypress/
  /(^|\/)integration[-_]?tests?\//i,                // integration-tests/, integration_test/
  /(^|\/)src\/test\//i,                             // Java/Gradle/Kotlin convention
  /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/i,       // foo.test.ts, bar.spec.js
  /_test\.go$/i,                                    // foo_test.go
  /(^|\/)test_[^/]*\.py$/i,                         // test_foo.py
  /_test\.py$/i,                                    // foo_test.py
  /_spec\.rb$/i,                                    // foo_spec.rb
  /(Tests?|IntegrationTests?|Spec)\.(java|kt|kts|scala|groovy)$/i,
];

function isTestPath(p) {
  if (!p) return false;
  return TEST_PATH_PATTERNS.some((re) => re.test(p));
}

function classifyDiffFiles(files) {
  const out = {
    testFiles: 0,
    testAdditions: 0,
    testDeletions: 0,
    prodFiles: 0,
    prodAdditions: 0,
    prodDeletions: 0,
    fileBreakdown: [], // [{path, additions, deletions, isTest}]
  };
  for (const f of files) {
    const path = f.path || f.filename || "";
    const adds = f.additions ?? 0;
    const dels = f.deletions ?? 0;
    const isTest = isTestPath(path);
    out.fileBreakdown.push({ path, additions: adds, deletions: dels, isTest });
    if (isTest) {
      out.testFiles += 1;
      out.testAdditions += adds;
      out.testDeletions += dels;
    } else {
      out.prodFiles += 1;
      out.prodAdditions += adds;
      out.prodDeletions += dels;
    }
  }
  return out;
}

// Given the fileBreakdown from classifyDiffFiles, return the list of prod
// file paths that have a matching-name test file also changed in the PR.
// Match rules (strict): the test file's basename maps to the prod file's
// basename via one of these conventions:
//   Foo.java              ↔ FooTest.java, FooIntegrationTest.java, FooSpec.java
//   foo.ts / foo.tsx      ↔ foo.test.ts(x), foo.spec.ts(x)
//   foo.js                ↔ foo.test.js, foo.spec.js
//   foo.go                ↔ foo_test.go
//   foo.py                ↔ test_foo.py, foo_test.py
//   foo.rb                ↔ foo_spec.rb
//   foo.kt / foo.scala    ↔ FooTest.kt, FooSpec.kt, etc.
function findMatchingTests(fileBreakdown) {
  if (!Array.isArray(fileBreakdown)) return [];
  const prod = fileBreakdown.filter((f) => !f.isTest);
  const tests = fileBreakdown.filter((f) => f.isTest);
  if (prod.length === 0 || tests.length === 0) return [];

  const testBasenames = new Set(
    tests.map((t) => t.path.split("/").pop()).filter(Boolean),
  );

  const matched = [];
  for (const p of prod) {
    const base = p.path.split("/").pop();
    if (!base) continue;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    const stem = base.slice(0, dot);
    const ext = base.slice(dot); // includes leading "."

    const candidates = [
      `${stem}Test${ext}`,
      `${stem}IntegrationTest${ext}`,
      `${stem}Spec${ext}`,
      `${stem}.test${ext}`,
      `${stem}.spec${ext}`,
      `${stem}_test${ext}`,
      `${stem}_spec${ext}`,
      `test_${stem}${ext}`,
    ];
    if (candidates.some((c) => testBasenames.has(c))) {
      matched.push(p.path);
    }
  }
  return matched;
}

// --------------------------------------------------------------- resume ----
// Deciding whether a finished review is worth resuming. Kept in two halves on
// purpose: fetchResumeSignals() does the `gh` I/O, assessResumability() is pure
// so the decision can be tested without a GitHub account or a network.

/**
 * Read-only probe of everything that decides "should this review be resumed?".
 * Unlike fetchPrMetadata this does NOT throw on a closed/merged PR — a merged PR
 * is an answer ("nothing to resume"), not an error.
 */
async function fetchResumeSignals(prUrl) {
  const parsed = parsePrUrl(prUrl);
  const fields = ["number", "state", "reviewDecision", "headRefOid", "author", "reviews", "comments", "commits"].join(",");
  let pr = null;
  let error = null;
  try {
    const { stdout } = await execFileP("gh", ["pr", "view", parsed.url, "--json", fields], { maxBuffer: 8 * 1024 * 1024 });
    pr = JSON.parse(stdout);
  } catch (e) {
    error = (e.stderr || e.message || "gh pr view failed").toString().trim();
  }
  // Inline review-comment replies live on a different endpoint than issue
  // comments — this is where "the author answered your comment" actually shows
  // up, so it's worth the second call. A failure here is not fatal.
  let inlineComments = [];
  if (pr) {
    try {
      const { stdout } = await execFileP(
        "gh",
        ["api", `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`, "--paginate"],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const parsedJson = JSON.parse(stdout);
      if (Array.isArray(parsedJson)) inlineComments = parsedJson;
    } catch {
      inlineComments = [];
    }
  }
  const selfLogin = await getSelfLogin();
  return { pr, inlineComments, selfLogin, error };
}

const ts = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };

/**
 * Pure decision. Given the PR's current state and what we knew when the review
 * ran, say whether resuming makes sense and why.
 *
 * @param {object}   a
 * @param {object}   a.pr            `gh pr view --json …` payload
 * @param {object[]} a.inlineComments PR review comments (inline), newest anywhere
 * @param {string}   a.selfLogin     the gh identity prsnooze reviews as
 * @param {string}   a.reviewedSha   head SHA at the time of the last review
 * @param {number}   a.reviewedAt    epoch ms of the last review
 * @param {boolean}  a.hasSession    is there a Claude session to resume at all
 * @returns {{resumable: boolean, code: string, reason: string, signals: object}}
 */
function assessResumability({ pr, inlineComments = [], selfLogin = null, reviewedSha = "", reviewedAt = 0, hasSession = true }) {
  const verdict = (resumable, code, reason, signals = {}) => ({ resumable, code, reason, signals });

  if (!hasSession) {
    return verdict(false, "NO_SESSION", "No Claude session was recorded for this review, so there's nothing to resume — start a fresh review instead.");
  }
  if (!pr) {
    return verdict(false, "UNKNOWN", "Couldn't reach GitHub to check the PR's current state.");
  }

  const state = String(pr.state || "").toUpperCase();
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  const commits = Array.isArray(pr.commits) ? pr.commits : [];
  const issueComments = Array.isArray(pr.comments) ? pr.comments : [];
  const authorLogin = pr.author?.login || "";

  // Our own last review wins over the caller's timestamp when we can see it —
  // it's the authoritative "everything before this, we already looked at".
  const ourReviews = selfLogin ? reviews.filter((r) => r?.author?.login === selfLogin) : [];
  const ourLastReviewAt = ourReviews.reduce((max, r) => Math.max(max, ts(r.submittedAt)), 0);
  const since = Math.max(ourLastReviewAt, reviewedAt || 0);

  const signals = {
    prState: state,
    reviewDecision: pr.reviewDecision || null,
    headRefOid: pr.headRefOid || "",
    reviewedSha: reviewedSha || "",
    since,
    ourLastReviewAt,
    authorLogin,
  };

  if (state && state !== "OPEN") {
    return verdict(false, "PR_CLOSED", `The PR is ${state.toLowerCase()} — there's nothing left to review.`, signals);
  }

  // Already approved: by anyone (GitHub's own decision) or by us specifically.
  const weApproved = ourReviews.some((r) => String(r.state).toUpperCase() === "APPROVED");
  const decisionApproved = String(pr.reviewDecision || "").toUpperCase() === "APPROVED";
  signals.approvedByUs = weApproved;
  if (weApproved || decisionApproved) {
    return verdict(
      false,
      "APPROVED",
      weApproved ? "You already approved this PR — no follow-up review needed." : "The PR is already approved — no follow-up review needed.",
      signals,
    );
  }

  // What's new since we looked?
  const newCommits = commits.filter((c) => ts(c.committedDate) > since);
  const headMoved = !!(reviewedSha && pr.headRefOid && reviewedSha !== pr.headRefOid);
  signals.newCommitCount = newCommits.length;
  signals.headMoved = headMoved;

  // Replies to OUR inline comments, and anything the author said since.
  const ourCommentIds = new Set(
    inlineComments.filter((c) => selfLogin && c?.user?.login === selfLogin).map((c) => c.id),
  );
  const repliesToUs = inlineComments.filter(
    (c) => c?.in_reply_to_id && ourCommentIds.has(c.in_reply_to_id) && c?.user?.login !== selfLogin,
  );
  const otherNewComments = [...inlineComments, ...issueComments].filter((c) => {
    const login = c?.user?.login || c?.author?.login || "";
    const at = ts(c.created_at || c.createdAt);
    return login && login !== selfLogin && at > since;
  });
  signals.replyCount = repliesToUs.length;
  signals.newCommentCount = otherNewComments.length;
  signals.authorResponded = otherNewComments.some((c) => (c?.user?.login || c?.author?.login) === authorLogin);

  const parts = [];
  if (newCommits.length) parts.push(`${newCommits.length} new commit${newCommits.length === 1 ? "" : "s"}`);
  else if (headMoved) parts.push("the branch moved");
  if (repliesToUs.length) parts.push(`${repliesToUs.length} repl${repliesToUs.length === 1 ? "y" : "ies"} to your comments`);
  else if (signals.authorResponded) parts.push(`a reply from @${authorLogin}`);
  else if (otherNewComments.length) parts.push(`${otherNewComments.length} new comment${otherNewComments.length === 1 ? "" : "s"}`);

  if (parts.length) {
    return verdict(true, "HAS_UPDATES", `${parts.join(" and ")} since your review — worth re-checking whether the comments were addressed.`, signals);
  }

  return verdict(false, "NOTHING_NEW", "Nothing has changed since your review — no new commits and no replies to your comments.", signals);
}


// ------------------------------------------------------- posted outcome ----
// What did we actually post? Sniffing the Bash commands Claude ran is a guess:
// it misses any form the pattern doesn't know (short flags, `gh api`, a wrapper
// script), and it can't tell a command that ran from one that failed. GitHub
// knows. These two are the authoritative check, again split into I/O and a pure
// decision so the decision is testable.

/**
 * Everything WE posted on this PR at or after `sinceMs`, as seen by GitHub.
 * `checked: false` means the lookup itself failed — the caller must not read
 * "nothing found" as "nothing posted".
 */
async function fetchOwnPostsSince(prUrl, sinceMs) {
  const parsed = parsePrUrl(prUrl);
  const selfLogin = await getSelfLogin();
  if (!selfLogin) return { checked: false, reason: "gh identity unknown", reviews: [], comments: 0, inline: 0 };
  try {
    const { stdout } = await execFileP("gh", ["pr", "view", parsed.url, "--json", "reviews,comments"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    const cutoff = Number(sinceMs) || 0;
    // A small grace window: the review is posted moments before the process
    // exits, and clock skew between us and GitHub shouldn't lose it.
    const floor = cutoff - 60_000;
    const mine = (arr, at, who) =>
      (Array.isArray(arr) ? arr : []).filter((x) => {
        const login = who(x);
        const t = Date.parse(at(x) || "");
        return login === selfLogin && Number.isFinite(t) && t >= floor;
      });
    const reviews = mine(data.reviews, (r) => r.submittedAt, (r) => r?.author?.login).map((r) =>
      String(r.state || "").toUpperCase(),
    );
    const comments = mine(data.comments, (c) => c.createdAt, (c) => c?.author?.login).length;

    let inline = 0;
    try {
      const { stdout: raw } = await execFileP(
        "gh",
        ["api", `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`, "--paginate"],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const list = JSON.parse(raw);
      inline = mine(list, (c) => c.created_at, (c) => c?.user?.login).length;
    } catch {
      // Inline comments are a bonus signal; reviews/comments already decide it.
    }
    return { checked: true, reviews, comments, inline, selfLogin };
  } catch (e) {
    return { checked: false, reason: (e.stderr || e.message || "gh failed").toString().trim(), reviews: [], comments: 0, inline: 0 };
  }
}

/**
 * Turn that into an outcome. Returns null when GitHub couldn't be consulted, so
 * the caller can fall back instead of asserting something untrue.
 */
function outcomeFromOwnPosts(posts) {
  if (!posts || !posts.checked) return null;
  const states = Array.isArray(posts.reviews) ? posts.reviews : [];
  // Strongest signal first: an approval or a change request outranks a plain
  // comment posted in the same run.
  if (states.includes("APPROVED")) return "approved";
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("COMMENTED")) return "commented";
  if ((posts.comments || 0) > 0 || (posts.inline || 0) > 0) return "commented";
  return "no_new_findings";
}

/**
 * Should this resume request run? Pure, so the rule that matters most — force
 * cannot override a merged or closed PR — is pinned down by tests rather than
 * living inline in a route handler.
 *
 * `forcible` tells the caller whether offering a Force button makes any sense.
 */
function resumeGate({ assessment, forced }) {
  const code = assessment?.code;
  // Nothing to review, or nothing to resume with: force changes neither.
  if (code === "PR_CLOSED" || code === "NO_SESSION") {
    return { allow: false, forcible: false, reason: assessment.reason };
  }
  if (assessment?.resumable) return { allow: true, forcible: true, reason: assessment.reason };
  // Everything else is advice — an approved PR or an unchanged one can still be
  // re-reviewed on purpose.
  if (forced) return { allow: true, forcible: true, reason: `forced — ${assessment?.reason || "no reason given"}` };
  return { allow: false, forcible: true, reason: assessment?.reason || "not resumable" };
}

module.exports = {
  parsePrUrl,
  fetchPrMetadata,
  notOpenError,
  isTestPath,
  classifyDiffFiles,
  classifyTriviality,
  findMatchingTests,
  getSelfLogin,
  fetchResumeSignals,
  assessResumability,
  resumeGate,
  fetchOwnPostsSince,
  outcomeFromOwnPosts,
  hasOwnReviewOnSha,
};
