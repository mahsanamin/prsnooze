"use strict";

// fetchPrState documents itself as "never throws", because its caller — the
// unauthenticated /api/jobs/:id/pr-state — doesn't wrap it. It used to parse the
// PR URL *outside* its own try, so a job whose prUrl no longer parses (corrupt
// or legacy job file) turned a read-only probe into an unhandled rejection: a
// 500 whose body is an Express stack trace with the host's absolute paths in it,
// since nothing here sets NODE_ENV=production.
//
// These cases never reach `gh`, so there's no network and no GitHub account
// involved — parsing fails first, which is the entire point.

const test = require("node:test");
const assert = require("node:assert");
const { fetchPrState } = require("../lib/github");

for (const bad of ["", "not a url", "https://github.com/o/r", "https://example.com/o/r/pull/1", null, undefined]) {
  test(`an unparseable prUrl (${JSON.stringify(bad)}) is an answer, not a throw`, async () => {
    const state = await fetchPrState(bad);
    assert.equal(state.ok, false);
    // Callers read these without checking ok first (the merged/closed chip, the
    // Approve gate), so the shape has to be complete even on the failure path.
    assert.equal(state.merged, false);
    assert.equal(state.open, false);
    assert.equal(state.approved, false);
    assert.match(state.error, /Not a GitHub PR URL/);
  });
}
