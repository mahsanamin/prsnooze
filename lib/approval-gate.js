"use strict";

// Whether a password-authorised approval may actually reach GitHub.
//
// The approve password answers one question: is this person allowed to approve
// on this host. Until now that was the ONLY question asked, so it silently
// answered a second one it has no business answering — is this PR fit to be
// approved. A colleague who knows the password could stamp a PR that prsnooze
// itself had just flagged 🔴 Critical, and nothing in the request path noticed.
//
// So the password stays what it is (authorisation) and this module owns the
// other half (fitness). The rule: a forced approval never lands while a
// critical comment from ANYONE is still open. A standing "changes requested",
// an unresolved critical/major inline thread, and critical/major findings on
// the current head that nobody has answered all refuse. Questions, nits and
// minors do not — resolving those is not what an approval is waiting on.
//
// Pure, and kept apart from the `gh` calls that feed it, for the same reason
// canApprovePr() and assessResumability() are: every branch here refuses
// somebody's approval, so every branch is worth a test.
//
// The fuzzy part is reading severity out of free-form comment text, and it is
// deliberately biased: an ambiguous match refuses an approval, it never grants
// one. A false refusal costs a conversation; a false approval costs the thing
// the review existed to catch.

// How a blocker announces itself. 🔴/🟠 are prsnooze's own markers (see
// skills/default-review/SKILL.md), 🛑 is what review bots use, and the words
// are what humans type. Criticals are listed before majors because the first
// match inside a unit wins, so the order is what makes a unit saying both come
// out critical.
const SEVERITY_MARKERS = [
  { re: /🔴|🛑|⛔|🚫/u, level: "critical" },
  { re: /\bcritical\b/i, level: "critical" },
  { re: /\bblocker\b|\bblocking\b/i, level: "critical" },
  { re: /\bmust[-\s]?(?:fix|change|not)\b|\bmust be fixed\b/i, level: "critical" },
  { re: /\bP0\b/, level: "critical" },
  // A label, not a mention: "Requirement:" at the head of a line is how review
  // bots (GitHub Copilot's reviewer, among others) mark something that has to
  // change. "…meets the requirement: x" is a different sentence and must not
  // match, which is what pins this to the start.
  { re: /^\W*(?:requirement|required|changes? required)\s*:/i, level: "critical" },
  { re: /🟠/u, level: "major" },
  { re: /\bmajor\b/i, level: "major" },
  { re: /\bP1\b/, level: "major" },
  { re: /\bvulnerabilit(?:y|ies)\b|\bsecurity (?:hole|flaw|risk|bug|issue)\b/i, level: "major" },
  { re: /\bdata loss\b|\brace condition\b|\bsql injection\b/i, level: "major" },
];

// Text that names a severity only to say there isn't one, or that there was one
// and it's done. Checked before the markers, so "No critical issues" and
// "critical finding addressed in a1b2c3d" don't read as open criticals — which
// matters because prsnooze's own approving review bodies talk like that.
const NEGATIONS = [
  /\b(?:no|zero|none|nothing|not any|non-)\b[^.\n]{0,28}\b(?:critical|major|blocker|blocking|issues?|findings?|concerns?)\b/i,
  /\b(?:critical|major|blocker|finding|issue)s?\b[^.\n]{0,28}\b(?:resolved|addressed|answered|fixed|closed|done|n\/a|not applicable)\b/i,
  /\b(?:resolved|addressed|answered|fixed)\b[^.\n]{0,28}\b(?:critical|major|blocker)/i,
  /\b(?:not|isn'?t)\b[^.\n]{0,20}\b(?:critical|major|blocking|a blocker)\b/i,
];

/**
 * Read the worst severity out of a block of comment or review-body text.
 *
 * Two things it deliberately does NOT do:
 *
 *   - Read fenced code. Reviewers paste diffs and snippets, and a snippet that
 *     contains the word "critical" says nothing about this PR.
 *   - Judge a whole line at once. A line is broken into units first — table
 *     cells, then sentences — and negation is checked per unit. That
 *     distinction is load-bearing: a real review comment is often one long
 *     paragraph on a single line, and a negation anywhere in it ("…though
 *     there are no other issues") would otherwise wave off a blocker stated
 *     beside it. Per unit, "No critical issues" cancels only itself.
 *
 * @param {string} text
 * @returns {{level: "critical"|"major"|"none", evidence: string|null}}
 */
function classifySeverity(text) {
  if (typeof text !== "string" || !text.trim()) return { level: "none", evidence: null };
  let inFence = false;
  let best = { level: "none", evidence: null };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const unit of units(raw)) {
      if (NEGATIONS.some((re) => re.test(unit))) continue;
      for (const marker of SEVERITY_MARKERS) {
        const found = unit.match(marker.re);
        if (!found) continue;
        const evidence = evidenceAround(unit, found);
        if (marker.level === "critical") return { level: "critical", evidence };
        if (best.level === "none") best = { level: "major", evidence };
        break;
      }
    }
  }
  return best;
}

// The smallest pieces worth judging on their own, out of one line of markdown.
//
// Split on table cells as well as sentences, because that is the shape a review
// bot's body actually arrives in: one row per finding, severity in its own
// cell. Judging the row as a whole would let one cell's "no other issues"
// cancel another cell's blocker, and would quote the entire row back at
// whoever tried to approve.
function units(raw) {
  return scrub(raw)
    .split("|")
    .flatMap((cell) => cell.split(/(?<=[.!?])\s+/))
    .map((u) => u.trim())
    .filter(Boolean);
}

// Markup that carries no claim about the PR but is full of words and URLs that
// look like they do. Bot review bodies are mostly this: hidden marker comments,
// <picture>/<img> blocks, and badge links whose filenames contain severity
// words. Stripped before anything is read, so neither the match nor the quoted
// evidence can come out of it.
function scrub(line) {
  return line
    .replace(/<!--[\s\S]*?-->/g, " ")
    // A tag name must be followed by whitespace, "/" or ">" — otherwise
    // "if (a<b) return x>y" in an un-backticked comment would have its middle
    // stripped out, and a blocker phrase could vanish with it.
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]{0,300})?\/?>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ");
}

// Quote the neighbourhood of the match, not the whole unit. A finding stated
// mid-paragraph is the common case, and the point of the quote is to let
// someone recognise which comment is being talked about.
function evidenceAround(unit, match, width = 150) {
  if (unit.length <= width) return squeeze(unit);
  const at = Math.max(0, (match.index || 0) - 24);
  const cut = unit.slice(at, at + width);
  return `${at > 0 ? "…" : ""}${squeeze(cut, width)}`;
}

// Comment bodies are markdown and can be long; a blocker line is quoted back to
// whoever tried to approve, so keep it to one readable line.
function squeeze(line, max = 160) {
  const flat = line.replace(/^[>\-*+\s]+/, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const at = (login) => (login ? `@${login}` : "someone");

function threadLocation(thread) {
  const p = thread.path || "";
  const line = thread.line || thread.originalLine || null;
  if (!p) return "an inline comment";
  return line ? `${p}:${line}` : p;
}

/**
 * Decide whether a forced (password-authorised) approval may go through.
 *
 * @param {object}  a
 * @param {object}  a.signals   fetchApprovalSignals() result — never throws, may be ok:false
 * @param {object}  a.job       the prsnooze job being approved (for prMeta fallbacks)
 * @param {string}  a.hostLogin the gh identity the approval would post as
 * @param {string}  a.hostName  who owns this host, for the "go ask them" line
 * @param {number}  a.maxListed how many blockers to name in the message
 * @returns {{allowed: boolean, code: string, reason: string, message: string, blockers: object[]}}
 */
function assessForcedApproval({ signals, job = {}, hostLogin = null, hostName = null, maxListed = 5 } = {}) {
  const owner = ownerLine(hostName, hostLogin);
  const refuse = (code, reason, message, blockers = []) => ({ allowed: false, code, reason, message, blockers });

  // Unreachable GitHub refuses here, unlike the browser's Approve button which
  // deliberately fails open. The button only decides whether to offer a click;
  // this decides whether an approval lands. "I could not check for open
  // criticals" is not the same as "there are none", and only one of those two
  // is a safe thing to guess.
  if (!signals || signals.ok === false) {
    const detail = (signals && signals.error) || "gh did not answer";
    return refuse(
      "UNVERIFIED",
      "could not read the PR's open comments",
      [
        "Approval held — prsnooze could not check whether this PR has open critical comments.",
        `GitHub didn't answer: ${detail}`,
        "",
        "Nothing was posted. This is held rather than guessed: an approval that",
        "skips the check is exactly the one the check exists for. Try again in a",
        `moment, or ask ${owner} to look at the PR directly.`,
      ].join("\n"),
    );
  }

  const state = String(signals.state || "").toUpperCase();
  if (state && state !== "OPEN") {
    return refuse(
      "NOT_OPEN",
      `PR is ${state.toLowerCase()}`,
      `This PR is ${state.toLowerCase()} — there is nothing left to approve.`,
    );
  }

  const author = signals.authorLogin || job.prMeta?.authorLogin || null;
  if (hostLogin && author && hostLogin === author) {
    return refuse(
      "OWN_PR",
      "approving your own PR",
      `prsnooze approves as ${at(hostLogin)}, who wrote this PR. GitHub won't accept a self-approval, and neither will this.`,
    );
  }

  // 1. A formal "changes requested" that its author hasn't dismissed. The
  //    strongest signal there is, and the only one GitHub itself enforces.
  const changesRequested = (signals.latestReviews || [])
    .filter((r) => String(r.state || "").toUpperCase() === "CHANGES_REQUESTED")
    .map((r) => ({ kind: "changes_requested", author: r.author || null, level: "critical", detail: `${at(r.author)} requested changes` }));
  if (!changesRequested.length && String(signals.reviewDecision || "").toUpperCase() === "CHANGES_REQUESTED") {
    changesRequested.push({ kind: "changes_requested", author: null, level: "critical", detail: "a reviewer requested changes" });
  }
  if (changesRequested.length) {
    return refuse(
      "CHANGES_REQUESTED",
      "a reviewer has requested changes",
      blockedMessage({
        headline:
          changesRequested.length === 1
            ? `Approval refused — ${changesRequested[0].detail} on this PR, and hasn't withdrawn it.`
            : `Approval refused — ${changesRequested.length} reviewers have requested changes on this PR.`,
        blockers: changesRequested,
        owner,
        fixLine:
          "A requested-changes review can only be cleared by the reviewer who left it. Address it and ask them to re-review.",
        maxListed,
      }),
      changesRequested,
    );
  }

  // 2. Unresolved review threads that read as critical or major. Unresolved is
  //    taken at face value even when GitHub marks the thread outdated: the code
  //    moving under a comment is not the same as the comment being answered,
  //    and clicking Resolve is the cheap half of "solve the comments first".
  const threadBlockers = [];
  for (const thread of signals.threads || []) {
    if (thread.isResolved) continue;
    const worst = worstInThread(thread);
    if (worst.level === "none") continue;
    threadBlockers.push({
      kind: "unresolved_thread",
      level: worst.level,
      author: worst.author || null,
      path: thread.path || null,
      line: thread.line || thread.originalLine || null,
      outdated: !!thread.isOutdated,
      detail: `${threadLocation(thread)} — ${at(worst.author)}: ${worst.evidence}`,
    });
  }

  // 3. Critical/major findings in a review body on the CURRENT head. This is
  //    where prsnooze's own reviews land: it posts findings as one review, not
  //    as inline threads, so rule 2 never sees them.
  //
  //    Pinned to the head SHA on purpose. A review of code the author has since
  //    replaced tells us nothing about the code being approved, and holding an
  //    approval on a superseded review would deadlock every PR prsnooze ever
  //    commented on. The trade is visible: pushing a commit clears this rule,
  //    so it catches "nobody did anything about the findings", not "somebody
  //    pushed something and called it fixed".
  const head = signals.headRefOid || "";
  const reviewBlockers = [];
  for (const review of signals.reviews || []) {
    const reviewState = String(review.state || "").toUpperCase();
    if (reviewState === "APPROVED" || reviewState === "DISMISSED" || reviewState === "PENDING") continue;
    if (!head || !review.commitOid || review.commitOid !== head) continue;
    const worst = classifySeverity(review.body);
    if (worst.level === "none") continue;
    reviewBlockers.push({
      kind: "open_findings",
      level: worst.level,
      author: review.author || null,
      detail: `${at(review.author)}'s review of the current head: ${worst.evidence}`,
    });
  }

  const openBlockers = [...threadBlockers, ...reviewBlockers];
  if (openBlockers.length) {
    const criticals = openBlockers.filter((b) => b.level === "critical").length;
    const noun = openBlockers.length === 1 ? "comment is" : "comments are";
    return refuse(
      "OPEN_CRITICAL_COMMENTS",
      `${openBlockers.length} open critical/major comment(s)`,
      blockedMessage({
        headline: `Approval refused — ${openBlockers.length} ${criticals ? "critical" : "major"} ${noun} still open on this PR.`,
        blockers: openBlockers,
        owner,
        fixLine:
          "Solve these first: fix them, or have the reviewer who raised them mark the thread resolved. Then approve.",
        maxListed,
      }),
      openBlockers,
    );
  }

  return { allowed: true, code: "CLEAR", reason: "no open critical or major comments", message: "", blockers: [] };
}

function worstInThread(thread) {
  let best = { level: "none", evidence: null, author: null };
  for (const c of thread.comments || []) {
    const found = classifySeverity(c.body);
    if (found.level === "none") continue;
    if (found.level === "critical") return { ...found, author: c.author || null };
    if (best.level === "none") best = { ...found, author: c.author || null };
  }
  return best;
}

function ownerLine(hostName, hostLogin) {
  if (hostName && hostLogin) return `${hostName} (${at(hostLogin)}), who owns this prsnooze host`;
  if (hostLogin) return `${at(hostLogin)}, who owns this prsnooze host`;
  if (hostName) return `${hostName}, who owns this prsnooze host`;
  return "whoever owns this prsnooze host";
}

// One shape for every refusal that has a list behind it: what's wrong, what to
// do about it, and who to go to instead. The last line is the point of the
// whole module — the answer to "the password worked, why didn't it approve?"
// has to be actionable, or the next move is to go looking for a way around it.
function blockedMessage({ headline, blockers, owner, fixLine, maxListed }) {
  const listed = blockers.slice(0, maxListed);
  const rest = blockers.length - listed.length;
  return [
    headline,
    "",
    ...listed.map((b) => `  • ${b.detail}${b.outdated ? " (thread outdated but still unresolved)" : ""}`),
    ...(rest > 0 ? [`  • …and ${rest} more`] : []),
    "",
    "The password authorises you to approve on this host. It does not override an",
    "open finding, and there is no override that does.",
    "",
    fixLine,
    `If it's already handled and the comment is wrong, ask ${owner} to review and approve it for you.`,
  ].join("\n");
}

module.exports = { assessForcedApproval, classifySeverity };
