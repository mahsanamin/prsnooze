const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const BUNDLED_SKILL_PATH = path.resolve(
  __dirname,
  "..",
  "skills",
  "default-review",
  "SKILL.md",
);

const PROJECT_CANDIDATES = [
  { name: "aa-review-pr", rel: ".claude/skills/aa-review-pr/SKILL.md" },
  { name: "review-pr", rel: ".claude/skills/review-pr/SKILL.md" },
];

/** Read one path out of a git ref. Returns null if it isn't there. */
async function gitShow(repoPath, ref, relPath) {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoPath, "show", `${ref}:${relPath}`],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Locate the PR-review skill to inline into the prompt. We can't dispatch
 * skills via the Skill tool when they're marked `disable-model-invocation:
 * true` (the convention for the user's `aa-*` skills), so we inline the
 * body instead.
 *
 * Search order, most-specific first:
 *   1. .claude/skills/aa-review-pr/SKILL.md                  (project)
 *   2. .claude/skills/review-pr/SKILL.md                     (project alt)
 *   3. ~/.claude/skills/aa-review-pr/SKILL.md                (user)
 *   4. ~/.claude/skills/review-pr/SKILL.md                   (user alt)
 *   5. <prsnooze-repo>/skills/default-review/SKILL.md        (bundled)
 *
 * A project skill is read out of `baseRef` when one is given, NOT out of the
 * worktree — the worktree sits on the PR's head, and a PR does not get to
 * rewrite the playbook it is about to be reviewed with. A skill that exists
 * only on the PR branch is therefore treated as absent, and resolution falls
 * through to the user-level or bundled skill.
 *
 * The bundled fallback always exists, so a successful resolution is the
 * normal case — `{ skill: null }` only happens if the bundled file is
 * missing (broken install).
 *
 * Returns { skill, attempted } where skill is { name, path, body,
 * frontmatter, source, ref } and `source` is one of "project" | "user" |
 * "bundled". `attempted` is every path checked, useful for the UI.
 */
async function resolveReviewSkill(worktreePath, { repoPath = null, baseRef = null, onLog = null } = {}) {
  const home = os.homedir();
  const fromBase = !!(repoPath && baseRef);
  const candidates = [
    ...PROJECT_CANDIDATES.map((c) => ({
      name: c.name,
      rel: c.rel,
      path: path.join(worktreePath, c.rel),
      source: "project",
    })),
    { name: "aa-review-pr", path: path.join(home, ".claude/skills/aa-review-pr/SKILL.md"), source: "user" },
    { name: "review-pr", path: path.join(home, ".claude/skills/review-pr/SKILL.md"), source: "user" },
    { name: "prsnooze-default-review", path: BUNDLED_SKILL_PATH, source: "bundled" },
  ];

  const attempted = [];
  for (const c of candidates) {
    attempted.push(c.path);
    let raw = null;
    if (c.source === "project" && fromBase) {
      raw = await gitShow(repoPath, baseRef, c.rel);
      if (raw === null && (await readable(c.path))) {
        onLog?.(
          `Ignoring ${c.rel}: it exists only on the PR branch, not on ${baseRef}. A PR doesn't get to supply its own review playbook.`,
        );
        continue;
      }
    } else {
      raw = await readFile(c.path);
    }
    if (raw === null) continue;

    const { body, frontmatter } = splitFrontmatter(raw);
    return {
      skill: {
        name: c.name,
        path: c.path,
        body,
        frontmatter,
        source: c.source,
        ref: c.source === "project" && fromBase ? baseRef : null,
      },
      attempted,
    };
  }
  return { skill: null, attempted };
}

async function readFile(p) {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readable(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function splitFrontmatter(raw) {
  // Match an opening "---\n" followed by anything (non-greedy) up to a
  // closing "\n---\n". If absent, the whole content is body.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { body: raw, frontmatter: "" };
  return { frontmatter: m[1], body: m[2] };
}

module.exports = { resolveReviewSkill, splitFrontmatter, BUNDLED_SKILL_PATH };
