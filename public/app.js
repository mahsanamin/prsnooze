"use strict";

const $ = (id) => document.getElementById(id);

const form = $("submit-form");
const input = $("pr-url");
const submitBtn = $("submit-btn");
const submitMsg = $("submit-msg");
const queueStatusEl = $("queue-status");
const recentList = $("recent-list");
const tabsSection = $("tabs-section");
const tabBar = $("tab-bar");
const tabPanels = $("tab-panels");
const faviconEl = $("favicon");
const soundToggle = $("sound-toggle");
const notifHint = $("notif-hint");
const welcomeBanner = $("welcome-banner");
const welcomeText = $("welcome-text");
const welcomeDismiss = $("welcome-dismiss");

const LS_TABS = "prsnooze:tabs";
const LS_SOUND = "prsnooze:sound";
const LS_LASTSEEN = "prsnooze:lastSeen";

// jobId -> tab object
const tabs = new Map();
let activeTabId = null;
let welcomeShown = false;

// ---------------------------------------------------------------- submit ----

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await submitUrls(input.value);
});

// Enter submits; Shift+Enter inserts a newline (for hand-typing several).
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

async function submitUrls(raw) {
  const urls = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return;

  // Asking here keeps it inside the click gesture, so the browser allows it.
  requestNotifPermission();

  submitBtn.disabled = true;
  submitMsg.textContent = urls.length > 1 ? `submitting ${urls.length}…` : "submitting…";
  submitMsg.classList.remove("error");

  let firstNewId = null;
  const errors = [];
  for (const prUrl of urls) {
    try {
      const r = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl }),
      });
      const data = await r.json();
      if (!r.ok) {
        errors.push(`${prUrl}: ${data.error || `HTTP ${r.status}`}`);
        continue;
      }
      const tab = createTab(data.jobId, data.prUrl, { activate: false });
      openStream(tab);
      if (!firstNewId) firstNewId = data.jobId;
    } catch (err) {
      errors.push(`${prUrl}: ${err.message}`);
    }
  }

  if (firstNewId) activateTab(firstNewId);
  input.value = "";
  submitBtn.disabled = false;

  if (errors.length) {
    submitMsg.textContent = errors.join(" · ");
    submitMsg.classList.add("error");
  } else {
    submitMsg.textContent =
      urls.length > 1 ? `Queued ${urls.length} reviews.` : "Queued.";
  }
  refreshRecent();
}

// ------------------------------------------------------------------ tabs ----

// prNumberFromUrl("https://github.com/o/r/pull/123") -> "123"
function prNumberFromUrl(url) {
  const m = /\/pull\/(\d+)/.exec(url || "");
  return m ? m[1] : null;
}

function createTab(jobId, prUrl, { activate = true, persist = true } = {}) {
  if (tabs.has(jobId)) {
    if (activate) activateTab(jobId);
    return tabs.get(jobId);
  }

  const tabEl = document.createElement("button");
  tabEl.className = "tab";
  tabEl.dataset.jobId = jobId;

  const dot = document.createElement("span");
  dot.className = "tab-dot";
  const label = document.createElement("span");
  label.className = "tab-label";
  const num = prNumberFromUrl(prUrl);
  label.textContent = num ? `#${num}` : `job ${jobId.slice(0, 4)}`;
  const closeBtn = document.createElement("span");
  closeBtn.className = "tab-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close tab";

  tabEl.append(dot, label, closeBtn);
  tabEl.addEventListener("click", (e) => {
    if (e.target === closeBtn) {
      e.stopPropagation();
      closeTab(jobId);
    } else {
      activateTab(jobId);
    }
  });
  tabBar.appendChild(tabEl);

  const panel = document.createElement("div");
  panel.className = "tab-panel";
  panel.dataset.jobId = jobId;
  const head = document.createElement("div");
  head.className = "active-head";
  const title = document.createElement("h2");
  title.textContent = num ? `PR #${num}` : `Review ${jobId.slice(0, 8)}`;
  const stateBadge = document.createElement("span");
  stateBadge.className = "badge queued";
  stateBadge.textContent = "queued";
  head.append(title, stateBadge);
  const meta = document.createElement("div");
  meta.className = "active-meta";
  const log = document.createElement("ol");
  log.className = "log";
  panel.append(head, meta, log);
  tabPanels.appendChild(panel);

  const tab = {
    id: jobId,
    prUrl,
    prMeta: null,
    state: "queued",
    outcome: null,
    finished: false,
    notified: false,
    finishedAt: null,
    es: null,
    els: { tab: tabEl, dot, label, panel, head, title, stateBadge, meta, log },
  };
  tabs.set(jobId, tab);
  tabsSection.hidden = false;
  setTabState(tab, "queued");

  if (persist) persistTabs();
  if (activate) activateTab(jobId);
  return tab;
}

function activateTab(jobId) {
  activeTabId = jobId;
  for (const [id, tab] of tabs) {
    const on = id === jobId;
    tab.els.tab.classList.toggle("active", on);
    tab.els.panel.classList.toggle("active", on);
  }
}

function closeTab(jobId) {
  const tab = tabs.get(jobId);
  if (!tab) return;
  if (tab.es) {
    try {
      tab.es.close();
    } catch {}
  }
  tab.els.tab.remove();
  tab.els.panel.remove();
  tabs.delete(jobId);
  persistTabs();
  if (activeTabId === jobId) {
    const next = Array.from(tabs.keys()).pop();
    if (next) activateTab(next);
    else activeTabId = null;
  }
  if (tabs.size === 0) tabsSection.hidden = true;
  updateStatusLight();
}

// --------------------------------------------------------------- streams ----

function openStream(tab) {
  if (tab.es) {
    try {
      tab.es.close();
    } catch {}
  }
  tab.els.log.innerHTML = ""; // server replays buffered events on connect
  const es = new EventSource(`/api/jobs/${tab.id}/events`);
  tab.es = es;
  es.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    handleEvent(tab, ev);
  };
  es.onerror = () => {
    // Stream closes on completion; that's expected. Nudge the recent list.
    refreshRecent();
  };
}

function handleEvent(tab, ev) {
  appendLog(tab, ev);
  switch (ev.kind) {
    case "phase":
      setTabState(tab, "running", ev.phase);
      break;
    case "started":
      setTabState(tab, "running");
      break;
    case "queued":
      setTabState(tab, "queued");
      break;
    case "pr_meta":
      renderPrMeta(tab, ev);
      break;
    case "outcome_detected":
      tab.outcome = ev.outcome;
      setTabState(tab, tab.state === "queued" ? "running" : tab.state, null, ev.outcome);
      break;
    case "summary":
      renderSummary(tab, ev);
      break;
    case "skipped":
      tab.outcome = ev.outcome || "skipped";
      finish(tab, "done", `skipped (${ev.reason})`);
      break;
    case "done":
      finish(tab, "done");
      break;
    case "failed":
      finish(tab, "failed");
      break;
    case "interrupted":
      setTabState(tab, "interrupted");
      break;
    case "stream_end":
      if (!tab.finished) finish(tab, ev.state || tab.state);
      break;
  }
}

function finish(tab, state, phaseText) {
  const first = !tab.finished;
  tab.finished = true;
  tab.state = state;
  if (!tab.finishedAt) tab.finishedAt = Date.now();
  setTabState(tab, state, phaseText || null, tab.outcome);
  if (first && !tab.notified) {
    tab.notified = true;
    notify(tab);
    playChime(statusMeta(tab).needsYou);
  }
  updateStatusLight();
  refreshRecent();
}

// -------------------------------------------------------------- rendering ---

// Map a tab's state+outcome to an icon, css class, and whether it's
// active (counts toward the running total) or needs your attention.
function statusMeta(tab) {
  const s = tab.state;
  const o = tab.outcome;
  if (s === "running") return { icon: "🔵", cls: "running", running: true };
  if (s === "queued") return { icon: "⏳", cls: "queued", running: true };
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

function setTabState(tab, state, phase, outcome) {
  tab.state = state;
  if (outcome !== undefined && outcome !== null) tab.outcome = outcome;
  const m = statusMeta(tab);

  // Tab pill
  tab.els.dot.textContent = m.icon;
  tab.els.tab.className = `tab tab-${m.cls}${tab.els.tab.classList.contains("active") ? " active" : ""}`;
  const num = prNumberFromUrl(tab.prUrl);
  const repo = tab.prMeta?.nameWithOwner ? ` — ${tab.prMeta.nameWithOwner}` : "";
  tab.els.tab.title = `${num ? "#" + num : tab.id.slice(0, 8)}${repo} · ${state}${tab.outcome ? " · " + outcomeLabel(tab.outcome) : ""}`;

  // Panel state badge
  let text = state;
  if (phase) text = `${state} · ${phase}`;
  if (tab.outcome) text = `${text} · ${outcomeLabel(tab.outcome)}`;
  tab.els.stateBadge.textContent = text;
  tab.els.stateBadge.className = `badge ${state}`;

  updateStatusLight();
}

function renderPrMeta(tab, ev) {
  tab.prMeta = ev;
  tab.els.title.textContent = `${ev.nameWithOwner} #${ev.number}`;
  if (tab.els.label && ev.number) tab.els.label.textContent = `#${ev.number}`;
  tab.els.meta.innerHTML = `
    <strong>${escapeHtml(ev.title || "")}</strong><br/>
    <span>by @${escapeHtml(ev.authorLogin || "?")} · base <code>${escapeHtml(
      ev.baseRefName || "?",
    )}</code> ← head <code>${escapeHtml(ev.headRefName || "?")}</code>${
      ev.isDraft ? " · <em>draft</em>" : ""
    }</span><br/>
    <a href="${ev.url}" target="_blank" rel="noopener">open on GitHub →</a>
  `;
  setTabState(tab, tab.state); // refresh tab title/tooltip with repo name
}

function renderSummary(tab, ev) {
  const dur = ev.durationMs ? `${(ev.durationMs / 1000).toFixed(1)}s` : "—";
  const cost = ev.totalCostUsd != null ? `$${ev.totalCostUsd.toFixed(4)}` : "—";
  const turns = ev.numTurns ?? "—";
  const li = document.createElement("li");
  li.innerHTML =
    `<span class="ts">${formatTs(ev.ts)}</span>` +
    `<span class="kind kind-summary">summary</span>` +
    `duration ${dur} · cost ${cost} · turns ${turns}`;
  tab.els.log.appendChild(li);
  scrollLog(tab);
}

function appendLog(tab, ev) {
  const li = document.createElement("li");
  const ts = formatTs(ev.ts);
  const kind = ev.kind || "event";
  let body = "";
  switch (kind) {
    case "queued": body = `position ${ev.position}`; break;
    case "started": body = "worker started"; break;
    case "phase": body = ev.phase; break;
    case "log": body = escapeHtml(ev.message || ""); break;
    case "pr_meta": body = `${ev.nameWithOwner} #${ev.number} — ${escapeHtml(ev.title || "")}`; break;
    case "worktree_ready": body = ev.path; break;
    case "interrupted": body = escapeHtml(ev.message || "interrupted"); break;
    case "claude_started": body = `claude pid ${ev.pid ?? "?"}`; break;
    case "skill_resolved": {
      const tag = ev.source === "project" ? "[project]" : ev.source === "user" ? "[user]" : ev.source === "bundled" ? "[bundled]" : "";
      body =
        `<strong>${escapeHtml(ev.name || "")}</strong> ` +
        `<span>${escapeHtml(tag)}</span> ` +
        `<span>${escapeHtml(ev.pathDisplay || ev.path || "")}</span>`;
      break;
    }
    case "skill_missing":
      body =
        `<strong>no project review skill found</strong> — doing a generic review. ` +
        `<details><summary>paths searched</summary><pre>${escapeHtml((ev.attempted || []).join("\n"))}</pre></details>`;
      break;
    case "approval_policy": {
      const verdict = !ev.autoApprove ? "disabled" : ev.sizeOk ? "eligible" : "blocked (size)";
      body = `<strong>auto-approve: ${escapeHtml(verdict)}</strong> <span>${escapeHtml(ev.reason || "")}</span>`;
      break;
    }
    case "outcome_detected": body = `<strong>${escapeHtml(outcomeLabel(ev.outcome))}</strong>`; break;
    case "skipped": body = `<strong>skipped: ${escapeHtml(ev.reason || "")}</strong> <span>${escapeHtml(ev.detail || "")}</span>`; break;
    case "system": body = `claude session ${(ev.sessionId || "").slice(0, 8)} model=${ev.model || "?"}`; break;
    case "assistant_text": body = escapeHtml(ev.text || ""); break;
    case "tool_use":
      body = `<strong>${escapeHtml(ev.tool || "tool")}</strong> <span>${escapeHtml(ev.summary || "")}</span>`;
      if (ev.full) body += ` <details><summary>details</summary><pre>${escapeHtml(JSON.stringify(ev.full, null, 2))}</pre></details>`;
      break;
    case "tool_result": body = `${ev.isError ? "error" : "ok"} (${ev.length}b): ${escapeHtml(ev.preview || "")}`; break;
    case "result": body = `claude ${ev.isError ? "error" : "ok"} · turns ${ev.numTurns}`; break;
    case "summary": return; // rendered via renderSummary
    case "stderr": body = escapeHtml(ev.text || ""); break;
    case "failed": body = `<strong>${escapeHtml(ev.error || "failed")}</strong>${ev.code ? ` (${ev.code})` : ""}`; break;
    case "done": body = "finished"; break;
    case "stream_end": return;
    default: body = escapeHtml(JSON.stringify(ev));
  }
  li.innerHTML =
    `<span class="ts">${ts}</span>` +
    `<span class="kind kind-${kind}">${kind}</span>` +
    body;
  tab.els.log.appendChild(li);
  scrollLog(tab);
}

function scrollLog(tab) {
  // Only autoscroll the visible tab, so background tabs don't yank.
  if (tab.id === activeTabId) tab.els.log.scrollTop = tab.els.log.scrollHeight;
}

// -------------------------------------------------- status light (item a) ---

function emojiFavicon(emoji) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<text x="50" y="54" font-size="80" text-anchor="middle" dominant-baseline="central">${emoji}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function updateStatusLight() {
  let running = 0;
  let needsYou = 0;
  for (const tab of tabs.values()) {
    const m = statusMeta(tab);
    if (m.running) running++;
    if (m.needsYou) needsYou++;
  }
  let emoji, title;
  if (running > 0) {
    emoji = "👀";
    title = `(${running}) prsnooze — reviewing`;
  } else if (needsYou > 0) {
    emoji = "⚠️";
    title = `prsnooze — ${needsYou} need${needsYou > 1 ? "" : "s"} you`;
  } else {
    emoji = "😴";
    title = "prsnooze";
  }
  document.title = title;
  faviconEl.href = emojiFavicon(emoji);
}

// ------------------------------------------------ notifications (item 5) ----

function requestNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().then(updateNotifHint);
  }
  updateNotifHint();
}

function updateNotifHint() {
  if (!("Notification" in window)) {
    notifHint.textContent = "";
    return;
  }
  if (Notification.permission === "granted") notifHint.textContent = "🔔 notifications on";
  else if (Notification.permission === "denied") notifHint.textContent = "notifications blocked";
  else notifHint.textContent = "";
}

function notify(tab) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const m = statusMeta(tab);
  const name = tab.prMeta ? `${tab.prMeta.nameWithOwner} #${tab.prMeta.number}` : tab.prUrl || "review";
  const body = outcomeLabel(tab.outcome) || tab.state;
  try {
    new Notification(`${m.icon} ${name}`, { body, tag: tab.id });
  } catch {}
}

let audioCtx = null;
function playChime(needsYou) {
  if (!soundToggle.checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = needsYou ? [740, 555] : [555, 740]; // descending = attention, ascending = ok
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(g);
      g.connect(audioCtx.destination);
      const t = now + i * 0.16;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.start(t);
      o.stop(t + 0.17);
    });
  } catch {}
}

soundToggle.addEventListener("change", () => {
  localStorage.setItem(LS_SOUND, soundToggle.checked ? "1" : "0");
});

// --------------------------------------------------- tab persistence --------

function persistTabs() {
  const list = Array.from(tabs.values()).map((t) => ({ id: t.id, prUrl: t.prUrl }));
  try {
    localStorage.setItem(LS_TABS, JSON.stringify(list));
  } catch {}
}

async function restoreTabs() {
  let list;
  try {
    list = JSON.parse(localStorage.getItem(LS_TABS) || "[]");
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) return;

  let firstId = null;
  for (const { id, prUrl } of list) {
    let job;
    try {
      const r = await fetch(`/api/jobs/${id}`);
      if (!r.ok) continue; // job no longer known — drop it
      job = await r.json();
    } catch {
      continue;
    }
    const tab = createTab(id, prUrl || job.prUrl, { activate: false, persist: false });
    if (!firstId) firstId = id;
    if (job.prMeta) renderPrMeta(tab, job.prMeta);

    const terminal =
      job.state === "done" || job.state === "failed" || job.state === "interrupted" || job.skipped;
    if (terminal) {
      tab.outcome = job.outcome || null;
      for (const ev of job.events || []) appendLog(tab, ev);
      tab.finished = true;
      tab.notified = true; // never re-notify a review that finished before this load
      tab.finishedAt = job.finishedAt || null;
      setTabState(tab, job.state === "interrupted" ? "interrupted" : "done", null, tab.outcome);
    } else {
      openStream(tab); // still live — reconnect
    }
  }
  persistTabs(); // prune any that were dropped
  if (firstId && tabs.has(firstId)) activateTab(firstId);
}

// --------------------------------------------- welcome-back banner (item c) -

function maybeShowWelcome(jobs) {
  if (welcomeShown) return;
  welcomeShown = true;

  const lastSeen = Number(localStorage.getItem(LS_LASTSEEN) || 0);
  localStorage.setItem(LS_LASTSEEN, String(Date.now())); // reset baseline for next visit
  if (!lastSeen) return; // first-ever visit: nothing to summarize

  const since = (jobs || []).filter(
    (j) => j.finishedAt && j.finishedAt > lastSeen && (j.state === "done" || j.state === "failed"),
  );
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

welcomeDismiss.addEventListener("click", () => {
  welcomeBanner.hidden = true;
});

// ---------------------------------------------------------- recent + queue --

async function refreshRecent() {
  try {
    const r = await fetch("/api/jobs");
    const data = await r.json();
    renderRecent(data.jobs || []);
    renderQueueStatus(data.queue);
    maybeShowWelcome(data.jobs || []);
  } catch {}
}

function renderQueueStatus(q) {
  if (!q) return;
  const parts = [];
  parts.push(q.running > 0 ? `${q.running} running` : "idle");
  if (q.pending && q.pending.length) parts.push(`${q.pending.length} queued`);
  if (q.concurrency) parts.push(`cap ${q.concurrency}`);
  queueStatusEl.textContent = parts.join(" · ");
}

function renderRecent(list) {
  if (!list.length) {
    recentList.innerHTML = '<li class="empty">No reviews yet.</li>';
    return;
  }
  recentList.innerHTML = "";
  for (const j of list) {
    const li = document.createElement("li");
    const left = document.createElement("a");
    left.href = "#";
    left.dataset.jobId = j.id;
    const label =
      j.nameWithOwner && j.number
        ? `${j.nameWithOwner} #${j.number}${j.title ? " — " + j.title : ""}`
        : j.prUrl;
    left.textContent = label;
    left.addEventListener("click", (e) => {
      e.preventDefault();
      openJobAsTab(j.id, j.prUrl);
    });
    const right = document.createElement("span");
    right.className = "recent-meta";
    right.innerHTML = `${outcomeBadge(j)}<span class="badge ${j.state}">${j.state}</span>`;
    li.append(left, right);
    recentList.appendChild(li);
  }
}

// Open a job from the recent list as a tab (or focus it if already open).
async function openJobAsTab(id, prUrl) {
  if (tabs.has(id)) {
    activateTab(id);
    return;
  }
  let job;
  try {
    const r = await fetch(`/api/jobs/${id}`);
    if (!r.ok) return;
    job = await r.json();
  } catch {
    return;
  }
  const tab = createTab(id, prUrl || job.prUrl, { activate: true });
  if (job.prMeta) renderPrMeta(tab, job.prMeta);
  const terminal =
    job.state === "done" || job.state === "failed" || job.state === "interrupted" || job.skipped;
  if (terminal) {
    tab.outcome = job.outcome || null;
    for (const ev of job.events || []) appendLog(tab, ev);
    tab.finished = true;
    tab.notified = true;
    tab.finishedAt = job.finishedAt || null;
    setTabState(tab, job.state === "interrupted" ? "interrupted" : "done", null, tab.outcome);
  } else {
    openStream(tab);
  }
}

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

function outcomeBadge(j) {
  if (!j.outcome) return "";
  const o = j.outcome;
  const cls =
    o === "approved" ? "approved"
    : o === "changes_requested" ? "changes_requested"
    : o === "no_new_findings" ? "no_new_findings"
    : "commented";
  return `<span class="badge outcome-${cls}">${escapeHtml(outcomeLabel(o))}</span> `;
}

function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadConfig() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg.heroImage) {
      const img = document.querySelector(".hero-img");
      if (img && img.getAttribute("src") !== cfg.heroImage) img.src = cfg.heroImage;
    }
  } catch {}
}

// Keep the "last seen" baseline fresh so the welcome banner is accurate.
function stampLastSeen() {
  localStorage.setItem(LS_LASTSEEN, String(Date.now()));
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stampLastSeen();
});
window.addEventListener("beforeunload", stampLastSeen);

// ------------------------------------------------------------------- init ---

soundToggle.checked = localStorage.getItem(LS_SOUND) === "1";
updateNotifHint();
updateStatusLight();
loadConfig();
restoreTabs();
refreshRecent();
setInterval(refreshRecent, 5000);
