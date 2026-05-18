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
  return {
    ...parsed,
    title: data.title || "",
    state: data.state || "",
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    authorLogin: data.author?.login || "",
    isDraft: !!data.isDraft,
  };
}

module.exports = { parsePrUrl, fetchPrMetadata };
