"use strict";

const $ = (id) => document.getElementById(id);

const form = $("submit-form");
const input = $("pr-url");
const submitBtn = $("submit-btn");
const submitMsg = $("submit-msg");
const providerPick = $("provider-pick");
const providerSelect = $("provider-select");
const hostNameEl = $("host-name");
const notifyToggle = $("notify-toggle");
const queueStatusEl = $("queue-status");
const welcomeBanner = $("welcome-banner");
const welcomeText = $("welcome-text");
const welcomeDismiss = $("welcome-dismiss");
const activeList = $("active-list");
const activeEmpty = $("active-empty");
const recentList = $("recent-list");
const recentEmpty = $("recent-empty");
const rail = $("rail");
const railToggle = $("rail-toggle");
const railBackdrop = $("rail-backdrop");
const runningSect = $("running-sect");
const activeN = $("active-n");
const composer = $("composer");
const composerTop = $("composer-top");
const composerHero = $("composer-hero");
const heroHost = $("hero-host");
const panels = $("panels");
const emptyState = $("empty-state");
const faviconEl = $("favicon");
const toastEl = $("toast");
const modelChip = $("model-chip");
const usageChip = $("usage-chip");
const usageFill = $("usage-fill");
const usageChipText = $("usage-chip-text");
const usagePop = $("usage-pop");
const usageRows = $("usage-rows");
const usageMonth = $("usage-month");
const usageFoot = $("usage-foot");
const pwBackdrop = $("pw-backdrop");
const pwForm = $("pw-form");
const pwInput = $("pw-input");
const pwEye = $("pw-eye");
const pwErr = $("pw-err");
const pwCancel = $("pw-cancel");
const pwSubmit = $("pw-submit");
const confirmBackdrop = $("confirm-backdrop");
const confirmSub = $("confirm-sub");
const confirmOk = $("confirm-ok");
const confirmCancel = $("confirm-cancel");

const LS_SELECTED = "prsnooze:selected";
// Same key as the old sound toggle, so nobody's existing preference resets.
const LS_NOTIFY = "prsnooze:sound";
const LS_ACTIVITY_OPEN = "prsnooze:activityOpen";
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
// Whether the Activity log is expanded. Remembered, because whichever way you
// like to work is how you like to work — it replaced a Zen/Detailed toggle that
// only ever controlled this one thing.
let activityOpen = localStorage.getItem(LS_ACTIVITY_OPEN) === "1";
let hostName = "";
let isHost = false;
let hostLogin = null;
let defaultProvider = "claude";
let welcomeShown = false;
// The id the approve dialogs are about. That is the entire amount of state the
// approve flow keeps, and it lives only between clicking the button and the
// password landing — there is no unlocked-browser state to arm or expire.
let pendingApprove = null;
// "Tell me when a review finishes" — one flag for the chime and the desktop
// notification. Declared here with the rest of the module state: playChime() and
// the toggle's own handler are defined above the init block and both read it.
let notifyOn = localStorage.getItem(LS_NOTIFY) === "1";

const isActive = (s) => s === "queued" || s === "running";
const isTerminal = (s) => s === "done" || s === "failed" || s === "interrupted";

// --------------------------------------------------------------- icons ------
// Stroke icons (Lucide shapes) instead of emoji. Emoji render differently on
// every OS, can't take currentColor, and are what made the chrome look
// unfinished. Anything decorative is aria-hidden; meaning is carried by
// adjacent text or an aria-label.
const ICON_PATHS = {
  play: '<path d="M7 4.5v15l12-7.5-12-7.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  // For the Approve action. Deliberately NOT the tick: a check on a button that
  // hasn't been pressed yet reads as "this is approved" rather than "approve it".
  thumbsup: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  comment: '<path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.4-4.4A8 8 0 0 1 13 4a8 8 0 0 1 8 8z"/>',
  alert: '<path d="M12 4 2.5 20.5h19L12 4z"/><path d="M12 10v4.5"/><path d="M12 17.6v.01"/>',
  xcircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
  skip: '<path d="M5 6.5 13 12l-8 5.5V6.5z"/><path d="M17 6v12"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  trash: '<path d="M4 7.5h16"/><path d="M9.5 7.5V5.4A1.4 1.4 0 0 1 11 4h2a1.4 1.4 0 0 1 1.5 1.4v2.1"/><path d="M6.5 7.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2A1.5 1.5 0 0 0 16.6 19l.9-11.5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h4.5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  wrench: '<path d="M14.5 6.2a3.8 3.8 0 0 1 5.2 5.2l-2.4-2.4-2.8 2.8-2.4-2.4 2.8-2.8-.4-.4z"/><path d="m12.3 11.5-7.2 7.2a1.8 1.8 0 0 0 2.5 2.5l7.2-7.2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  branch: '<circle cx="6.5" cy="6" r="2.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M6.5 8.5v7"/><path d="M15 9.6a5.5 5.5 0 0 1-5.4 4.5"/>',
  diff: '<path d="M6 3.5v17"/><path d="M3.5 6h5"/><path d="M18 20.5v-17"/><path d="M15.5 18h5"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 1.6"/><path d="M9.5 2.5h5"/>',
  turns: '<path d="M4 8h11a4 4 0 0 1 0 8H8"/><path d="m10.5 13-2.5 3 2.5 3"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9"/><path d="M14.5 9.8a2.6 2.6 0 0 0-2.5-1.3c-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2a2.7 2.7 0 0 1-2.5-1.3"/>',
  files: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5z"/><path d="M13.8 3.6V8h4.6"/>',
  chip: '<rect x="7.5" y="7.5" width="9" height="9" rx="2"/><path d="M10 4v3.5M14 4v3.5M10 16.5V20M14 16.5V20M4 10h3.5M4 14h3.5M16.5 10H20M16.5 14H20"/>',
};
function svgIcon(name, cls = "") {
  return `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="16" height="16" fill="none"` +
    ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${ICON_PATHS[name] || ICON_PATHS.circle}</svg>`;
}
function iconEl(name, cls) {
  const span = document.createElement("span");
  span.className = "ico-wrap";
  span.innerHTML = svgIcon(name, cls); // fixed template, no user data
  return span.firstChild;
}

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
providerSelect?.addEventListener("change", () => {
  usageData = null;
  modelData = null;
  renderUsage();
  renderModel();
  updateSubmitButton();
  refreshUsage();
  refreshModel();
});

function selectedProvider() {
  return providerSelect?.value || defaultProvider || "claude";
}

async function submitUrls(raw) {
  const urls = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return;
  if (notifyOn) requestNotifPermission();
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
        body: JSON.stringify({ prUrl, provider: selectedProvider() }),
      });
      const data = await r.json();
      if (!r.ok) { errors.push(`${prUrl}: ${data.error || `HTTP ${r.status}`}`); continue; }
      const rev = upsertReview({
        id: data.jobId,
        prUrl: data.prUrl,
        provider: data.provider || selectedProvider(),
        state: "queued",
      });
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
    submitBtn.textContent = "Review PR";
    submitBtn.prepend(iconEl("refresh"));
    submitBtn.title = "Review this PR again — resumes the earlier session so it can check whether the comments were addressed";
    submitBtn.dataset.verifyId = rev.id;
  } else {
    submitBtn.textContent = "Review PR";
    submitBtn.title = "Start a review of this PR";
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
    if (
      rev.state === "done" &&
      rev.sessionId &&
      (rev.provider || "claude") === selectedProvider() &&
      normUrl(rev.prUrl) === target
    ) {
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
      id: data.id, prUrl: data.prUrl, provider: data.provider || "claude",
      prMeta: null, state: data.state || "queued",
      phase: null, outcome: data.outcome || null, skipped: !!data.skipped,
      skipReason: data.skipReason || null, skipMessage: data.skipMessage || null,
      finished: false, freshFinish: false, notified: false, finishedAt: data.finishedAt || null,
      createdAt: data.createdAt || null, stats: null,
      requestedBy: data.requestedBy || null,
      lastResumeRequestedBy: data.lastResumeRequestedBy || null,
      summaryText: "", errorText: "", es: null, panelLoaded: false, els: null, _systemShown: false,
    };
    reviews.set(rev.id, rev);
  }
  if (data.prUrl && !rev.prUrl) rev.prUrl = data.prUrl;
  if (data.provider) rev.provider = data.provider;
  if (data.state) rev.state = data.state;
  if (data.outcome) rev.outcome = data.outcome;
  if (data.finishedAt) rev.finishedAt = data.finishedAt;
  if (data.createdAt) rev.createdAt = data.createdAt;
  if (data.skipReason) rev.skipReason = data.skipReason;
  if (data.skipMessage) rev.skipMessage = data.skipMessage;
  if (data.skipped) rev.skipped = true;
  if (data.prMeta && !rev.prMeta) rev.prMeta = data.prMeta;
  else if (data.nameWithOwner && !rev.prMeta) rev.prMeta = { nameWithOwner: data.nameWithOwner, number: data.number, title: data.title };
  if (data.requestedBy) rev.requestedBy = data.requestedBy;
  if (data.lastResumeRequestedBy) rev.lastResumeRequestedBy = data.lastResumeRequestedBy;
  return rev;
}

// ----------------------------------------------------------------- lists ----
function renderLists() {
  const all = Array.from(reviews.values());
  const active = all.filter((r) => isActive(r.state));
  const recent = all.filter((r) => !isActive(r.state)).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));

  activeList.replaceChildren(...active.map(railRow));
  activeEmpty.hidden = active.length > 0;
  // The Running heading only earns its space when something is running.
  runningSect.hidden = active.length === 0;
  activeN.textContent = active.length ? String(active.length) : "";

  recentList.replaceChildren(...recent.map(railRow));
  recentEmpty.hidden = recent.length > 0;

  // First run, nothing to navigate: drop the rail entirely and let the composer
  // have the window. The rail appears with the first review.
  document.body.classList.toggle("no-sessions", all.length === 0);
  placeComposer();
}

// On a narrow screen the sessions rail is off-canvas: it slides over the panel
// when asked for and gets out of the way as soon as you've picked something.
// Above the breakpoint none of this applies — the rail is simply always there,
// and the CSS hides the toggle.
function setRailOpen(open) {
  const on = !!open;
  document.body.classList.toggle("rail-open", on);
  railToggle?.setAttribute("aria-expanded", String(on));
  railToggle?.setAttribute("aria-label", on ? "Hide sessions" : "Show sessions");
  if (railBackdrop) railBackdrop.hidden = !on;
}
const closeRail = () => setRailOpen(false);

railToggle?.addEventListener("click", () => setRailOpen(!document.body.classList.contains("rail-open")));
railBackdrop?.addEventListener("click", closeRail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("rail-open")) { closeRail(); railToggle?.focus(); }
});
// A window wide enough for the rail to be docked has no business remembering
// that it was once open as an overlay.
window.addEventListener("resize", () => { if (window.innerWidth > 860) closeRail(); });

// The composer has two homes: the top bar while a review is on screen, and
// centre-stage when the work area is empty. Starting a review is the whole
// point of prsnooze, so an idle screen hands it the stage rather than leaving a
// small bar in a corner. Moving the node (not cloning it) keeps its listeners,
// its value, and any in-flight state intact.
function placeComposer() {
  const hero = selectedId == null;
  const target = hero ? composerHero : composerTop;
  document.body.classList.toggle("hero-mode", hero);
  if (composer.parentElement === target) return;
  target.appendChild(composer);
  // Focus only on the move into the hero, so re-renders can't yank the caret
  // out of something else the user is doing.
  if (hero && !("ontouchstart" in window)) input.focus();
}

// One row shape for every session, running or finished. The rail is now the
// only way to navigate between reviews, so a row has to carry enough to pick
// from: what PR, which repo, how it ended (or how far along it is), and when.
// Built with DOM calls — PR titles and repo names are remote strings and never
// go through an HTML string.
function railRow(r) {
  const m = statusMeta(r);
  const num = r.prMeta?.number || prNumberFromUrl(r.prUrl);
  const label = `#${num || r.id.slice(0, 5)}`;
  const running = isActive(r.state);

  const row = document.createElement("div");
  row.className = `srow ${m.cls}` + (r.id === selectedId ? " selected" : "");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-pressed", String(r.id === selectedId));

  const ico = document.createElement("span");
  ico.className = "srow-ico";
  ico.appendChild(iconEl(m.ico));
  row.appendChild(ico);

  const main = document.createElement("div");
  main.className = "srow-main";

  const top = document.createElement("div");
  top.className = "srow-top";
  const n = document.createElement("span"); n.className = "srow-num"; n.textContent = label;
  const repo = document.createElement("span"); repo.className = "srow-repo";
  repo.textContent = r.prMeta ? shortRepo(r.prMeta.nameWithOwner) : hostFromUrl(r.prUrl);
  if (repo.textContent) repo.title = r.prMeta?.nameWithOwner || repo.textContent;
  // The repo gets the whole top line; the timestamp lives on the footer, where
  // it isn't competing with a name that matters more.
  top.append(n, repo);

  const title = document.createElement("div");
  title.className = "srow-title";
  title.textContent = r.prMeta?.title || r.prUrl || "";
  if (r.prMeta?.title) title.title = r.prMeta.title;

  main.append(top, title);

  // Foot: a live progress bar while running, the outcome otherwise.
  const foot = document.createElement("div");
  foot.className = "srow-foot";
  if (running) {
    const idx = phaseIndex(r.phase);
    const pct = idx < 0 ? 6 : Math.round(((idx + 0.5) / PHASES.length) * 100);
    const ph = document.createElement("span");
    ph.className = "srow-phase";
    ph.textContent = r.phase ? phaseShort(r.phase) : r.state;
    const bar = document.createElement("div");
    bar.className = "srow-bar";
    const fill = document.createElement("i");
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    foot.append(ph, bar);
  } else {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = rowStateText(r);
    foot.appendChild(chip);
    // Merged or closed on GitHub — worth seeing while picking a row, not only
    // after opening it.
    if (r.prState && r.prState !== "OPEN") {
      const ps = document.createElement("span");
      ps.className = `chip prstate ${r.prState.toLowerCase()}`;
      ps.textContent = r.prState.toLowerCase();
      foot.appendChild(ps);
    }
    if (r.finishedAt) {
      const when = document.createElement("span");
      when.className = "srow-when";
      when.textContent = relTime(r.finishedAt);
      foot.appendChild(when);
    }
  }
  main.appendChild(foot);
  row.appendChild(main);

  const select = () => { selectReview(r.id); closeRail(); };
  row.addEventListener("click", select);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
  });

  // Remove-from-list. Its own button with a trash icon — the status glyph on
  // the left used to be an "✗" for failed reviews, which read like a close box
  // and did nothing when clicked.
  if (!running) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "srow-del";
    del.title = "Remove from this list";
    del.setAttribute("aria-label", `Remove review ${label} from the list`);
    del.appendChild(iconEl("trash"));
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteReview(r.id, del); });
    row.appendChild(del);
  }
  return row;
}

// Fallback label for a row whose PR metadata hasn't arrived yet.
function hostFromUrl(u) {
  const m = /github\.com\/([^/]+)\/([^/]+)/.exec(u || "");
  return m ? m[2] : "";
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
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
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
    case "no_new_findings": return "no post";
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
  // Reflect the open review in the URL so a refresh (or a pasted link) lands
  // back on it. replaceState, not push — the rail is the navigation, and every
  // click shouldn't add a history entry to back out of.
  try { history.replaceState(null, "", `#${id}`); } catch {}
  emptyState.hidden = true;
  input.value = rev.prUrl || "";
  const previousProvider = selectedProvider();
  if (providerSelect && Array.from(providerSelect.options).some((option) => option.value === rev.provider)) {
    providerSelect.value = rev.provider;
  }
  if (selectedProvider() !== previousProvider) {
    usageData = null;
    modelData = null;
    renderUsage();
    renderModel();
    refreshUsage();
    refreshModel();
  }
  ensurePanel(rev);
  for (const [rid, r] of reviews) if (r.els?.panel) r.els.panel.classList.toggle("active", rid === id);
  if (!rev.panelLoaded && !rev.es) loadFinishedLog(rev);
  // Only worth asking about a finished review that has a session to resume.
  if (rev.state === "done" && rev.sessionId && !rev.resume) loadResumeCheck(rev);
  // The PR's own state gates the Approve button and draws the merged/closed
  // chip, and neither depends on there being a session — so it's asked for
  // every finished review, independently of the resume check.
  if (rev.state === "done") loadPrState(rev);
  applyActivityState(rev);
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
  const stats = document.createElement("div"); stats.className = "stats";
  const summary = document.createElement("div"); summary.className = "card summary";
  const sect = document.createElement("div"); sect.className = "sect";
  sect.innerHTML = `<div class="sect-h" role="button" tabindex="0"><span class="chev">${svgIcon("chevron")}</span>` +
    `<span class="sect-t">Activity</span><span class="live-dot" aria-hidden="true"></span>` +
    `<span class="sect-peek"></span>` +
    `<span class="count">0 events</span></div><div class="sect-body"><ol class="log"></ol></div>`;
  // Activity sits above the review text: while a run is live the log is the
  // thing worth watching, and the comments only exist once it's done.
  panel.append(head, submeta, stepper, stats, sect, summary);
  panels.appendChild(panel);
  rev.els = { ...(rev.els || {}), panel, head, submeta, stepper, stats, summary, sect,
    log: sect.querySelector(".log"), count: sect.querySelector(".count"), peek: sect.querySelector(".sect-peek"),
    body: sect.querySelector(".sect-body") };
  renderHead(rev); renderStepper(rev); renderStats(rev); renderSummary(rev);
  return panel;
}

// Facts about the run, from data the job already carries: the PR's diff size
// (split prod vs test, which is what the auto-approve caps key off), the branch
// it targets, and what the Claude session cost in time and turns. This is what
// a finished review has to say beyond its one-line verdict — without it the
// panel is a headline over an empty page.
// "claude-opus-4-5-20251101" → "opus-4-5". The vendor prefix and the release
// date are noise in a tile this narrow; the full id stays in the tooltip.
function prettyModelId(id) {
  return String(id).replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function renderStats(rev) {
  const el = rev.els?.stats;
  if (!el) return;
  const m = rev.prMeta || {};
  const s = rev.stats || {};
  const tiles = [];

  if (rev.provider) {
    tiles.push({ icon: "chip", label: "provider", value: rev.provider, sub: "", mono: true });
  }
  if (rev.requestedBy?.label) {
    tiles.push({
      icon: "chip",
      label: "requested by",
      value: rev.requestedBy.label,
      sub: rev.requestedBy.address || "",
      mono: true,
    });
  }
  if (rev.lastResumeRequestedBy?.label) {
    tiles.push({
      icon: "chip",
      label: "last resumed by",
      value: rev.lastResumeRequestedBy.label,
      sub: rev.lastResumeRequestedBy.address || "",
      mono: true,
    });
  }

  if (Number.isFinite(m.additions) || Number.isFinite(m.deletions)) {
    tiles.push({
      icon: "diff",
      label: "diff",
      value: `+${m.additions ?? 0} −${m.deletions ?? 0}`,
      sub: Number.isFinite(m.changedFiles) ? `${m.changedFiles} file${m.changedFiles === 1 ? "" : "s"}` : "",
    });
  }
  if (Number.isFinite(m.prodAdditions) || Number.isFinite(m.prodDeletions)) {
    tiles.push({
      icon: "files",
      label: "prod code",
      value: `+${m.prodAdditions ?? 0} −${m.prodDeletions ?? 0}`,
      sub: Number.isFinite(m.prodFiles) ? `${m.prodFiles} file${m.prodFiles === 1 ? "" : "s"}` : "",
    });
  }
  if (m.headRefName || m.baseRefName) {
    tiles.push({ icon: "branch", label: "branch", value: m.headRefName || "?", sub: m.baseRefName ? `→ ${m.baseRefName}` : "", mono: true });
  }
  if (rev.model) {
    // Which model read this diff. Worth a tile of its own: a review's depth
    // depends on it, and it's the honest answer months later when the host's
    // default has moved on.
    tiles.push({ icon: "chip", label: "model", value: prettyModelId(rev.model), sub: "", mono: true, title: rev.model });
  }
  const ms = s.durationMs || (rev.finishedAt && rev.createdAt ? rev.finishedAt - rev.createdAt : 0);
  if (ms > 0) tiles.push({ icon: "timer", label: "took", value: humanMs(ms), sub: "" });
  if (Number.isFinite(s.numTurns)) tiles.push({ icon: "turns", label: "turns", value: String(s.numTurns), sub: "" });
  if (Number.isFinite(s.totalCostUsd) && s.totalCostUsd > 0) {
    tiles.push({ icon: "coin", label: "cost", value: `$${s.totalCostUsd < 0.01 ? s.totalCostUsd.toFixed(4) : s.totalCostUsd.toFixed(2)}`, sub: "" });
  }
  const inputTokens = Number(s.usage?.input_tokens);
  const outputTokens = Number(s.usage?.output_tokens);
  if (Number.isFinite(inputTokens) || Number.isFinite(outputTokens)) {
    const totalTokens = (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0);
    tiles.push({ icon: "turns", label: "tokens", value: fmtNum(totalTokens), sub: "input + output" });
  }

  el.replaceChildren();
  el.hidden = tiles.length === 0;
  for (const t of tiles) {
    const tile = document.createElement("div");
    tile.className = "stat";
    const head = document.createElement("div");
    head.className = "stat-h";
    head.appendChild(iconEl(t.icon));
    const lb = document.createElement("span"); lb.textContent = t.label;
    head.appendChild(lb);
    const val = document.createElement("div");
    val.className = "stat-v" + (t.mono ? " mono" : "");
    val.textContent = t.value;
    val.title = t.title || t.value;
    tile.append(head, val);
    if (t.sub) {
      const sub = document.createElement("div");
      sub.className = "stat-s" + (t.mono ? " mono" : "");
      sub.textContent = t.sub;
      sub.title = t.sub;
      tile.appendChild(sub);
    }
    el.appendChild(tile);
  }
}

function humanMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function renderHead(rev) {
  if (!rev.els?.head) return;
  const num = rev.prMeta?.number || prNumberFromUrl(rev.prUrl);
  const repo = rev.prMeta?.nameWithOwner || "";
  const title = rev.prMeta?.title || (num ? `PR #${num}` : `Review ${rev.id.slice(0, 8)}`);
  const head = rev.els.head;
  head.replaceChildren();
  // The PR title is just a heading now. The link is the full URL below it —
  // people want to see and copy the whole thing, not hunt for it behind a
  // title. Only a validated http(s) URL is ever assigned to an href (parsing
  // rejects javascript: and friends).
  const h = document.createElement("h1");
  h.className = "ttl";
  h.textContent = title;
  head.appendChild(h);
  // Remaining controls built via DOM (no HTML sink) — text via textContent.
  const badge = document.createElement("span");
  badge.className = `badge ${rev.state}`;
  badge.textContent = badgeText(rev);
  head.appendChild(badge);
  // What happened to the PR itself, separate from what the review said about
  // it. A merged PR is the more important of the two facts and used to be
  // invisible here — the badge only ever reported the review's own outcome.
  if (rev.prState && rev.prState !== "OPEN") {
    const st = document.createElement("span");
    st.className = `badge prstate ${rev.prState.toLowerCase()}`;
    st.textContent = rev.prState.toLowerCase();
    st.title = rev.prState === "MERGED"
      ? "This PR has been merged on GitHub"
      : "This PR was closed on GitHub without merging";
    head.appendChild(st);
  }
  // Somebody else's approval. A fact about the PR, like the merged chip beside
  // it — so it renders as one, not as a disabled button pretending to be an
  // action. Two conditions keep it from repeating what's already on screen: the
  // review's own badge says "approved" when THIS review approved (which is why
  // there is no affirmation for that case — it would be the same word twice),
  // and a merged or closed PR is already accounted for above.
  if (rev.prApproved && rev.prState === "OPEN" && rev.outcome !== "approved") {
    const ap = document.createElement("span");
    ap.className = "badge prapproved";
    ap.textContent = "already approved";
    ap.title = "Someone has already approved this PR on GitHub";
    head.appendChild(ap);
  }
  if (rev.state === "done") {
    if (canApprovePr(rev)) {
      // One shape, always the same: on any approvable review, the button is
      // there and it's live. It has nothing to report about whether this browser
      // is allowed to approve, because that is settled per click — clicking asks
      // for confirmation and then the password, every time. The only variant is
      // a PR the host wrote, which GitHub would refuse anyway.
      const b = document.createElement("button");
      b.className = "approve";
      b.dataset.id = rev.id;
      b.textContent = "Approve PR";
      b.prepend(iconEl("thumbsup"));
      if (hostLogin && rev.prMeta?.authorLogin && hostLogin === rev.prMeta.authorLogin) {
        b.disabled = true;
        b.title = `Can't approve your own PR (prsnooze approves as @${hostLogin})`;
      }
      head.appendChild(b);
    }
    // Resume: continue the original Claude session so it can judge the author's
    // new commits and replies against the comments it already left.
    //
    // Always enabled. Wanting another pass is a legitimate reason on its own —
    // including on an approved PR — so the checks inform rather than forbid:
    // press it, and if the conditions say it's pointless you get the reason and
    // a separate Force resume. The one thing force can't do is run against a
    // merged or closed PR, because there is no longer a PR to review.
    if (rev.sessionId) {
      const a = rev.resume;
      const b = document.createElement("button");
      b.className = "resume";
      b.dataset.resumeId = rev.id;
      b.appendChild(iconEl("refresh"));
      b.appendChild(document.createTextNode("Resume review"));
      b.title = rev.resumeLoading
        ? "Checking the PR for new commits and replies…"
        : a?.resumable
          ? a.reason
          : "Run this review again, continuing the original session";
      head.appendChild(b);

      // Force only appears once a real attempt has been refused.
      if (rev.resumeArmed) {
        const state = String(a?.signals?.prState || "").toUpperCase();
        // The server is the authority on whether forcing is possible; prState is
        // only used to word the explanation.
        const closed = rev.resumeForcible === false || (state && state !== "OPEN");
        const f = document.createElement("button");
        f.className = "resume force";
        f.dataset.forceId = rev.id;
        f.disabled = closed;
        f.appendChild(iconEl(closed ? "xcircle" : "refresh"));
        f.appendChild(document.createTextNode("Force resume"));
        f.title = closed
          ? (state && state !== "OPEN"
              ? `The PR is ${state.toLowerCase()} — a review can't run against it.`
              : a?.reason || "This review can't be resumed.")
          : "Run it again anyway, in the same session";
        head.appendChild(f);
      }
      if (a?.reason) {
        const why = document.createElement("div");
        why.className = "resume-why" + (a.resumable ? " yes" : "");
        why.textContent = a.reason;
        head.appendChild(why);
      }
    }
  }
  renderPrLine(rev);
}

// The full PR URL, shown in full and clickable, plus who opened it.
function renderPrLine(rev) {
  const el = rev.els?.submeta;
  if (!el) return;
  el.replaceChildren();
  let href = null;
  try {
    const u = new URL(rev.prUrl || "");
    if (u.protocol === "https:" || u.protocol === "http:") href = u.href;
  } catch {}
  const link = document.createElement(href ? "a" : "span");
  link.className = "prlink";
  if (href) { link.href = href; link.target = "_blank"; link.rel = "noopener"; }
  link.textContent = rev.prUrl || "";
  link.appendChild(iconEl("external", "ttl-ico"));
  el.appendChild(link);
  if (rev.prMeta?.authorLogin) {
    const by = document.createElement("span");
    by.className = "prby";
    by.textContent = `opened by @${rev.prMeta.authorLogin}`;
    el.appendChild(by);
  }
}

function badgeText(rev) {
  // One label, the most specific one available: the phase while it runs, the
  // outcome once it's finished. "done · commented" was two words for one fact.
  if (isActive(rev.state)) return rev.phase ? `${rev.state} · ${phaseShort(rev.phase)}` : rev.state;
  if (rev.outcome) return outcomeLabel(rev.outcome);
  return rev.state;
}
// canApprovePr() — whether the Approve button belongs on this review — lives in
// can-approve.js, loaded just before this file. It's pure, and it carries enough
// reasoning to deserve tests (test/can-approve.test.js).

function renderStepper(rev) {
  const el = rev.els?.stepper;
  if (!el) return;
  // Five equal labelled segments read as a row of tabs, so the bar is only
  // drawn while there's motion to show. A finished run keeps the same one-line
  // breadcrumb — the stages it went through are worth keeping, just not worth a
  // progress bar that is permanently full.
  el.hidden = false;
  // A skip finishes as "done" but stopped early on purpose, so it gets neither
  // a full green pipeline nor the red "stop" of a failure: the stages it never
  // reached stay unreached, just not as an alarm.
  const skipped = !!rev.skipped;
  const done = rev.state === "done" && !skipped;
  const idx = done ? PHASES.length : phaseIndex(rev.phase);
  const live = isActive(rev.state);
  const pct = idx < 0 ? 4 : Math.round(((idx + (live ? 0.5 : 1)) / PHASES.length) * 100);

  const pipe = document.createElement("div");
  pipe.className = "pipe" + (done ? " pipe-done" : skipped ? " pipe-done pipe-skipped" : "");
  if (done) pipe.appendChild(iconEl("check"));
  else if (skipped) pipe.appendChild(iconEl("skip"));
  PHASES.forEach((ph, i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "pipe-sep";
      sep.textContent = "/";
      pipe.appendChild(sep);
    }
    const st = document.createElement("span");
    st.className = "pipe-step " + (i < idx ? "done" : i === idx ? (live ? "cur" : "stop") : "todo");
    st.textContent = ph.label;
    pipe.appendChild(st);
  });

  if (done || skipped) { el.replaceChildren(pipe); return; }

  const bar = document.createElement("div");
  bar.className = "pipe-bar" + (live ? " live" : " stopped");
  const fill = document.createElement("i");
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);

  el.replaceChildren(pipe, bar);
}

function renderSummary(rev) {
  if (!rev.els?.summary) return;
  const s = rev.state, o = rev.outcome;
  let cls = "", html;
  if (isActive(s)) {
    cls = "run";
    html = svgIcon("play") + `<b>Reviewing now.</b> The verdict and the review text land here when it finishes.`;
  } else if (s === "interrupted") {
    cls = "warn";
    html = svgIcon("pause") + `The server restarted mid-review. Start it again to run from scratch.`;
  } else if (s === "failed") {
    cls = "warn";
    html = svgIcon("xcircle") + escapeHtml(rev.errorText || "Failed — see the activity log below.");
  } else {
    let lead;
    switch (o) {
      case "approved": lead = svgIcon("check") + "Approval posted to the PR — no critical or major issues, and small enough to auto-approve."; break;
      case "commented": lead = svgIcon("comment") + "Review posted to the PR."; break;
      case "changes_requested": lead = svgIcon("alert") + "Changes requested on the PR."; break;
      case "no_new_findings":
        // Only claim nothing was posted when GitHub confirmed it. Unverified,
        // say what we actually know: we didn't see a post.
        lead = svgIcon("circle") + (rev.outcomeVerified === false
          ? "No post detected — GitHub couldn't be checked, so something may have been posted."
          : "No comment posted — every concern was already covered by the existing reviews.");
        break;
      case "skipped": lead = svgIcon("skip") + escapeHtml(skipText(rev)); break;
      default: lead = svgIcon("check") + "Finished.";
    }
    // What the review actually said. This used to be hidden behind a Detailed
    // mode, which left the default view as a one-line verdict over an empty
    // page — hiding the one thing the user came to read.
    const notes = [];
    if (rev.outcomeDetail && rev.outcomeVerified) notes.push(`Confirmed on GitHub: ${escapeHtml(rev.outcomeDetail)}.`);
    else if (rev.outcomeVerified === false && rev.outcome !== "no_new_findings") notes.push("Not confirmed with GitHub — the outcome shown is what the run appeared to do.");
    html = lead
      + (notes.length ? `<div class="verdict-note">${notes.join(" ")}</div>` : "")
      + (rev.summaryText ? `<div class="summary-detail">${mdLite(rev.summaryText)}</div>` : "");
  }
  // Pulse the Activity header while the run is live — the section is collapsed
  // in Zen, and a still header gave no hint there was anything to open.
  rev.els.sect?.classList.toggle("live", isActive(s));
  rev.els.summary.className = "card summary" + (cls ? " " + cls : "");
  rev.els.summary.innerHTML = html;
}

// Minimal markdown for the review body: bold, inline code, and bare URLs.
// Escapes FIRST, so everything below operates on inert text and no remote string
// can introduce markup. Deliberately not a full parser — just the three things
// Claude's review text actually uses.
function mdLite(text) {
  let h = escapeHtml(String(text));
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // Only http(s) links, and the href is the already-escaped text — no scheme
  // other than http/https can appear here.
  h = h.replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return h;
}

// Apply the remembered Activity state to a panel. Opening jumps to the newest
// events — the top of a 200-line log is the least interesting part of it.
function applyActivityState(rev) {
  const sect = rev.els?.sect;
  if (!sect) return;
  sect.classList.toggle("open", activityOpen);
  if (activityOpen) scrollLog(rev);
  else renderPeek(rev);
}
function setActivityOpen(open, rev) {
  activityOpen = !!open;
  localStorage.setItem(LS_ACTIVITY_OPEN, activityOpen ? "1" : "0");
  for (const r of reviews.values()) applyActivityState(r);
  if (rev && activityOpen) scrollLog(rev);
}

// Collapsed, the header still shows the last line of the log, so a running
// review says what it's doing without being expanded.
function renderPeek(rev) {
  const peek = rev.els?.peek;
  if (!peek) return;
  const last = rev.els?.log?.lastElementChild;
  const body = last?.querySelector(".ev-body");
  const text = (body?.textContent || last?.textContent || "").replace(/\s+/g, " ").trim();
  peek.textContent = text;
  peek.hidden = !text;
}

async function loadFinishedLog(rev) {
  rev.panelLoaded = true;
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(rev.id)}`);
    if (!r.ok) return;
    const job = await r.json();
    if (job.prMeta) rev.prMeta = job.prMeta;
    rev.state = job.state; rev.outcome = job.outcome || rev.outcome; rev.finished = true;
    if (job.summary?.finalText) rev.summaryText = job.summary.finalText;
    if (job.summary) rev.stats = {
      durationMs: job.summary.durationMs,
      numTurns: job.summary.numTurns,
      totalCostUsd: job.summary.totalCostUsd,
      usage: job.summary.usage,
    };
    if (job.createdAt) rev.createdAt = job.createdAt;
    if (job.finishedAt) rev.finishedAt = job.finishedAt;
    rev.provider = job.provider || rev.provider || "claude";
    rev.sessionId = job.sessionId || job.summary?.sessionId || rev.sessionId;
    rev.model = job.model || rev.model;
    rev.requestedBy = job.requestedBy || rev.requestedBy;
    rev.lastResumeRequestedBy = job.lastResumeRequestedBy || rev.lastResumeRequestedBy;
    for (const ev of job.events || []) { if (ev.kind === "phase") rev.phase = ev.phase; appendLog(rev, ev); }
    rev.els.count.textContent = `${rev.els.log.children.length} events`;
    renderHead(rev); renderStepper(rev); renderStats(rev); renderSummary(rev); renderLists();
    if (rev.id === selectedId) updateSubmitButton();
    // The session id only becomes known here, and the resume check needs it —
    // so this is the earliest point the check can run for a review restored
    // from disk (selectReview fires before the log is fetched).
    if (rev.id === selectedId && rev.state === "done" && rev.sessionId && !rev.resume) loadResumeCheck(rev);
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
  const es = new EventSource(`/api/jobs/${encodeURIComponent(rev.id)}/events`);
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
    // The CLI names the model it booted with on its init event. Kept per review,
    // not read off the topbar chip: an old review keeps the model that actually
    // read its diff even after the host changes their default.
    case "system": if (ev.model && ev.model !== rev.model) { rev.model = ev.model; renderStats(rev); } break;
    case "started": setState(rev, "running"); break;
    case "queued": setState(rev, "queued"); break;
    case "pr_meta": rev.prMeta = ev; renderHead(rev); renderStats(rev); renderLists(); break;
    case "outcome_detected":
      rev.outcome = ev.outcome;
      // A late outcome_detected can correct an earlier optimistic one — the
      // server reconciles what was posted against GitHub before finishing.
      if (typeof ev.verified === "boolean") rev.outcomeVerified = ev.verified;
      if (ev.detail) rev.outcomeDetail = ev.detail;
      renderHead(rev); renderSummary(rev); renderLists();
      break;
    case "summary":
      if (ev.finalText) rev.summaryText = ev.finalText;
      if (ev.sessionId) rev.sessionId = ev.sessionId;
      rev.stats = {
        durationMs: ev.durationMs,
        numTurns: ev.numTurns,
        totalCostUsd: ev.totalCostUsd,
        usage: ev.usage,
      };
      renderStats(rev); renderSummary(rev);
      break;
    case "skipped": rev.outcome = ev.outcome || "skipped"; rev.skipped = true; rev.skipReason = ev.reason; rev.skipMessage = ev.message || ""; finish(rev, "done"); break;
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
  if (rev.id === selectedId) { updateSubmitButton(); applyActivityState(rev); }
  if (first && !rev.notified && !rev.replaying) { rev.notified = true; notify(rev); playChime(statusMeta(rev).needsYou); }
  // A just-finished review has no PR state yet; ask now so Approve settles into
  // its final shape instead of appearing and then withdrawing. Only for a clean
  // finish, the same gate selectReview uses: a failed or interrupted run has no
  // Approve button to settle, and this probe costs a `gh` call on the host. A
  // skip still asks — it renders no button either, but "skipped: the PR is no
  // longer open" is worth the chip that says whether it was merged or closed.
  if (first && state === "done") loadPrState(rev);
  updateStatusLight();
  // A review just spent part of the plan — that's the moment the meter is worth
  // re-reading. Slightly delayed: the CLI writes its final limit state as the
  // process winds down.
  if (first && !rev.replaying) setTimeout(refreshUsage, 3000);
  // No refreshList here: the server broadcasts a fresh job-list snapshot over
  // the WebSocket on this same state change, so the list updates without a poll.
}

// --------------------------------------------------- delegated panel clicks -
panels.addEventListener("click", (e) => {
  const ap = e.target.closest(".approve");
  if (ap && ap.dataset.id && !ap.disabled) { openConfirm(ap.dataset.id); return; }
  const fr = e.target.closest(".resume.force");
  if (fr && fr.dataset.forceId && !fr.disabled) { verifyReview(fr.dataset.forceId, true); return; }
  const rs = e.target.closest(".resume");
  if (rs && rs.dataset.resumeId && !rs.disabled) { verifyReview(rs.dataset.resumeId, false); return; }
  const sh = e.target.closest(".sect-h");
  if (sh) {
    const panel = sh.closest(".review-panel");
    const rev = panel ? reviews.get(panel.dataset.jobId) : null;
    setActivityOpen(!sh.parentElement.classList.contains("open"), rev);
  }
});

// ------------------------------------------- approve: confirm, then password -
// Approving writes to somebody else's PR under the host's GitHub account, so it
// takes two deliberate steps, every time: confirm what is about to happen, then
// prove you're allowed to do it. Nothing survives the click — no unlocked
// browser, no cookie, no timer, nothing to leave armed behind you on a shared
// machine. The password travels with the approval it authorises and the field is
// cleared on the way out.

function openConfirm(id) {
  const rev = reviews.get(id);
  if (!rev) return;
  pendingApprove = id;
  const num = rev.prMeta?.number || prNumberFromUrl(rev.prUrl);
  const where = rev.prMeta?.nameWithOwner ? `${rev.prMeta.nameWithOwner}#${num}` : (num ? `PR #${num}` : "this PR");
  confirmSub.textContent = hostLogin
    ? `This posts an approving review on ${where} as @${hostLogin}. It shows up on GitHub straight away.`
    : `This posts an approving review on ${where} under this machine's GitHub login. It shows up on GitHub straight away.`;
  confirmOk.disabled = false;
  confirmOk.textContent = "Yes, approve";
  confirmBackdrop.hidden = false;
  setTimeout(() => confirmOk.focus(), 30);
}
// keep:true hands the pending id on to the password step; cancelling drops it.
function closeConfirm({ keep = false } = {}) {
  confirmBackdrop.hidden = true;
  if (!keep) pendingApprove = null;
}

function openPassword() {
  pwErr.hidden = true;
  pwInput.value = "";
  setPwVisible(false);
  pwSubmit.disabled = false;
  pwSubmit.textContent = "Approve PR";
  pwBackdrop.hidden = false;
  setTimeout(() => pwInput.focus(), 30);
}
function closePassword() {
  pwBackdrop.hidden = true;
  pwInput.value = ""; // don't leave the secret sitting in the DOM
  pendingApprove = null;
}
// A refusal keeps the dialog open: the password is the thing that failed, so the
// message belongs beside the field you'd retype, not in a toast over the page.
function pwFail(message) {
  pwErr.textContent = message;
  pwErr.hidden = false;
  pwForm.classList.remove("shake"); void pwForm.offsetWidth; pwForm.classList.add("shake");
  pwInput.select();
}
function setPwVisible(show) {
  pwInput.type = show ? "text" : "password";
  if (!pwEye) return;
  pwEye.classList.toggle("showing", show);
  pwEye.title = show ? "Hide password" : "Show password";
}

async function approveReview(id, password) {
  const rev = reviews.get(id);
  if (!rev) return;
  pwErr.hidden = true;
  pwSubmit.disabled = true;
  pwSubmit.textContent = "Approving…";
  try {
    // The server checks the password and runs `gh pr review --approve` under the
    // host's own gh login. Nothing is remembered on either side afterwards.
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Wrong password, or too many tries — both are answers about the password,
      // and the server words them (it says the same thing whether the guess was
      // wrong or the host never set one). Stay put so it can be retyped.
      if (r.status === 401 || r.status === 429) {
        pwFail(data.error || "Not authorized.");
        return;
      }
      // Anything else is about the PR, not the password.
      closePassword();
      showToast("Couldn't approve: " + escapeHtml(data.error || `HTTP ${r.status}`));
      // GitHub refusing an approval usually means the PR moved under us — merged,
      // closed, or approved by someone else. Re-ask, so the button and the chip
      // settle on the truth instead of inviting another failing click.
      loadPrState(rev, { force: true });
      renderHead(rev);
      return;
    }
    closePassword();
    rev.outcome = "approved";
    renderHead(rev); renderSummary(rev); renderLists();
    showToast("✓ Approved on GitHub.");
  } catch (e) {
    pwFail("Couldn't reach the server.");
  } finally {
    pwSubmit.disabled = false;
    pwSubmit.textContent = "Approve PR";
  }
}

if (confirmOk) confirmOk.addEventListener("click", () => {
  const id = pendingApprove;
  closeConfirm({ keep: true });
  if (id) openPassword(); else closePassword();
});
if (confirmCancel) confirmCancel.addEventListener("click", () => closeConfirm());
if (confirmBackdrop) confirmBackdrop.addEventListener("click", (e) => { if (e.target === confirmBackdrop) closeConfirm(); });

if (pwForm) pwForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = pendingApprove;
  if (!id) { closePassword(); return; }
  if (!pwInput.value) { pwFail("Enter the password."); return; }
  approveReview(id, pwInput.value);
});
if (pwCancel) pwCancel.addEventListener("click", closePassword);
if (pwBackdrop) pwBackdrop.addEventListener("click", (e) => { if (e.target === pwBackdrop) closePassword(); });
if (pwEye) pwEye.addEventListener("click", () => { setPwVisible(pwInput.type === "password"); pwInput.focus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Innermost first: the password step sits on top of the confirmation.
  if (pwBackdrop && !pwBackdrop.hidden) { closePassword(); return; }
  if (confirmBackdrop && !confirmBackdrop.hidden) { closeConfirm(); return; }
});

// ----------------------------------------------------------- active model ---
// The provider's current model decides how sharp the reviews come back, so it
// belongs next to the plan meter when the provider can report it. Each finished
// job separately keeps the concrete model that ran its review.
let modelData = null;

async function refreshModel() {
  const provider = selectedProvider();
  try {
    const r = await fetch(`/api/model?provider=${encodeURIComponent(provider)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (provider !== selectedProvider()) return;
    modelData = data;
  } catch {
    if (provider !== selectedProvider()) return;
    // A failed poll must not wipe a known name off the screen — only the very
    // first one has nothing better to fall back to.
    if (!modelData) modelData = { ok: false, reason: "unavailable" };
  }
  renderModel();
}

// "Opus 5 (1M context)" → the name, and the variant the chip dims. Split so the
// model's identity stays readable when the topbar is tight.
function splitModelName(name) {
  const m = String(name).match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { main: m[1], note: m[2] } : { main: String(name), note: "" };
}

function renderModel() {
  if (!modelChip) return;
  const d = modelData;
  // No reading yet, or none to be had: show nothing rather than a guess or a
  // placeholder. "which model" has no useful half-answer, and the host finds
  // the reason for a failed reading in the server log.
  if (!d || !d.ok || !d.name) { modelChip.hidden = true; return; }
  const { main, note } = splitModelName(d.name);
  modelChip.hidden = false;
  modelChip.className = "modelchip" + (d.stale ? " stale" : "");
  modelChip.innerHTML =
    svgIcon("chip") +
    `<span>${escapeHtml(main)}</span>` +
    (note ? `<span class="model-note">${escapeHtml(note)}</span>` : "");
  modelChip.title =
    `Reviews on this host run on ${d.name}${d.isDefault ? ", the provider CLI's default" : ""}. ` +
    (d.stale ? "Couldn't re-read it just now, so this is the last known setting. " : "") +
    "Change it in the provider CLI on the host machine, not from this page.";
}

// ------------------------------------------------------------- plan usage ---
// prsnooze spends one person's Claude subscription, and anyone who can open this
// page can spend it. So the meter is public: the chip carries whichever window
// is closest to its limit — that's the one that will stop the next review — and
// the popover breaks out every window with what's left and when it resets.
let usageData = null;
let usageFetchedAt = 0;
// Slow on purpose. Only a finished review moves these numbers meaningfully, and
// each reading costs ~5s of CLI boot on the host, so the interval is a floor;
// the real refreshes are triggered by events below.
const USAGE_POLL_MS = 180_000;

async function refreshUsage() {
  const provider = selectedProvider();
  try {
    const r = await fetch(`/api/usage?provider=${encodeURIComponent(provider)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (provider !== selectedProvider()) return;
    usageData = data;
  } catch {
    if (provider !== selectedProvider()) return;
    // A failed poll must not wipe a good number off the screen — only the very
    // first one has nothing better to fall back to.
    if (!usageData) usageData = { ok: false, reason: "unavailable" };
  }
  usageFetchedAt = Date.now();
  renderUsage();
}

// Left, not used, decides the colour: 80% used is only alarming because 20% is
// what remains.
function usageTone(leftPct) { return leftPct <= 10 ? "crit" : leftPct <= 25 ? "warn" : "ok"; }
function fmtPct(n) { return String(Number(Number(n).toFixed(1))); }
function fmtNum(n) { return Number(n).toLocaleString(); }
// "Current session" is the 5-hour window, everything else is weekly.
function usageWindowShort(w) { return w.id.startsWith("session") ? "session" : "week"; }
function usageReasonText(reason) {
  switch (reason) {
    case "not-a-subscription": return "No plan limits to report — this host's claude CLI isn't on a subscription (API key, or not logged in).";
    case "no-limits-reported": return "The claude CLI didn't report any limit windows.";
    default: return "Couldn't read usage from the claude CLI on this host — see the prsnooze server log.";
  }
}

function renderUsage() {
  if (!usageChip) return;
  const d = usageData;
  // Nothing has come back yet. The host's CLI takes a few seconds to boot, and
  // "unknown" during those seconds reads as a failure — so say we're looking.
  if (!d) {
    usageChip.hidden = false;
    usageChip.className = "usagechip loading";
    usageChip.title = "Reading how much of the host's Claude plan is left…";
    usageFill.style.width = "";
    usageChipText.textContent = "reading usage…";
    usagePop.hidden = true;
    usageChip.setAttribute("aria-expanded", "false");
    return;
  }
  if (!d.ok || !Array.isArray(d.windows) || !d.windows.length) {
    if (d.reason === "unsupported-by-provider") {
      usageChip.hidden = true;
      usagePop.hidden = true;
      return;
    }
    // Nothing worth telling teammates — but the host is the only one who can
    // fix a broken reading, so they get a muted chip instead of silence.
    usageChip.hidden = !isHost;
    usagePop.hidden = true;
    usageChip.setAttribute("aria-expanded", "false");
    if (isHost) {
      usageChip.className = "usagechip unknown";
      usageFill.style.width = "0%";
      usageChipText.textContent = "usage unknown";
      usageChip.title = usageReasonText(d?.reason);
    }
    return;
  }
  const tight = d.windows.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  usageChip.hidden = false;
  usageChip.className = `usagechip ${usageTone(tight.leftPct)}${d.stale ? " stale" : ""}`;
  usageFill.style.width = `${Math.min(100, Math.max(0, tight.usedPct))}%`;
  usageChipText.innerHTML =
    `${fmtPct(tight.leftPct)}% left <span class="usage-chip-win">${escapeHtml(usageWindowShort(tight))}</span>`;
  usageChip.title =
    d.windows
      .map((w) => `${w.label}: ${fmtPct(w.usedPct)}% used, ${fmtPct(w.leftPct)}% left${w.resets ? ` · resets ${w.resets}` : ""}`)
      .join("\n") + "\n\nClick for details";
  renderUsagePop(d, tight);
}

function renderUsagePop(d, tight) {
  usageRows.innerHTML = d.windows
    .map(
      (w) => `<div class="usage-row ${usageTone(w.leftPct)}${w.id === tight.id ? " tight" : ""}">
        <div class="usage-row-top">
          <span class="usage-row-label">${escapeHtml(w.label)}</span>
          <span class="usage-row-num"><b>${fmtPct(w.leftPct)}% left</b> · ${fmtPct(w.usedPct)}% used</span>
        </div>
        <span class="usage-bar"><i style="width:${Math.min(100, Math.max(0, w.usedPct))}%"></i></span>
        ${w.resets ? `<div class="usage-row-reset">resets ${escapeHtml(w.resetsShort || w.resets)}${w.zone ? ` <span class="usage-zone">${escapeHtml(w.zone)}</span>` : ""}</div>` : ""}
      </div>`,
    )
    .join("");
  renderUsageMonth(d.month);
  const a = d.activity || {};
  const seen = [];
  if (a["24h"]) seen.push(`${fmtNum(a["24h"].requests)} requests in 24h`);
  if (a["7d"]) seen.push(`${fmtNum(a["7d"].requests)} in 7d`);
  const who = hostLogin ? `@${hostLogin}` : hostName || "the host";
  usageFoot.innerHTML =
    (seen.length ? `<div>${escapeHtml(seen.join(" · "))}</div>` : "") +
    `<div>${escapeHtml(who)}'s plan${d.stale ? " · last known reading" : ""}${d.fetchedAt ? ` · read ${escapeHtml(relTime(d.fetchedAt))}` : ""}</div>` +
    `<div class="usage-note">Reviews fail until the window with the least left resets. Counted from sessions on the host machine.</div>`;
}

// Month-to-date, which is a total rather than a limit: Claude's plan resets by
// session and by week, so there is no monthly tank to be 40% into. What people
// actually want to know is how much of the host's plan this page has eaten.
function renderUsageMonth(m) {
  if (!usageMonth) return;
  if (!m || typeof m.reviews !== "number") { usageMonth.hidden = true; return; }
  const month = new Date(m.since).toLocaleString(undefined, { month: "long" });
  const bits = [`${fmtNum(m.reviews)} review${m.reviews === 1 ? "" : "s"}`];
  if (m.costUsd > 0) bits.push(`≈$${m.costUsd.toFixed(2)} at API rates`);
  usageMonth.hidden = false;
  usageMonth.innerHTML =
    `<div class="usage-month-h">${escapeHtml(month)} so far</div>` +
    `<div class="usage-month-v">${escapeHtml(bits.join(" · "))}</div>` +
    `<div class="usage-month-n">Run through prsnooze since the 1st. The limits above are what actually run out — this is just the running total.</div>`;
}

function closeUsagePop() {
  if (!usagePop || usagePop.hidden) return;
  usagePop.hidden = true;
  usageChip.setAttribute("aria-expanded", "false");
}
if (usageChip) {
  usageChip.addEventListener("click", () => {
    // Nothing to break out when there's no reading — the chip's own tooltip
    // carries the reason, so don't open an empty panel over it. Re-ask instead,
    // in case whatever was wrong on the host has since been fixed.
    if (!usageData?.ok) { refreshUsage(); return; }
    const opening = usagePop.hidden;
    usagePop.hidden = !opening;
    usageChip.setAttribute("aria-expanded", String(opening));
    // Opening it is someone asking "how much is left, right now".
    if (opening) refreshUsage();
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest("#usage")) closeUsagePop(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUsagePop(); });

async function verifyReview(id, force = false) {
  const rev = reviews.get(id);
  if (!rev) return;
  showToast("Resuming the review — picking up the original session…");
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: !!force }),
    });
    const data = await r.json();
    if (!r.ok) {
      // 409 means the server judged the resume pointless (merged, approved,
      // nothing new). Show why and arm an explicit override rather than just
      // refusing — the user may know something GitHub doesn't.
      if (r.status === 409 && data.assessment) {
        rev.resume = data.assessment;
        // Force always becomes visible after a refusal — but it renders disabled
        // when forcing can't change the answer, so the UI shows the option and
        // why it isn't available rather than hiding it.
        rev.resumeArmed = true;
        rev.resumeForcible = data.forcible !== false;
        renderHead(rev);
        showToast(escapeHtml(data.assessment.reason) + (data.forcible === false ? "" : " Use Force resume to run it anyway."));
        return;
      }
      showToast("Couldn't resume: " + escapeHtml(data.error || "error"));
      return;
    }
    rev.resumeArmed = false;
    rev.resume = null;
    // Reset so the resumed run streams live in place.
    if (rev.es) { try { rev.es.close(); } catch {} rev.es = null; }
    rev.finished = false; rev.state = "running"; rev.outcome = null;
    // The PR state has to be re-asked too, or finish() finds prStateChecked
    // still set and skips its probe — and a review resumed hours later would
    // draw its Approve button from hours-old state, with the outcome that
    // suppressed it nulled out just above.
    rev.prStateChecked = false;
    ensurePanel(rev); openStream(rev); selectReview(id); renderLists();
  } catch (e) { showToast("Couldn't resume: " + escapeHtml(e.message)); }
}

// Ask the server for the PR's current state. Drives two things: whether Approve
// is drawn at all, and the merged/closed chip. Re-asked at most once per review
// unless something invalidates it (an approve attempt that GitHub refused).
async function loadPrState(rev, { force = false } = {}) {
  if (!rev || rev.prStateLoading) return;
  if (rev.prStateChecked && !force) return;
  rev.prStateLoading = true;
  try {
    // force means "what you told me turned out to be wrong", so it has to get
    // past the server's own 30s cache as well as the prStateChecked guard above
    // — otherwise a refused approval is handed back the state it just disproved.
    const r = await fetch(`/api/jobs/${encodeURIComponent(rev.id)}/pr-state${force ? "?refresh=1" : ""}`);
    const data = r.ok ? await r.json() : { ok: false };
    rev.prStateOk = !!data.ok;
    rev.prState = String(data.state || "").toUpperCase() || null;
    rev.prApproved = !!data.approved;
  } catch {
    rev.prStateOk = false;
    rev.prState = null;
    rev.prApproved = false;
  } finally {
    rev.prStateLoading = false;
    rev.prStateChecked = true;
    renderHead(rev);
    renderLists();
  }
}

// Ask the server whether resuming this review is worth it. Read-only, and its
// answer is what the Resume button renders — so the button can say "the author
// pushed 2 commits and replied to 3 comments" instead of just being clickable.
async function loadResumeCheck(rev) {
  if (!rev || rev.resumeLoading) return;
  rev.resumeLoading = true;
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(rev.id)}/resume-check`);
    if (r.ok) rev.resume = await r.json();
  } catch {
    rev.resume = null;
  } finally {
    rev.resumeLoading = false;
    renderHead(rev);
  }
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
    case "agent_started": return { cat: "meta", icon: "▶", label: ev.provider || "agent", body: `pid ${ev.pid ?? "?"}` };
    case "claude_started": return { cat: "meta", icon: "▶", label: "claude", body: `pid ${ev.pid ?? "?"}` };
    case "phase": return { cat: "phase", icon: "▸", label: "phase", body: `<strong>${escapeHtml(ev.phase || "")}</strong>` };
    case "verify_restart": return { cat: "divider", icon: "↻", label: "", body: `<strong>${escapeHtml(ev.message || "Verify fixes — re-checking")}</strong>` };
    case "caught_up": return null;
    case "log": return { cat: "info", icon: "·", label: "log", body: escapeHtml(ev.message || "") };
    case "pr_meta": return { cat: "pr", icon: "🔗", label: "PR", body: `<strong>${escapeHtml(ev.nameWithOwner || "")} #${ev.number}</strong> — ${escapeHtml(ev.title || "")}` };
    case "worktree_ready": {
      // Which commit is being reviewed, not just where: the PR head normally,
      // the base branch when its head couldn't be fetched.
      const at = ev.sha ? `${ev.sha.slice(0, 7)}${ev.atPrHead ? " (PR head)" : " (base)"}` : "";
      return { cat: "info", icon: "📁", label: "worktree", body: `<span class="dim">${escapeHtml(ev.path || "")}${at ? ` @ ${escapeHtml(at)}` : ""}</span>` };
    }
    case "interrupted": return { cat: "warn", icon: "⏸", label: "interrupted", body: escapeHtml(ev.message || "interrupted") };
    case "skill_resolved": { const tag = ev.source === "project" ? "project" : ev.source === "user" ? "user" : ev.source === "bundled" ? "bundled" : ""; return { cat: "ok", icon: "🧩", label: "skill", body: `<strong>${escapeHtml(ev.name || "")}</strong> <span class="tag">${escapeHtml(tag)}</span> <span class="dim">${escapeHtml(ev.pathDisplay || ev.path || "")}</span>` }; }
    case "skill_missing": return { cat: "warn", icon: "🧩", label: "skill", body: `<strong>no project skill</strong> — generic review ${details("paths searched", (ev.attempted || []).join("\n"))}` };
    case "approval_policy": { const v = ev.autoApprove ? "eligible" : "disabled"; const mt = Array.isArray(ev.matchedTests) && ev.matchedTests.length > 0 ? ` <span class="tag">matched tests: ${ev.matchedTests.length}</span>` : ""; return { cat: "pr", icon: "🛂", label: "approval", body: `<strong>${escapeHtml(v)}</strong> <span class="dim">${escapeHtml(ev.reason || "")}</span>${mt}` }; }
    case "rubric": { const tier = ev.score <= 20 ? "approve" : ev.score > 60 ? "high-risk" : "comment"; const hits = Array.isArray(ev.hits) && ev.hits.length ? ` hits=[${ev.hits.map(escapeHtml).join(",")}]` : ""; const reds = Array.isArray(ev.reducers) && ev.reducers.length ? ` reducers=[${ev.reducers.map(escapeHtml).join(",")}]` : ""; return { cat: "pr", icon: "📊", label: "rubric", body: `<strong>${escapeHtml(tier)}</strong> <span class="dim">score=${ev.score}${hits}${reds}</span>` }; }
    case "outcome_detected": return { cat: "ok", icon: "🏁", label: "outcome", body: `<strong>${escapeHtml(outcomeLabel(ev.outcome))}</strong>` };
    case "skipped": return { cat: "warn", icon: "↪", label: "skipped", body: `<strong>${escapeHtml(ev.message || skipReasonText(ev.reason))}</strong>${ev.detail ? ` <span class="dim">${escapeHtml(ev.detail)}</span>` : ""}` };
    case "system": return { cat: "sys", icon: "•", label: "session", body: `<span class="dim">${(ev.sessionId || "").slice(0, 8)}${ev.model ? " · " + escapeHtml(ev.model) : ""}</span>` };
    case "assistant_text": return { cat: "think", icon: "💭", label: "", body: escapeHtml(ev.text || "") };
    case "tool_use": { const tool = ev.tool || "tool"; const cmd = ev.summary || ""; const title = friendlyTitle(tool, cmd); let body = title ? `<span class="ev-title">${escapeHtml(title)}</span> <span class="arg">${escapeHtml(cmd)}</span>` : `<strong>${escapeHtml(tool)}</strong> <span class="arg">${escapeHtml(cmd)}</span>`; if (ev.full) body += " " + details("input", JSON.stringify(ev.full, null, 2)); return { cat: "tool", icon: TOOL_ICONS[tool] || "🔧", label: "", body }; }
    case "tool_result": { const size = humanSize(ev.length); const preview = (ev.preview || "").trim(); const first = preview.split("\n")[0].slice(0, 100); const body = `<span class="dim">${size}</span>` + (first ? ` <span class="arg">${escapeHtml(first)}</span>` : "") + (preview ? " " + details("output", preview, ev.isError) : ""); return { cat: ev.isError ? "err" : "result", icon: ev.isError ? "✗" : "✓", label: "", body }; }
    case "result": return { cat: ev.isError ? "err" : "ok", icon: ev.isError ? "⚠️" : "✅", label: "result", body: `${ev.isError ? "error" : "ok"}${Number.isFinite(ev.numTurns) ? ` · turns ${ev.numTurns}` : ""}` };
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
  // Follow the tail only when already pinned to the bottom, so reading back
  // through history isn't yanked away by new events.
  const body = rev.els?.body;
  const pinned = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  if (pinned) scrollLog(rev);
  if (!activityOpen) renderPeek(rev);
}
// The log scrolls inside its own box — the panel itself no longer scrolls, so a
// 200-event review can't turn the whole page into one enormous scrollbar.
function scrollLog(rev) {
  const body = rev.els?.body;
  if (!body || rev.id !== selectedId) return;
  body.scrollTop = body.scrollHeight;
}

// ------------------------------------------------------------ status light --
// One place that maps a review's state to how it looks. `ico` names an SVG for
// the UI; `icon` stays an emoji because it's used in OS notification titles,
// where SVG isn't an option.
function statusMeta(rev) {
  const s = rev.state, o = rev.outcome;
  if (s === "running") return { ico: "play", icon: "●", cls: "running", running: true };
  if (s === "queued") return { ico: "clock", icon: "○", cls: "queued", running: true };
  if (s === "failed") return { ico: "xcircle", icon: "✗", cls: "failed", needsYou: true };
  if (s === "interrupted") return { ico: "pause", icon: "⏸", cls: "interrupted" };
  switch (o) {
    case "approved": return { ico: "check", icon: "✓", cls: "approved" };
    case "commented": return { ico: "comment", icon: "💬", cls: "commented" };
    case "changes_requested": return { ico: "alert", icon: "⚠", cls: "changes", needsYou: true };
    case "no_new_findings": return { ico: "circle", icon: "○", cls: "nonew" };
    case "skipped": return { ico: "skip", icon: "↪", cls: "skipped" };
    default: return { ico: "check", icon: "✓", cls: "done" };
  }
}
function brandFavicon(variant) {
  const eyes = variant === "idle"
    ? `<path d="M14 33 q9 10 18 0" fill="none" stroke="#eaeefb" stroke-width="4" stroke-linecap="round"/><path d="M33 33 q9 10 18 0" fill="none" stroke="#eaeefb" stroke-width="4" stroke-linecap="round"/>`
    : `<ellipse cx="24" cy="34" rx="9" ry="11" fill="#eaeefb"/><circle cx="24" cy="36" r="4.6" fill="#0d1020"/><ellipse cx="42" cy="34" rx="9" ry="11" fill="#eaeefb"/><circle cx="42" cy="36" r="4.6" fill="#0d1020"/>`;
  const zzz = variant === "idle" ? `<text x="39" y="21" font-family="Arial,sans-serif" font-size="17" font-weight="bold" fill="#ffb457">z</text>` : "";
  const dot = variant === "needs" ? `<circle cx="52" cy="12" r="7" fill="#ff6b81"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#171c33"/>${eyes}${zzz}${dot}</svg>`;
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
// Turning it on asks the browser for notification permission, so the one control
// covers both halves of "tell me when it's done". A refusal isn't fatal — the
// chime still works — and the tooltip says so instead of leaving a dead glyph on
// screen reporting permission state nobody asked about.
function requestNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") Notification.requestPermission().then(renderNotifyToggle);
}
function renderNotifyToggle() {
  notifyToggle.classList.toggle("on", notifyOn);
  notifyToggle.setAttribute("aria-pressed", String(notifyOn));
  const blocked = "Notification" in window && Notification.permission === "denied";
  notifyToggle.setAttribute(
    "aria-label",
    notifyOn ? "Notifications on — click to turn off" : "Notifications off — click to turn on",
  );
  notifyToggle.title = !notifyOn
    ? "Off — no chime or notification when a review finishes"
    : blocked
      ? "On — chime only; this browser has blocked desktop notifications"
      : "On — chime and a desktop notification when a review finishes";
}
function notify(rev) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const m = statusMeta(rev);
  const name = rev.prMeta ? `${rev.prMeta.nameWithOwner} #${rev.prMeta.number}` : rev.prUrl || "review";
  try { new Notification(`${m.icon} ${name}`, { body: outcomeLabel(rev.outcome) || rev.state, tag: rev.id }); } catch {}
}
let audioCtx = null;
function playChime(needsYou) {
  if (!notifyOn) return;
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
notifyToggle.addEventListener("click", () => {
  notifyOn = !notifyOn;
  localStorage.setItem(LS_NOTIFY, notifyOn ? "1" : "0");
  if (notifyOn) requestNotifPermission();
  renderNotifyToggle();
});

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
    // A shared link picks the review. Note where this value ends up: the id goes
    // into the path of every per-job request, so it is only ever used after
    // reviews.has() confirms the server actually sent us that job, and it's
    // percent-encoded at each of those call sites. Neither alone is enough —
    // a link is something someone else can hand you.
    const fromHash = decodeURIComponent(location.hash.replace(/^#/, ""));
    const saved = fromHash || localStorage.getItem(LS_SELECTED);
    if (saved && reviews.has(saved)) selectReview(saved);
  }
  emptyState.hidden = selectedId != null;
  placeComposer();
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
// A skip is a normal ending, so it needs a sentence a human wrote, not the
// machine slug the event carries for logic. `message` is the server's wording;
// these are the fallbacks for older events that only have a reason.
function skipReasonText(reason) {
  switch (reason) {
    case "pr_not_open": return "Nothing to review: the PR is no longer open.";
    case "already_reviewed_by_self": return "Already reviewed this exact commit, so nothing to redo.";
    default: return "Skipped.";
  }
}
function skipText(rev) {
  return rev.skipMessage || skipReasonText(rev.skipReason);
}
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
    defaultProvider = cfg.defaultProvider || "claude";
    const providerOptions = Array.isArray(cfg.providers) ? cfg.providers : [];
    if (providerSelect) {
      providerSelect.replaceChildren(...providerOptions.map((provider) => {
        const option = document.createElement("option");
        option.value = provider.id;
        option.textContent = provider.label;
        return option;
      }));
      if (providerOptions.some((provider) => provider.id === defaultProvider)) {
        providerSelect.value = defaultProvider;
      }
      providerPick.hidden = providerOptions.length < 2;
    }
    if (cfg.host) {
      hostName = cfg.host;
      hostNameEl.textContent = `on ${hostName}'s machine`;
      if (heroHost) heroHost.textContent = cfg.hostLogin ? ` as @${cfg.hostLogin}` : ` as ${hostName}`;
    }
    // The usage chip names the host and has a host-only fallback state, so it
    // can only render properly once the config has landed.
    renderUsage();
    refreshUsage();
    refreshModel();
    for (const r2 of reviews.values()) if (r2.els?.head) renderHead(r2);
    updateStatusLight();
  } catch {}
}
function stampLastSeen() { localStorage.setItem(LS_LASTSEEN, String(Date.now())); }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stampLastSeen();
  // Coming back to a tab that sat idle: the meter on screen is as old as the tab
  // has been away, so re-read it rather than waiting out the interval.
  else if (Date.now() - usageFetchedAt > USAGE_POLL_MS) refreshUsage();
});
window.addEventListener("beforeunload", stampLastSeen);

// ------------------------------------------------------------------- init ---
placeComposer();  // before the first paint, so the composer never flashes in the wrong slot
renderNotifyToggle();
updateStatusLight();
loadConfig();
refreshList();   // instant first paint (one-shot fetch, not a poll)
connectLive();   // recurring updates via WebSocket — replaces the 5s poll
// Keep relative timestamps ("2m ago") ticking. Local re-render only — no network.
setInterval(() => renderLists(), 60000);
// A floor under the plan meter. Reviews finishing and opening the popover are
// what actually keep it current; this only catches a tab left open all day.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  refreshUsage();
  // Rides along with the meter. The server holds a model reading far longer
  // than the usage one, so most of these are answered from its cache and only
  // occasionally cost a CLI boot — enough to notice the host switching models.
  refreshModel();
}, USAGE_POLL_MS);
