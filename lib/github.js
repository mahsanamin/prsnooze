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
  if (data.state && data.state !== "OPEN") {
    const err = new Error(`PR is ${data.state.toLowerCase()}, not OPEN. Refusing to review.`);
    err.code = "PR_NOT_OPEN";
    throw err;
  }
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

module.exports = {
  parsePrUrl,
  fetchPrMetadata,
  isTestPath,
  classifyDiffFiles,
  classifyTriviality,
  getSelfLogin,
  fetchOwnPostsSince,
  outcomeFromOwnPosts,
  hasOwnReviewOnSha,
};
