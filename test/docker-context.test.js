"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function ignoreRules() {
  return fs
    .readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// --- a small .dockerignore matcher -----------------------------------------
// Enough of the syntax to judge our own rules: literal paths, `*` and `?`
// globs that do not cross a slash, and `!` negation. A pattern also excludes
// everything beneath it, which is how Docker treats a directory rule, so
// `node_modules` covers `node_modules/express/index.js`.

function segmentMatches(pattern, segment) {
  const rx = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
  return rx.test(segment);
}

function patternMatches(pattern, filePath) {
  const pat = pattern.split("/").filter(Boolean);
  const parts = filePath.split("/").filter(Boolean);
  if (pat.length > parts.length) return false;
  return pat.every((segment, i) => segmentMatches(segment, parts[i]));
}

/** Docker applies every rule in order and the last one that matches wins. */
function isExcluded(rules, filePath) {
  let excluded = false;
  for (const rule of rules) {
    const negated = rule.startsWith("!");
    const pattern = negated ? rule.slice(1) : rule;
    if (patternMatches(pattern, filePath)) excluded = !negated;
  }
  return excluded;
}

// Everything git refuses to commit but which exists on this machine. This is
// the repository's own statement of what is host-local or secret.
function ignoredButPresent() {
  return execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("the matcher understands the .dockerignore syntax these rules use", () => {
  const rules = [".git", ".env", ".env.*", "!.env.example", "node_modules", "*.log"];
  assert.equal(isExcluded(rules, ".env"), true);
  assert.equal(isExcluded(rules, ".env.local"), true);
  // A later negation has to win over the earlier glob that caught it.
  assert.equal(isExcluded(rules, ".env.example"), false);
  // A directory rule covers everything beneath it.
  assert.equal(isExcluded(rules, "node_modules/express/index.js"), true);
  assert.equal(isExcluded(rules, ".git/config"), true);
  // A glob must not cross a slash, matching Docker's behaviour.
  assert.equal(isExcluded(rules, "debug.log"), true);
  assert.equal(isExcluded(rules, "logs/debug.log"), false);
  assert.equal(isExcluded(rules, "server.js"), false);
});

test("the Docker context excludes credentials, git history, and host dependencies", () => {
  const rules = ignoreRules();
  for (const required of [".git", ".env", ".env.*", "node_modules", "docker/providers/node_modules"]) {
    assert.ok(rules.includes(required), `.dockerignore must contain ${required}`);
  }
  assert.ok(rules.includes("!.env.example"), "the documented environment template must stay in the context");
});

// A gitignored file that the image ships ON PURPOSE. Each entry is a decision
// someone made, not a default, which is the whole point of the test below.
const DELIBERATELY_SHIPPED = [
  // The host drops in a personal hero image without committing it, and the
  // container serves the page, so it has to travel with the image. Excluding it
  // would silently break a custom hero under Docker.
  "public/heroes/local-hero.*",
];

// The assertion above guards against a rule being deleted, but it cannot notice
// a sensitive file that no rule ever covered: it reads .dockerignore as text and
// never looks at what would actually ship. This inverts it, so the property is
// "anything the repo refuses to commit, the image refuses to ship" and every
// exception is written down.
//
// It earned its place immediately. `.env` and `.git` were excluded while
// `.claude/settings.local.json`, which git refuses to commit, rode along in the
// image with the whole suite green.
test("a gitignored file either stays out of the image or is an acknowledged exception", () => {
  const rules = ignoreRules();
  const unaccounted = ignoredButPresent().filter(
    (file) =>
      !isExcluded(rules, file) &&
      !DELIBERATELY_SHIPPED.some((allowed) => patternMatches(allowed, file)),
  );

  assert.deepEqual(
    unaccounted,
    [],
    `git refuses to commit these, so they are host-local or secret, yet the Docker ` +
      `build context would include them. Either add a .dockerignore rule, or, if the ` +
      `image genuinely needs the file, add it to DELIBERATELY_SHIPPED with the reason:\n  ` +
      unaccounted.join("\n  "),
  );
});

test("an acknowledged exception is not also excluded by a rule", () => {
  // Every entry is an OPTIONAL host-local file, so absence is normal: a fresh
  // clone and CI have none of them. Asserting each one exists would fail
  // everywhere except the machine that happens to have it, so only check the
  // contradiction that would actually matter, an allowlisted file that a rule
  // excludes anyway.
  const rules = ignoreRules();
  for (const file of ignoredButPresent()) {
    if (!DELIBERATELY_SHIPPED.some((allowed) => patternMatches(allowed, file))) continue;
    assert.equal(isExcluded(rules, file), false, `${file} is allowlisted but .dockerignore excludes it`);
  }
});

test("the environment template is the one deliberate exception", () => {
  // Worth pinning: .env.example must survive `.env.*`, and it is not gitignored,
  // so the inverted check above would never have noticed if it stopped shipping.
  assert.equal(isExcluded(ignoreRules(), ".env.example"), false);
  assert.ok(fs.existsSync(path.join(ROOT, ".env.example")));
});
