"use strict";

// Provider adapters import prompts through this neutral module. The original
// exports remain in claude-runner.js so existing callers and tests keep working.
const { buildPrompt, approvalBlock, workingTreeBlock } = require("./claude-runner");

module.exports = { buildPrompt, approvalBlock, workingTreeBlock };
