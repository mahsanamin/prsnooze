"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("the Docker context excludes credentials, git history, and host dependencies", () => {
  const rules = fs
    .readFileSync(path.join(__dirname, "..", ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const required of [".git", ".env", ".env.*", "node_modules", "docker/providers/node_modules"]) {
    assert.ok(rules.includes(required), `.dockerignore must contain ${required}`);
  }
  assert.ok(rules.includes("!.env.example"), "the documented environment template must stay in the context");
});
