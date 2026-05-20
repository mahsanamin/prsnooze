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

  return {
    ...parsed,
    title: data.title || "",
    state: data.state || "",
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    authorLogin: data.author?.login || "",
    isDraft: !!data.isDraft,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changedFiles ?? 0,
    ...sizeBreakdown,
  };
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

module.exports = { parsePrUrl, fetchPrMetadata, isTestPath, classifyDiffFiles };
