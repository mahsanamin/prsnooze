"use strict";

// Whether the Approve button belongs on this review at all.
//
// Kept in its own file, and free of any DOM or fetch, for the same reason
// assessResumability() lives apart from the `gh` call that feeds it: it is the
// densest piece of reasoning in the approve flow — four ways to say no plus one
// deliberate fail-open — so it is worth being able to test every branch without
// a browser. Loaded before app.js, which calls it from renderHead().
//
// The gate waits for an answer from GitHub before it draws anything: showing the
// button and then yanking it away a moment later — which is what happened on a
// merged PR while the state was still in flight — reads as a glitch, and worse,
// it's clickable during that moment. So "not asked yet" renders nothing, and the
// button appears only once the PR is known to be open.
//
// An unreachable GitHub (checked, but ok:false) is the one case where the button
// still shows: we can't distinguish merged from open, and refusing every
// approval because a `gh` call failed is worse than letting GitHub refuse it.
function canApprovePr(rev) {
  if (rev.state !== "done") return false;
  if (rev.outcome === "approved") return false;
  if (rev.skipped && rev.skipReason === "pr_not_open") return false;
  if (!rev.prStateChecked) return false;          // still asking — draw nothing
  if (rev.prApproved) return false;               // someone already approved it
  if (rev.prStateOk === false) return true;       // couldn't ask; let GitHub decide
  return rev.prState === "OPEN";
}

// Browser: the function is a global, picked up by app.js. Node: the test needs
// a handle on it. Neither environment needs to know about the other.
if (typeof module !== "undefined" && module.exports) module.exports = { canApprovePr };
