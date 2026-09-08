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

const SKILL_NAMES = ["aa-review-pr", "review-pr"];

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
 * Only ONE skill wins, and that used to be the whole story — which is the hole
 * this now covers. First-hit-wins meant the review a PR got depended on whose
 * machine ran it: with no project skill, a developer's personal playbook became
 * the entire standard, and with one, their playbook was dropped even where it
 * did no harm. So the winner still governs, and when the winner is the
 * PROJECT's skill any user-level skill found underneath it is returned attached
 * as `skill.subordinate` — included in the prompt, explicitly ranked below the
 * project's rules, and never able to lower a bar the project set. The prompt
 * builder owns that wording (see claude-runner.js).
 *
 * Returns { skill, attempted } where skill is { name, path, body,
 * frontmatter, source, ref, subordinate } and `source` is one of "project" |
 * "user" | "bundled". `subordinate` is null unless a project skill won and a
 * user-level one also exists. `attempted` is every path checked, useful for
 * the UI.
 */
async function resolveReviewSkill(
  worktreePath,
  { repoPath = null, baseRef = null, onLog = null, provider = null } = {},
) {
  const home = os.homedir();
  const fromBase = !!(repoPath && baseRef);
  const projectDirs = provider?.projectSkillDirs || [".claude/skills"];
  const userDirs = provider?.userSkillDirs || [".claude/skills"];
  const projectCandidates = projectDirs.flatMap((dir) =>
    SKILL_NAMES.map((name) => ({ name, rel: `${dir}/${name}/SKILL.md` })),
  );
  const candidates = [
    ...projectCandidates.map((c) => ({
      name: c.name,
      rel: c.rel,
      path: path.join(worktreePath, c.rel),
      source: "project",
    })),
    ...userDirs.flatMap((dir) =>
      SKILL_NAMES.map((name) => ({
        name,
        path: path.join(home, dir, name, "SKILL.md"),
        source: "user",
      })),
    ),
    { name: "prsnooze-default-review", path: BUNDLED_SKILL_PATH, source: "bundled" },
  ];

  const attempted = [];
  // Read a candidate the same way the winner search does, so the subordinate
  // lookup can't drift from it.
  const load = async (c) => {
    const raw = c.source === "project" && fromBase
      ? await gitShow(repoPath, baseRef, c.rel)
      : await readFile(c.path);
    if (raw === null) return null;
    const { body, frontmatter } = splitFrontmatter(raw);
    return {
      name: c.name,
      path: c.path,
      body,
      frontmatter,
      source: c.source,
      ref: c.source === "project" && fromBase ? baseRef : null,
    };
  };

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
    const skill = {
      name: c.name,
      path: c.path,
      body,
      frontmatter,
      source: c.source,
      ref: c.source === "project" && fromBase ? baseRef : null,
      subordinate: null,
    };

    // A project playbook won. Whoever's machine this is may still have their
    // own review skill, and there is no reason to throw it away — it just
    // doesn't get to outrank the repo. Attached, not merged: the prompt keeps
    // the two sections separate so precedence stays readable in the log.
    if (c.source === "project") {
      for (const other of candidates) {
        if (other.source !== "user") continue;
        attempted.push(other.path);
        const developer = await load(other);
        if (!developer) continue;
        skill.subordinate = developer;
        onLog?.(
          `Also found ${tildify(developer.path)} on this host. It is included BELOW the project's skill: the project's rules win on anything they disagree about.`,
        );
        break;
      }
    }

    return { skill, attempted };
  }
  return { skill: null, attempted };
}

// The log line is read by a human watching a review start, and an absolute
// /Users/... path is noise there.
function tildify(p) {
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
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
