"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isFableModel, relevantUsageWindows, tightestUsageWindow } = require("../lib/admission-policy");

test("Fable is detected as a model name, not inferred from unrelated text", () => {
  assert.equal(isFableModel("Claude Fable"), true);
  assert.equal(isFableModel("fable (1M context)"), true);
  assert.equal(isFableModel("Sonnet 5"), false);
});

test("normal reviews ignore the separate Fable quota window", () => {
  const windows = [
    { id: "session", label: "Session", leftPct: 30 },
    { id: "week-all-models", label: "Week (all models)", leftPct: 18 },
    { id: "week-fable", label: "Week (Fable)", leftPct: 2 },
  ];
  assert.deepEqual(relevantUsageWindows(windows).map((window) => window.id), ["session", "week-all-models"]);
  assert.equal(tightestUsageWindow(windows).id, "week-all-models");
  assert.deepEqual(relevantUsageWindows(windows, { fable: true }).map((window) => window.id), [
    "session",
    "week-all-models",
    "week-fable",
  ]);
  assert.equal(tightestUsageWindow(windows, { fable: true }).id, "week-fable");
});
