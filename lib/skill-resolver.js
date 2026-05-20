const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const BUNDLED_SKILL_PATH = path.resolve(
  __dirname,
  "..",
  "skills",
  "default-review",
  "SKILL.md",
);

/**
 * Locate the PR-review skill to inline into the prompt. We can't dispatch
 * skills via the Skill tool when they're marked `disable-model-invocation:
 * true` (the convention for the user's `aa-*` skills), so we inline the
 * body instead.
 *
 * Search order, most-specific first:
 *   1. <worktree>/.claude/skills/aa-review-pr/SKILL.md       (project)
 *   2. <worktree>/.claude/skills/review-pr/SKILL.md          (project alt)
 *   3. ~/.claude/skills/aa-review-pr/SKILL.md                (user)
 *   4. ~/.claude/skills/review-pr/SKILL.md                   (user alt)
 *   5. <prsnooze-repo>/skills/default-review/SKILL.md        (bundled)
 *
 * The bundled fallback always exists, so a successful resolution is the
 * normal case — `{ skill: null }` only happens if the bundled file is
 * missing (broken install).
 *
 * Returns { skill, attempted } where skill is { name, path, body,
 * frontmatter, source } and `source` is one of "project" | "user" |
 * "bundled". `attempted` is every path checked, useful for the UI.
 */
async function resolveReviewSkill(worktreePath) {
  const home = os.homedir();
  const candidates = [
    { name: "aa-review-pr", path: path.join(worktreePath, ".claude/skills/aa-review-pr/SKILL.md"), source: "project" },
    { name: "review-pr",    path: path.join(worktreePath, ".claude/skills/review-pr/SKILL.md"),    source: "project" },
    { name: "aa-review-pr", path: path.join(home, ".claude/skills/aa-review-pr/SKILL.md"),         source: "user" },
    { name: "review-pr",    path: path.join(home, ".claude/skills/review-pr/SKILL.md"),            source: "user" },
    { name: "prsnooze-default-review", path: BUNDLED_SKILL_PATH,                                    source: "bundled" },
  ];

  const attempted = [];
  for (const c of candidates) {
    attempted.push(c.path);
    let raw;
    try {
      raw = await fsp.readFile(c.path, "utf8");
    } catch {
      continue;
    }
    const { body, frontmatter } = splitFrontmatter(raw);
    return {
      skill: { name: c.name, path: c.path, body, frontmatter, source: c.source },
      attempted,
    };
  }
  return { skill: null, attempted };
}

function splitFrontmatter(raw) {
  // Match an opening "---\n" followed by anything (non-greedy) up to a
  // closing "\n---\n". If absent, the whole content is body.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { body: raw, frontmatter: "" };
  return { frontmatter: m[1], body: m[2] };
}

module.exports = { resolveReviewSkill, splitFrontmatter, BUNDLED_SKILL_PATH };
