const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

/**
 * Locate the project's PR review skill and load its body so we can inline
 * it into the prompt. We do this because skills with
 * `disable-model-invocation: true` (which is the convention across the
 * user's `aa-*` skills) cannot be dispatched by the model via the Skill
 * tool; the only way to honor them in headless mode is to feed their
 * instructions directly to the model.
 *
 * Search order, most-specific first:
 *   1. <worktree>/.claude/skills/aa-review-pr/SKILL.md
 *   2. <worktree>/.claude/skills/review-pr/SKILL.md
 *   3. ~/.claude/skills/aa-review-pr/SKILL.md
 *   4. ~/.claude/skills/review-pr/SKILL.md
 *
 * Returns { skill, attempted }, where skill is { name, path, body,
 * frontmatter } when found and null when not. `body` is SKILL.md with
 * the leading `--- … ---` block stripped. `attempted` is the full list of
 * paths checked, in order — useful for the UI when reporting "no skill found".
 */
async function resolveReviewSkill(worktreePath) {
  const home = os.homedir();
  const candidates = [
    { name: "aa-review-pr", path: path.join(worktreePath, ".claude/skills/aa-review-pr/SKILL.md") },
    { name: "review-pr",    path: path.join(worktreePath, ".claude/skills/review-pr/SKILL.md") },
    { name: "aa-review-pr", path: path.join(home, ".claude/skills/aa-review-pr/SKILL.md") },
    { name: "review-pr",    path: path.join(home, ".claude/skills/review-pr/SKILL.md") },
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
    return { skill: { name: c.name, path: c.path, body, frontmatter }, attempted };
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

module.exports = { resolveReviewSkill, splitFrontmatter };
