"use strict";

function isFableModel(name) {
  return /\bfable\b/i.test(String(name || ""));
}

function relevantUsageWindows(windows, { fable = false } = {}) {
  return (Array.isArray(windows) ? windows : []).filter((window) => {
    if (fable) return true;
    const text = `${window?.id || ""} ${window?.label || ""}`;
    return !/fable/i.test(text);
  });
}

function tightestUsageWindow(windows, options) {
  return relevantUsageWindows(windows, options)
    .filter((window) => Number.isFinite(Number(window.leftPct)))
    .sort((a, b) => Number(a.leftPct) - Number(b.leftPct))[0] || null;
}

module.exports = { isFableModel, relevantUsageWindows, tightestUsageWindow };
