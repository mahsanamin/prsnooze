"use strict";

const $ = (id) => document.getElementById(id);

const form = $("submit-form");
const input = $("pr-url");
const submitBtn = $("submit-btn");
const submitMsg = $("submit-msg");
const hostNameEl = $("host-name");
const soundToggle = $("sound-toggle");
const notifHint = $("notif-hint");
const queueStatusEl = $("queue-status");
const welcomeBanner = $("welcome-banner");
const welcomeText = $("welcome-text");
const welcomeDismiss = $("welcome-dismiss");
const activeList = $("active-list");
const activeEmpty = $("active-empty");
const recentList = $("recent-list");
const recentEmpty = $("recent-empty");
const panels = $("panels");
const emptyState = $("empty-state");
const faviconEl = $("favicon");
const toastEl = $("toast");
const lockChip = $("lock-chip");
const unlockBackdrop = $("unlock-backdrop");
const unlockForm = $("unlock-modal");
const unlockPass = $("unlock-pass");
const unlockEye = $("unlock-eye");
const unlockErr = $("unlock-err");
const unlockCancel = $("unlock-cancel");

const LS_SELECTED = "prsnooze:selected";
const LS_SOUND = "prsnooze:sound";
const LS_MODE = "prsnooze:mode";
const LS_LASTSEEN = "prsnooze:lastSeen";

const PHASES = [
  { key: "resolving", label: "resolve" },
  { key: "syncing_repo", label: "sync" },
  { key: "creating_worktree", label: "worktree" },
  { key: "reviewing", label: "review" },
  { key: "cleanup", label: "finish" },
];
const phaseIndex = (p) => PHASES.findIndex((x) => x.key === p);

const reviews = new Map();
let selectedId = null;
let mode = localStorage.getItem(LS_MODE) === "detailed" ? "detailed" : "zen";
let hostName = "";
let isHost = false;
let hostLogin = null;
let welcomeShown = false;
let passwordConfigured = false;
let unlocked = false;
let relockTimer = null;
let pendingApprove = null; // {id, btn} — an approve click waiting on unlock

const isActive = (s) => s === "queued" || s === "running";
const isTerminal = (s) => s === "done" || s === "failed" || s === "interrupted";

// ---------------------------------------------------------------- submit ----

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  // If the input points at a PR that already has a finished review with a
  // saved session, the button re-checks that review (resumes the session)
  // instead of starting a fresh one. See updateSubmitButton().
  const verifyId = submitBtn.dataset.verifyId;
  if (verifyId && reviews.has(verifyId)) { await verifyReview(verifyId); return; }
  await submitUrls(input.value);
});
input.addEventListener("input", updateSubmitButton);

async function submitUrls(raw) {
  const urls = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return;
  requestNotifPermission();
  submitBtn.disabled = true;
  submitMsg.textContent = urls.length > 1 ? `submitting ${urls.length}…` : "submitting…";
  submitMsg.classList.remove("error");

  let firstId = null;
  const errors = [];
  for (const prUrl of urls) {
    try {
      const r = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl }),
      });
      const data = await r.json();
      if (!r.ok) { errors.push(`${prUrl}: ${data.error || `HTTP ${r.status}`}`); continue; }
      const rev = upsertReview({ id: data.jobId, prUrl: data.prUrl, state: "queued" });
      ensurePanel(rev);
      openStream(rev);
      if (!firstId) firstId = data.jobId;
    } catch (err) {
      errors.push(`${prUrl}: ${err.message}`);
    }
  }
  input.value = "";
  if (firstId) selectReview(firstId);
  submitMsg.textContent = errors.length ? errors.join(" · ") : urls.length > 1 ? `Queued ${urls.length}.` : "Queued.";
  submitMsg.classList.toggle("error", errors.length > 0);
  setTimeout(() => { if (!errors.length) submitMsg.textContent = ""; }, 4000);
  updateSubmitButton();
  refreshList();
}

function updateSubmitButton() {
  // The one topbar button is context-aware: when the input points at a PR that
  // already has a finished review with a saved session, it becomes "Verify
  // fixes" and resumes that session; otherwise it starts a fresh review.
  const rev = findVerifiable(input.value);
  if (rev) {
    submitBtn.textContent = "↻ Verify fixes";
    submitBtn.title = "Resume the original review to check if the comments were addressed";
    submitBtn.dataset.verifyId = rev.id;
  } else {
    submitBtn.textContent = "Start review";
    submitBtn.title = "";
    delete submitBtn.dataset.verifyId;
  }
  submitBtn.disabled = false;
}

// -------------------------------------------------------------- review model
function prNumberFromUrl(url) { const m = /\/pull\/(\d+)/.exec(url || ""); return m ? m[1] : null; }
function shortRepo(n) { if (!n) return ""; const p = n.split("/"); return p[p.length - 1]; }
function normUrl(u) { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, ""); } catch { return String(u || "").trim().replace(/\/+$/, ""); } }
// A finished review is "verifiable" if it has a session to resume. Only a
// single, exact URL match qualifies (multi-URL submits always start fresh).
function findVerifiable(raw) {
  const urls = String(raw || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (urls.length !== 1) return null;
  const target = normUrl(urls[0]);
  let best = null;
  for (const rev of reviews.values()) {
    if (rev.state === "done" && rev.sessionId && normUrl(rev.prUrl) === target) {
      // If the same PR was reviewed more than once, resume the most recent.
      if (!best || (rev.finishedAt || 0) > (best.finishedAt || 0)) best = rev;
    }
  }
  return best;
}

function upsertReview(data) {
  let rev = reviews.get(data.id);
  if (!rev) {
    rev = {
      id: data.id, prUrl: data.prUrl, prMeta: null, state: data.state || "queued",
      phase: null, outcome: data.outcome || null, skipped: !!data.skipped, skipReason: data.skipReason || null,
      finished: false, freshFinish: false, notified: false, finishedAt: data.finishedAt || null,
      summaryText: "", errorText: "", es: null, panelLoaded: false, els: null, _systemShown: false,
    };
    reviews.set(rev.id, rev);
  }
  if (data.prUrl && !rev.prUrl) rev.prUrl = data.prUrl;
  if (data.state) rev.state = data.state;
  if (data.outcome) rev.outcome = data.outcome;
  if (data.finishedAt) rev.finishedAt = data.finishedAt;
  if (data.skipReason) rev.skipReason = data.skipReason;
  if (data.prMeta && !rev.prMeta) rev.prMeta = data.prMeta;
  else if (data.nameWithOwner && !rev.prMeta) rev.prMeta = { nameWithOwner: data.nameWithOwner, number: data.number, title: data.title };
  return rev;
}

// ----------------------------------------------------------------- lists ----
function renderLists() {
  const all = Array.from(reviews.values());
  const active = all.filter((r) => isActive(r.state));
  const recent = all.filter((r) => !isActive(r.state)).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));

  activeList.innerHTML = "";
  for (const r of active) activeList.appendChild(activeRow(r));
  activeEmpty.hidden = active.length > 0;

  recentList.innerHTML = "";
  for (const r of recent) recentList.appendChild(recentRow(r));
  recentEmpty.hidden = recent.length > 0;
}

function activeRow(r) {
  const row = document.createElement("button");
  row.className = "arev" + (r.id === selectedId ? " selected" : "");
  const num = r.prMeta?.number || prNumberFromUrl(r.prUrl);
  const idx = phaseIndex(r.phase);
  const pct = idx < 0 ? 6 : Math.round(((idx + 0.5) / PHASES.length) * 100);
  row.innerHTML =
    `<div class="arev-top"><span class="arev-dot"></span><span class="arev-num">#${num || r.id.slice(0, 5)}</span>` +
    `<span class="arev-st">${escapeHtml(r.phase ? phaseShort(r.phase) : r.state)}</span></div>` +
    `<div class="arev-bar"><i style="width:${pct}%"></i></div>`;
  row.addEventListener("click", () => selectReview(r.id));
  return row;
}

function recentRow(r) {
  const m = statusMeta(r);
  const row = document.createElement("div");
  row.className = `rrow ${m.cls}` + (r.id === selectedId ? " selected" : "");
  const num = r.prMeta?.number || prNumberFromUrl(r.prUrl);
  const repo = r.prMeta ? shortRepo(r.prMeta.nameWithOwner) : "";
  const title = r.prMeta?.title ? `${repo} — ${r.prMeta.title}` : (repo || r.prUrl);
  row.innerHTML =
    `<span class="rg">${m.icon}</span><span class="rnum">#${num || r.id.slice(0, 5)}</span>` +
    `<span class="rtitle">${escapeHtml(title)}</span>` +
    `<span class="rout">${escapeHtml(rowStateText(r))}</span>` +
    `<span class="rtime">${r.finishedAt ? relTime(r.finishedAt) : ""}</span>`;
  row.addEventListener("click", () => selectReview(r.id));

  // Remove-from-list. Its own button, not the status glyph on the left — that
  // glyph is "✗ failed" and reads like a close box, which is a trap.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "rdel";
  del.textContent = "🗑";
  del.title = "Remove from this list";
  del.setAttribute("aria-label", `Remove review #${num || r.id.slice(0, 5)} from the list`);
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteReview(r.id, del); });
  row.appendChild(del);
  return row;
}

// Remove a finished review: server first, local state only once it agrees, so
// a row never disappears from a list the server still has.
async function deleteReview(id, btn) {
  if (!reviews.has(id)) return;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      showToast(escapeHtml(d.error || `Couldn't remove this review (HTTP ${r.status}).`));
      if (btn) btn.disabled = false;
      return;
    }
  } catch (err) {
    showToast(escapeHtml(`Couldn't remove this review: ${err.message}`));
    if (btn) btn.disabled = false;
    return;
  }
  dropReview(id);
  renderLists();
  updateSubmitButton();
}

// Tear a review out of the frontend's state: close its stream, drop its panel,
// and let go of the selection if it was the one being viewed.
function dropReview(id) {
  const rev = reviews.get(id);
  if (!rev) return;
  try { rev.es?.close(); } catch {}
  rev.es = null;
  rev.els?.panel?.remove();
  reviews.delete(id);
  if (selectedId === id) {
    selectedId = null;
    localStorage.removeItem(LS_SELECTED);
    emptyState.hidden = false;
  }
}

function phaseShort(p) { const f = PHASES.find((x) => x.key === p); return f ? f.label : p; }
function rowStateText(rev) {
  if (isActive(rev.state)) return rev.phase ? phaseShort(rev.phase) : rev.state;
  if (rev.state === "failed") return "failed";
  if (rev.state === "interrupted") return "interrupted";
  switch (rev.outcome) {
    case "approved": return "approved";
    case "changes_requested": return "changes";
    case "commented": return "commented";
    case "no_new_findings": return "no changes";
    case "skipped": return "skipped";
    default: return "done";
  }
}

// --------------------------------------------------------------- selection --
function selectReview(id) {
  const rev = reviews.get(id);
  if (!rev) return;
  selectedId = id;
  localStorage.setItem(LS_SELECTED, id);
  emptyState.hidden = true;
  input.value = rev.prUrl || "";
  ensurePanel(rev);
  for (const [rid, r] of reviews) if (r.els?.panel) r.els.panel.classList.toggle("active", rid === id);
  if (!rev.panelLoaded && !rev.es) loadFinishedLog(rev);
  applyMode(rev);
  renderLists();
  updateSubmitButton();
  scrollLog(rev);
}

function ensurePanel(rev) {
  if (rev.els?.panel) return rev.els.panel;
  const panel = document.createElement("div");
  panel.className = "review-panel";
  panel.dataset.jobId = rev.id;
  const head = document.createElement("div"); head.className = "panel-head";
  const submeta = document.createElement("div"); submeta.className = "submeta";
  const stepper = document.createElement("div"); stepper.className = "stepper";
  const summary = document.createElement("div"); summary.className = "card summary";
  const sect = document.createElement("div"); sect.className = "sect";
  sect.innerHTML = `<div class="sect-h"><span class="chev">▸</span> Activity <span class="count">0 events</span></div><div class="sect-body"><ol class="log"></ol></div>`;
  panel.append(head, submeta, stepper, summary, sect);
  panels.appendChild(panel);
  rev.els = { ...(rev.els || {}), panel, head, submeta, stepper, summary, sect, log: sect.querySelector(".log"), count: sect.querySelector(".count") };
  renderHead(rev); renderStepper(rev); renderSummary(rev);
  return panel;
}

function renderHead(rev) {
  if (!rev.els?.head) return;
  const num = rev.prMeta?.number || prNumberFromUrl(rev.prUrl);
  const repo = rev.prMeta?.nameWithOwner || "";
  const title = rev.prMeta?.title || (num ? `PR #${num}` : `Review ${rev.id.slice(0, 8)}`);
  const head = rev.els.head;
  head.replaceChildren();
  // Title link is built as a DOM node so the PR URL never enters an HTML
  // string, and only a validated http(s) URL is assigned to href (parsing
  // rejects javascript: and other schemes → falls back to "#").
  const a = document.createElement("a");
  a.className = "ttl";
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `${title} ↗`;
  a.href = "#";
  try {
    const u = new URL(rev.prUrl || "");
    if (u.protocol === "https:" || u.protocol === "http:") { a.href = u.href; a.title = rev.prUrl; }
  } catch {}
  head.appendChild(a);
  // Remaining controls built via DOM (no HTML sink) — text via textContent.
  const badge = document.createElement("span");
  badge.className = `badge ${rev.state}`;
  badge.textContent = badgeText(rev);
  head.appendChild(badge);
  if (rev.state === "done") {
    // Approve button. Shown whenever a password is configured on the host.
    // When the browser is locked it renders muted with a 🔒; clicking it opens
    // the unlock prompt (and continues the approve once unlocked). The server
    // approves under its own gh identity, so a self-authored PR is refused.
    if (rev.outcome === "approved") {
      const b = document.createElement("button");
      b.className = "approve"; b.disabled = true; b.textContent = "✓ Approved";
      head.appendChild(b);
    } else if (passwordConfigured) {
      const b = document.createElement("button");
      b.className = "approve";
      b.dataset.id = rev.id;
      if (hostLogin && rev.prMeta?.authorLogin && hostLogin === rev.prMeta.authorLogin) {
        b.disabled = true; b.textContent = "✓ Approve PR";
        b.title = `Can't approve your own PR (prsnooze approves as @${hostLogin})`;
      } else if (!unlocked) {
        b.classList.add("locked"); b.textContent = "🔒 Approve PR";
        b.title = "Locked — click to enter the admin password";
      } else {
        b.textContent = "✓ Approve PR";
      }
      head.appendChild(b);
    }
    // Re-checking a finished review ("Verify fixes") is driven from the topbar
    // button: selecting a review fills its URL into the search, which flips the
    // Start-review button to Verify-fixes. See updateSubmitButton().
  }
  const modes = document.createElement("div");
  modes.className = "modes";
  for (const m of ["zen", "detailed"]) {
    const mb = document.createElement("button");
    mb.dataset.mode = m;
    if (mode === m) mb.className = "on";
    mb.textContent = m === "zen" ? "🧘 Zen" : "🛠 Detailed";
    modes.appendChild(mb);
  }
  head.appendChild(modes);
  rev.els.submeta.textContent = `${repo}${num ? " #" + num : ""}${rev.prMeta?.authorLogin ? " · @" + rev.prMeta.authorLogin : ""}`;
}

function badgeText(rev) {
  let t = rev.state;
  if (rev.phase && isActive(rev.state)) t = `${rev.state} · ${phaseShort(rev.phase)}`;
  if (rev.outcome) t = `${t} · ${outcomeLabel(rev.outcome)}`;
  return t;
}
function needsApprove(rev) { return rev.state === "done" && rev.outcome !== "approved"; }

function renderStepper(rev) {
  if (!rev.els?.stepper) return;
  const idx = phaseIndex(rev.phase);
  const done = rev.state === "done";
  let html = "";
  for (let i = 0; i < PHASES.length; i++) {
    let c = "";
    if (done) c = "done";
    else if (i < idx) c = "done";
    else if (i === idx) c = isActive(rev.state) ? "cur" : "stop";
    html += `<div class="step"><div class="seg ${c}"><i></i></div><span class="slabel${i === idx && isActive(rev.state) ? " on" : ""}">${PHASES[i].label}</span></div>`;
  }
  rev.els.stepper.innerHTML = html;
}

function renderSummary(rev) {
  if (!rev.els?.summary) return;
  const s = rev.state, o = rev.outcome;
  let cls = "", html;
  if (isActive(s)) { cls = "run"; html = `<b>Reviewing now…</b> live progress above. The verdict and any findings appear here when it finishes.`; }
  else if (s === "interrupted") { cls = "warn"; html = `⏸ <b>Interrupted.</b> The server restarted mid-review — use ↻ Restart Review to run it again.`; }
  else if (s === "failed") { cls = "warn"; html = `❌ <b>Failed.</b> ${escapeHtml(rev.errorText || "See the activity log below.")}`; }
  else {
    let lead;
    switch (o) {
      case "approved": lead = "✓ <b>Approved.</b>"; break;
      case "commented": lead = "💬 <b>Commented.</b>"; break;
      case "changes_requested": lead = "⚠ <b>Changes requested.</b>"; break;
      case "no_new_findings": lead = "○ <b>Nothing new.</b> No comment posted — every concern was already covered."; break;
      case "skipped": lead = "↪ <b>Skipped.</b> " + escapeHtml(rev.skipReason || ""); break;
      default: lead = "✓ <b>Done.</b>";
    }
    // The full verdict/comment is only shown in Detailed mode, small + muted
    // so it doesn't dominate. Zen shows just the one-line outcome.
    html = lead + (rev.summaryText && mode === "detailed" ? `<div class="summary-detail">${escapeHtml(rev.summaryText)}</div>` : "");
  }
  rev.els.summary.className = "card summary" + (cls ? " " + cls : "");
  rev.els.summary.innerHTML = html;
}

function applyMode(rev) {
  if (rev.els?.sect) rev.els.sect.classList.toggle("open", mode === "detailed");
}
function setMode(m) {
  mode = m;
  localStorage.setItem(LS_MODE, m);
  for (const r of reviews.values()) { if (r.els?.head) { renderHead(r); renderSummary(r); } applyMode(r); }
}

async function loadFinishedLog(rev) {
  rev.panelLoaded = true;
  try {
    const r = await fetch(`/api/jobs/${rev.id}`);
    if (!r.ok) return;
    const job = await r.json();
    if (job.prMeta) rev.prMeta = job.prMeta;
    rev.state = job.state; rev.outcome = job.outcome || rev.outcome; rev.finished = true;
    if (job.summary?.finalText) rev.summaryText = job.summary.finalText;
    rev.sessionId = job.sessionId || job.summary?.sessionId || rev.sessionId;
    for (const ev of job.events || []) { if (ev.kind === "phase") rev.phase = ev.phase; appendLog(rev, ev); }
    rev.els.count.textContent = `${rev.els.log.children.length} events`;
    renderHead(rev); renderStepper(rev); renderSummary(rev); renderLists();
    if (rev.id === selectedId) updateSubmitButton();
  } catch {}
}

// --------------------------------------------------------------- streaming --
function openStream(rev) {
  if (rev.es) { try { rev.es.close(); } catch {} }
  ensurePanel(rev);
  rev.els.log.innerHTML = ""; rev._systemShown = false;
  // Everything the server replays up front is history (including, on a Verify
  // re-run, the whole original review). Render it, but don't let a replayed
  // "done" re-fire chimes/notifications — the caught_up sentinel ends replay.
  rev.replaying = true;
  const es = new EventSource(`/api/jobs/${rev.id}/events`);
  rev.es = es;
  es.onmessage = (msg) => { let ev; try { ev = JSON.parse(msg.data); } catch { return; } handleEvent(rev, ev); };
  // No refetch on error: EventSource auto-reconnects, and the job list is kept
  // fresh by the WebSocket — so an SSE hiccup must not spam /api/jobs.
  es.onerror = () => {};
}

function handleEvent(rev, ev) {
  appendLog(rev, ev);
  if (rev.els?.count) rev.els.count.textContent = `${rev.els.log.children.length} events`;
  switch (ev.kind) {
    case "phase": rev.phase = ev.phase; setState(rev, "running"); break;
    case "started": setState(rev, "running"); break;
    case "queued": setState(rev, "queued"); break;
    case "pr_meta": rev.prMeta = ev; renderHead(rev); renderLists(); break;
    case "outcome_detected": rev.outcome = ev.outcome; renderHead(rev); renderSummary(rev); renderLists(); break;
    case "summary": if (ev.finalText) rev.summaryText = ev.finalText; if (ev.sessionId) rev.sessionId = ev.sessionId; renderSummary(rev); break;
    case "skipped": rev.outcome = ev.outcome || "skipped"; rev.skipReason = ev.reason; finish(rev, "done"); break;
    case "failed": rev.errorText = ev.error || ""; finish(rev, "failed"); break;
    case "done": finish(rev, "done"); break;
    case "interrupted": setState(rev, "interrupted"); break;
    case "stream_end": if (!rev.finished && isTerminal(ev.state)) finish(rev, ev.state); break;
    case "caught_up":
      // End of the replayed backlog. The job is genuinely still running (the
      // server only sends this for unfinished jobs), so clear the completion
      // state a replayed "done" may have set, and let live events chime.
      rev.replaying = false; rev.finished = false; rev.notified = false; rev.freshFinish = false;
      break;
  }
}

function setState(rev, state) {
  const was = rev.state;
  rev.state = state;
  renderHead(rev); renderStepper(rev); renderSummary(rev);
  if (isActive(was) !== isActive(state)) renderLists(); else updateActiveRow(rev);
  if (rev.id === selectedId) updateSubmitButton();
  updateStatusLight();
}

function updateActiveRow(rev) {
  // cheap live refresh of just this active row's phase/bar without full rebuild
  renderLists();
}

function finish(rev, state) {
  const first = !rev.finished;
  rev.finished = true; rev.freshFinish = true; rev.state = state;
  if (!rev.finishedAt) rev.finishedAt = Date.now();
  // Job is terminal — close its live SSE. A finished job's stream is closed by
  // the server after stream_end, and EventSource auto-reconnects on that close,
  // which reconnect-loops (surfacing as failed /events in the network tab).
  // Skip during replay: caught_up will resume the live stream of a still-running
  // job whose backlog happens to include an earlier terminal event (verify re-run).
  if (!rev.replaying && rev.es) { try { rev.es.close(); } catch {} rev.es = null; }
  renderHead(rev); renderStepper(rev); renderSummary(rev); renderLists();
  if (rev.id === selectedId) { updateSubmitButton(); applyMode(rev); }
  if (first && !rev.notified && !rev.replaying) { rev.notified = true; notify(rev); playChime(statusMeta(rev).needsYou); }
  updateStatusLight();
  // No refreshList here: the server broadcasts a fresh job-list snapshot over
  // the WebSocket on this same state change, so the list updates without a poll.
}

// --------------------------------------------------- delegated panel clicks -
panels.addEventListener("click", (e) => {
  const ap = e.target.closest(".approve");
  if (ap && ap.dataset.id && !ap.disabled) {
    // Locked → open the unlock prompt and remember to continue this approve.
    if (!unlocked) { pendingApprove = { id: ap.dataset.id }; openUnlock(); return; }
    approveReview(ap.dataset.id, ap); return;
  }
  const mb = e.target.closest(".modes button");
  if (mb) { setMode(mb.dataset.mode); return; }
  const sh = e.target.closest(".sect-h");
  if (sh) { sh.parentElement.classList.toggle("open"); }
});

async function approveReview(id, btn) {
  const rev = reviews.get(id);
  if (!rev) return;
  if (btn) { btn.disabled = true; btn.textContent = "Approving…"; }
  try {
    // Server runs `gh pr review --approve` under the host's own gh login,
    // gated on the privilege cookie (see /api/jobs/:id/approve). The password
    // is never in the browser; the cookie proves this browser unlocked.
    const r = await fetch(`/api/jobs/${id}/approve`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Cookie expired / never set → re-prompt for the password, then retry.
      if (r.status === 401 || data.locked) {
        unlocked = false; updateLockChip();
        pendingApprove = { id };
        renderHead(rev);
        openUnlock();
        return;
      }
      showToast("Couldn't approve: " + escapeHtml(data.error || `HTTP ${r.status}`));
      renderHead(rev);
      return;
    }
    rev.outcome = "approved";
    renderHead(rev); renderSummary(rev); renderLists();
    showToast("✓ Approved on GitHub.");
  } catch (e) {
    showToast("Couldn't approve: " + escapeHtml(e.message));
    renderHead(rev);
  }
}

// --------------------------------------------------------- privilege / lock -
function updateLockChip() {
  if (!lockChip) return;
  lockChip.hidden = !passwordConfigured;
  lockChip.textContent = unlocked ? "🔓 Unlocked" : "🔒 Locked";
  lockChip.classList.toggle("on", unlocked);
  lockChip.title = unlocked
    ? "Privileged actions unlocked in this browser — click to re-lock"
    : "Privileged actions locked — click to enter the admin password";
}
function setUnlocked(on) {
  unlocked = on;
  updateLockChip();
  for (const r of reviews.values()) if (r.els?.head) renderHead(r);
  clearTimeout(relockTimer);
  if (on) relockTimer = setTimeout(() => { setUnlocked(false); showToast("🔒 Re-locked after 1 hour."); }, 60 * 60 * 1000);
}
function openUnlock() {
  if (!passwordConfigured) { showToast("Approve is disabled — no admin password is set on the host."); return; }
  unlockErr.hidden = true; unlockPass.value = "";
  unlockPass.type = "password"; if (unlockEye) unlockEye.textContent = "👁";
  unlockBackdrop.hidden = false;
  setTimeout(() => unlockPass.focus(), 30);
}
function closeUnlock() { unlockBackdrop.hidden = true; pendingApprove = null; }
async function submitUnlock() {
  const password = unlockPass.value;
  if (!password) { unlockErr.textContent = "Enter the password."; unlockErr.hidden = false; return; }
  try {
    const r = await fetch("/api/unlock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      unlockErr.textContent = data.error === "incorrect password" ? "Incorrect password." : (data.error || "Couldn't unlock.");
      unlockErr.hidden = false;
      unlockForm.classList.remove("shake"); void unlockForm.offsetWidth; unlockForm.classList.add("shake");
      return;
    }
    unlockPass.value = "";
    unlockBackdrop.hidden = true;
    setUnlocked(true);
    showToast("🔓 Unlocked for 1 hour.");
    // Continue an approve that was waiting on the password.
    const p = pendingApprove; pendingApprove = null;
    if (p) {
      const btn = document.querySelector(`.review-panel.active .approve[data-id="${p.id}"]`);
      approveReview(p.id, btn || null);
    }
  } catch (e) {
    unlockErr.textContent = "Couldn't reach the server."; unlockErr.hidden = false;
  }
}
async function relock() {
  try { await fetch("/api/lock", { method: "POST" }); } catch {}
  setUnlocked(false);
  showToast("🔒 Locked.");
}
if (lockChip) lockChip.addEventListener("click", () => { if (unlocked) relock(); else openUnlock(); });
if (unlockForm) unlockForm.addEventListener("submit", (e) => { e.preventDefault(); submitUnlock(); });
if (unlockCancel) unlockCancel.addEventListener("click", closeUnlock);
if (unlockEye) unlockEye.addEventListener("click", () => {
  const show = unlockPass.type === "password";
  unlockPass.type = show ? "text" : "password";
  unlockEye.textContent = show ? "🙈" : "👁";
  unlockPass.focus();
});
if (unlockBackdrop) unlockBackdrop.addEventListener("click", (e) => { if (e.target === unlockBackdrop) closeUnlock(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !unlockBackdrop.hidden) closeUnlock(); });

async function verifyReview(id) {
  const rev = reviews.get(id);
  if (!rev) return;
  showToast("Verifying — resuming the original review to check your comments…");
  try {
    const r = await fetch(`/api/jobs/${id}/verify`, { method: "POST" });
    const data = await r.json();
    if (!r.ok) { showToast("Couldn't verify: " + escapeHtml(data.error || "error")); return; }
    // Reset so the resumed run streams live in place.
    if (rev.es) { try { rev.es.close(); } catch {} rev.es = null; }
    rev.finished = false; rev.state = "running"; rev.outcome = null;
    ensurePanel(rev); openStream(rev); selectReview(id); renderLists();
  } catch (e) { showToast("Couldn't verify: " + escapeHtml(e.message)); }
}

let toastTimer = null;
function showToast(html) {
  toastEl.innerHTML = html;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
}

// ------------------------------------------------------ log entry builder ---
function humanSize(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const TOOL_ICONS = { Bash: "❯", Read: "📄", Edit: "✏️", Write: "📝", Grep: "🔍", Glob: "🗂", WebFetch: "🌐", WebSearch: "🔎", Task: "🤖" };
function friendlyTitle(tool, cmd) {
  if (tool === "WebFetch") return "Fetching a web page";
  if (tool === "Task") return "Running a sub-agent";
  if (tool !== "Bash") return "";
  const c = cmd || "";
  const map = [
    [/gh\s+pr\s+diff/, "Reading the PR diff"], [/gh\s+pr\s+view/, "Fetching PR details"],
    [/gh\s+api\s+graphql/, "Checking review threads"], [/gh\s+api\b[\s\S]*comments/, "Checking existing comments"],
    [/gh\s+pr\s+review|gh\s+api\b[\s\S]*reviews/, "Posting the review"], [/gh\s+pr\s+comment/, "Posting a comment"],
    [/gh\s+api/, "Calling the GitHub API"], [/\bgit\s+/, "Running git"],
    [/\b(rg|grep)\b/, "Searching the code"], [/\b(cat|head|tail|ls|find|stat|wc)\b/, "Inspecting files"],
    [/\b(sed|awk|jq)\b/, "Processing output"], [/\b(npm|yarn|pnpm|node|python3?|go|cargo|mvn|gradle|make)\b/, "Running a command"],
  ];
  for (const [re, t] of map) if (re.test(c)) return t;
  return "Running a command";
}
function details(summary, content, open) {
  return `<details class="log-details"${open ? " open" : ""}><summary>${summary}</summary><pre>${escapeHtml(content)}</pre></details>`;
}
function entrySpec(ev) {
  const kind = ev.kind || "event";
  switch (kind) {
    case "queued": return { cat: "meta", icon: "⏳", label: "queued", body: `position ${ev.position}` };
    case "started": return { cat: "meta", icon: "▶", label: "started", body: "worker started" };
    case "claude_started": return { cat: "meta", icon: "▶", label: "claude", body: `pid ${ev.pid ?? "?"}` };
    case "phase": return { cat: "phase", icon: "▸", label: "phase", body: `<strong>${escapeHtml(ev.phase || "")}</strong>` };
    case "verify_restart": return { cat: "divider", icon: "↻", label: "", body: `<strong>${escapeHtml(ev.message || "Verify fixes — re-checking")}</strong>` };
    case "caught_up": return null;
    case "log": return { cat: "info", icon: "·", label: "log", body: escapeHtml(ev.message || "") };
    case "pr_meta": return { cat: "pr", icon: "🔗", label: "PR", body: `<strong>${escapeHtml(ev.nameWithOwner || "")} #${ev.number}</strong> — ${escapeHtml(ev.title || "")}` };
    case "worktree_ready": return { cat: "info", icon: "📁", label: "worktree", body: `<span class="dim">${escapeHtml(ev.path || "")}</span>` };
    case "interrupted": return { cat: "warn", icon: "⏸", label: "interrupted", body: escapeHtml(ev.message || "interrupted") };
    case "skill_resolved": { const tag = ev.source === "project" ? "project" : ev.source === "user" ? "user" : ev.source === "bundled" ? "bundled" : ""; return { cat: "ok", icon: "🧩", label: "skill", body: `<strong>${escapeHtml(ev.name || "")}</strong> <span class="tag">${escapeHtml(tag)}</span> <span class="dim">${escapeHtml(ev.pathDisplay || ev.path || "")}</span>` }; }
    case "skill_missing": return { cat: "warn", icon: "🧩", label: "skill", body: `<strong>no project skill</strong> — generic review ${details("paths searched", (ev.attempted || []).join("\n"))}` };
    case "approval_policy": { const v = !ev.autoApprove ? "disabled" : ev.sizeOk ? "eligible" : "blocked (size)"; return { cat: "pr", icon: "🛂", label: "approval", body: `<strong>${escapeHtml(v)}</strong> <span class="dim">${escapeHtml(ev.reason || "")}</span>` }; }
    case "outcome_detected": return { cat: "ok", icon: "🏁", label: "outcome", body: `<strong>${escapeHtml(outcomeLabel(ev.outcome))}</strong>` };
    case "skipped": return { cat: "warn", icon: "↪", label: "skipped", body: `<strong>${escapeHtml(ev.reason || "")}</strong> <span class="dim">${escapeHtml(ev.detail || "")}</span>` };
    case "system": return { cat: "sys", icon: "•", label: "session", body: `<span class="dim">${(ev.sessionId || "").slice(0, 8)}${ev.model ? " · " + escapeHtml(ev.model) : ""}</span>` };
    case "assistant_text": return { cat: "think", icon: "💭", label: "", body: escapeHtml(ev.text || "") };
    case "tool_use": { const tool = ev.tool || "tool"; const cmd = ev.summary || ""; const title = friendlyTitle(tool, cmd); let body = title ? `<span class="ev-title">${escapeHtml(title)}</span> <span class="arg">${escapeHtml(cmd)}</span>` : `<strong>${escapeHtml(tool)}</strong> <span class="arg">${escapeHtml(cmd)}</span>`; if (ev.full) body += " " + details("input", JSON.stringify(ev.full, null, 2)); return { cat: "tool", icon: TOOL_ICONS[tool] || "🔧", label: "", body }; }
    case "tool_result": { const size = humanSize(ev.length); const preview = (ev.preview || "").trim(); const first = preview.split("\n")[0].slice(0, 100); const body = `<span class="dim">${size}</span>` + (first ? ` <span class="arg">${escapeHtml(first)}</span>` : "") + (preview ? " " + details("output", preview, ev.isError) : ""); return { cat: ev.isError ? "err" : "result", icon: ev.isError ? "✗" : "✓", label: "", body }; }
    case "result": return { cat: ev.isError ? "err" : "ok", icon: ev.isError ? "⚠️" : "✅", label: "result", body: `claude ${ev.isError ? "error" : "ok"} · turns ${ev.numTurns}` };
    case "stderr": return { cat: "err", icon: "⚠", label: "stderr", body: escapeHtml(ev.text || "") };
    case "failed": return { cat: "err", icon: "❌", label: "failed", body: `<strong>${escapeHtml(ev.error || "failed")}</strong>${ev.code ? ` <span class="dim">(${escapeHtml(ev.code)})</span>` : ""}` };
    case "done": return { cat: "ok", icon: "✅", label: "done", body: "finished" };
    case "summary": case "stream_end": return null;
    default: return { cat: "info", icon: "·", label: kind, body: escapeHtml(JSON.stringify(ev)) };
  }
}
function appendLog(rev, ev) {
  if (!rev.els?.log) return;
  if (ev.kind === "system") { if (rev._systemShown) return; rev._systemShown = true; }
  const spec = entrySpec(ev);
  if (!spec) return;
  const chip = spec.label ? `<span class="ev-chip">${escapeHtml(spec.label)}</span>` : "";
  const inner = `<span class="ev-time">${formatTs(ev.ts)}</span><span class="ev-icon">${spec.icon}</span>${chip}<span class="ev-body">${spec.body}</span>`;
  const sig = `${spec.cat}|${inner}`;
  const log = rev.els.log;
  const last = log.lastElementChild;
  if (last && last.dataset.sig === sig) {
    const n = (parseInt(last.dataset.count || "1", 10) || 1) + 1;
    last.dataset.count = String(n);
    let b = last.querySelector(".ev-count");
    if (!b) { b = document.createElement("span"); b.className = "ev-count"; last.appendChild(b); }
    b.textContent = `×${n}`;
    return;
  }
  const li = document.createElement("li");
  li.className = `ev cat-${spec.cat}`;
  li.dataset.sig = sig;
  li.innerHTML = inner;
  log.appendChild(li);
  scrollLog(rev);
}
function scrollLog(rev) { if (rev.id === selectedId && rev.els?.log) rev.els.log.scrollTop = rev.els.log.scrollHeight; }

// ------------------------------------------------------------ status light --
function statusMeta(rev) {
  const s = rev.state, o = rev.outcome;
  if (s === "running") return { icon: "●", cls: "running", running: true };
  if (s === "queued") return { icon: "○", cls: "queued", running: true };
  if (s === "failed") return { icon: "✗", cls: "failed", needsYou: true };
  if (s === "interrupted") return { icon: "⏸", cls: "interrupted" };
  switch (o) {
    case "approved": return { icon: "✓", cls: "approved" };
    case "commented": return { icon: "💬", cls: "commented" };
    case "changes_requested": return { icon: "⚠", cls: "changes", needsYou: true };
    case "no_new_findings": return { icon: "○", cls: "nonew" };
    case "skipped": return { icon: "↪", cls: "skipped" };
    default: return { icon: "✓", cls: "done" };
  }
}
function brandFavicon(variant) {
  const eyes = variant === "idle"
    ? `<path d="M14 33 q9 10 18 0" fill="none" stroke="#f2e9e0" stroke-width="4" stroke-linecap="round"/><path d="M33 33 q9 10 18 0" fill="none" stroke="#f2e9e0" stroke-width="4" stroke-linecap="round"/>`
    : `<ellipse cx="24" cy="34" rx="9" ry="11" fill="#f2e9e0"/><circle cx="24" cy="36" r="4.6" fill="#1b1815"/><ellipse cx="42" cy="34" rx="9" ry="11" fill="#f2e9e0"/><circle cx="42" cy="36" r="4.6" fill="#1b1815"/>`;
  const zzz = variant === "idle" ? `<text x="39" y="21" font-family="Arial,sans-serif" font-size="17" font-weight="bold" fill="#fb923c">z</text>` : "";
  const dot = variant === "needs" ? `<circle cx="52" cy="12" r="7" fill="#ef4444"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#2a241f"/>${eyes}${zzz}${dot}</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
function updateStatusLight() {
  let running = 0, needsYou = 0;
  for (const rev of reviews.values()) { const m = statusMeta(rev); if (m.running) running++; if (m.needsYou && rev.freshFinish) needsYou++; }
  const who = hostName ? ` — ${hostName}'s machine` : "";
  let variant, title;
  if (running > 0) { variant = "running"; title = `(${running}) prsnooze${who} · reviewing`; }
  else if (needsYou > 0) { variant = "needs"; title = `⚠ prsnooze${who} · ${needsYou} need${needsYou > 1 ? "" : "s"} you`; }
  else { variant = "idle"; title = `prsnooze${who}`; }
  document.title = title;
  faviconEl.href = brandFavicon(variant);
}

// ----------------------------------------------------------- notifications -
function requestNotifPermission() { if (!("Notification" in window)) return; if (Notification.permission === "default") Notification.requestPermission().then(updateNotifHint); updateNotifHint(); }
function updateNotifHint() { if (!("Notification" in window)) { notifHint.textContent = ""; return; } notifHint.textContent = Notification.permission === "granted" ? "🔔 on" : Notification.permission === "denied" ? "🔕" : ""; }
function notify(rev) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const m = statusMeta(rev);
  const name = rev.prMeta ? `${rev.prMeta.nameWithOwner} #${rev.prMeta.number}` : rev.prUrl || "review";
  try { new Notification(`${m.icon} ${name}`, { body: outcomeLabel(rev.outcome) || rev.state, tag: rev.id }); } catch {}
}
let audioCtx = null;
function playChime(needsYou) {
  if (!soundToggle.checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    (needsYou ? [740, 555] : [555, 740]).forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      const t = now + i * 0.16;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.start(t); o.stop(t + 0.17);
    });
  } catch {}
}
soundToggle.addEventListener("change", () => localStorage.setItem(LS_SOUND, soundToggle.checked ? "1" : "0"));

// ------------------------------------------------------------- list refresh -
// Apply a job-list snapshot (from the WS push, or the one-shot initial fetch).
function applySnapshot(data) {
  for (const j of data.jobs || []) {
    const rev = upsertReview(j);
    if (isActive(rev.state) && !rev.es) { ensurePanel(rev); openStream(rev); }
    if (!rev.es) { rev.state = j.state; rev.outcome = j.outcome || rev.outcome; }
  }
  // Drop rows the server no longer has (removed here or from another browser).
  // Only against a complete snapshot, and only finished reviews — a just-
  // submitted one we know about locally may not be in a snapshot already in
  // flight, and must not be pruned out from under the user.
  if (data.complete) {
    const live = new Set((data.jobs || []).map((j) => j.id));
    for (const id of Array.from(reviews.keys())) {
      const rev = reviews.get(id);
      if (!live.has(id) && !isActive(rev.state)) dropReview(id);
    }
  }
  renderLists();
  renderQueueStatus(data.queue);
  maybeShowWelcome(data.jobs || []);
  if (!selectedId) {
    const saved = localStorage.getItem(LS_SELECTED);
    if (saved && reviews.has(saved)) selectReview(saved);
  }
  emptyState.hidden = selectedId != null;
  updateStatusLight();
}

// One-shot list fetch — used for the first paint and as an SSE-error nudge.
// The recurring updates come over the WebSocket (connectLive), NOT by polling.
async function refreshList() {
  try {
    const r = await fetch("/api/jobs");
    applySnapshot(await r.json());
  } catch {}
}

// Live job-list updates over a WebSocket — replaces the old 5s /api/jobs poll.
// The server pushes a fresh snapshot on connect and on every job state change.
// Auto-reconnects with capped backoff; the server re-syncs us on reconnect.
let liveWs = null;
let liveBackoff = 1000;
let liveReconnectTimer = null;
function connectLive() {
  clearTimeout(liveReconnectTimer);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws;
  try { ws = new WebSocket(`${proto}//${location.host}/ws`); }
  catch { scheduleLiveReconnect(); return; }
  liveWs = ws;
  ws.onmessage = (m) => {
    let data; try { data = JSON.parse(m.data); } catch { return; }
    if (data.type === "snapshot") applySnapshot(data);
    liveBackoff = 1000; // healthy traffic resets the backoff
  };
  ws.onclose = () => { liveWs = null; scheduleLiveReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function scheduleLiveReconnect() {
  clearTimeout(liveReconnectTimer);
  liveReconnectTimer = setTimeout(connectLive, liveBackoff);
  liveBackoff = Math.min(liveBackoff * 2, 15000);
}
function renderQueueStatus(q) {
  if (!q) return;
  const parts = [];
  parts.push(q.running > 0 ? `${q.running} running` : "idle");
  if (q.pending && q.pending.length) parts.push(`${q.pending.length} queued`);
  if (q.concurrency > 1) parts.push(`cap ${q.concurrency}`);
  queueStatusEl.textContent = parts.join(" · ");
}

// ------------------------------------------------------ welcome-back banner -
function maybeShowWelcome(jobs) {
  if (welcomeShown) return;
  welcomeShown = true;
  const lastSeen = Number(localStorage.getItem(LS_LASTSEEN) || 0);
  localStorage.setItem(LS_LASTSEEN, String(Date.now()));
  if (!lastSeen) return;
  const since = (jobs || []).filter((j) => j.finishedAt && j.finishedAt > lastSeen && (j.state === "done" || j.state === "failed"));
  if (!since.length) return;
  let approved = 0, commented = 0, needsYou = 0, other = 0;
  for (const j of since) {
    if (j.state === "failed" || j.outcome === "changes_requested") needsYou++;
    else if (j.outcome === "approved") approved++;
    else if (j.outcome === "commented") commented++;
    else other++;
  }
  const parts = [];
  if (approved) parts.push(`${approved} approved ✓`);
  if (commented) parts.push(`${commented} commented 💬`);
  if (needsYou) parts.push(`${needsYou} need${needsYou > 1 ? "" : "s"} you ⚠`);
  if (other) parts.push(`${other} done`);
  const n = since.length;
  welcomeText.textContent = `${n} review${n > 1 ? "s" : ""} finished while you snoozed — ${parts.join(", ")}`;
  welcomeBanner.hidden = false;
  welcomeBanner.classList.toggle("needs-you", needsYou > 0);
}
welcomeDismiss.addEventListener("click", () => { welcomeBanner.hidden = true; });

// ----------------------------------------------------------- shared bits ----
function outcomeLabel(o) {
  switch (o) {
    case "approved": return "✓ approved";
    case "changes_requested": return "⚠ changes requested";
    case "commented": return "💬 commented";
    case "no_new_findings": return "○ nothing new (no post)";
    case "skipped": return "↪ skipped";
    default: return o || "";
  }
}
function formatTs(ts) { if (!ts) return ""; return new Date(ts).toTimeString().slice(0, 8); }
function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function escapeHtml(s) { return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

async function loadConfig() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg.heroImage) document.body.style.setProperty("--hero", `url("${cfg.heroImage}")`);
    isHost = !!cfg.isHost;
    hostLogin = cfg.hostLogin || null;
    passwordConfigured = !!cfg.passwordConfigured;
    unlocked = !!cfg.unlocked;
    if (cfg.host) { hostName = cfg.host; hostNameEl.textContent = `on ${hostName}'s machine`; }
    updateLockChip();
    if (unlocked) setUnlocked(true); // (re)arm the client-side relock timer
    for (const r2 of reviews.values()) if (r2.els?.head) renderHead(r2);
    updateStatusLight();
  } catch {}
}
function stampLastSeen() { localStorage.setItem(LS_LASTSEEN, String(Date.now())); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") stampLastSeen(); });
window.addEventListener("beforeunload", stampLastSeen);

// ------------------------------------------------------------------- init ---
soundToggle.checked = localStorage.getItem(LS_SOUND) === "1";
updateNotifHint();
updateStatusLight();
loadConfig();
refreshList();   // instant first paint (one-shot fetch, not a poll)
connectLive();   // recurring updates via WebSocket — replaces the 5s poll
// Keep relative timestamps ("2m ago") ticking. Local re-render only — no network.
setInterval(() => renderLists(), 60000);
