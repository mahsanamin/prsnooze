"use strict";

const $ = (id) => document.getElementById(id);

const form = $("submit-form");
const input = $("pr-url");
const submitBtn = $("submit-btn");
const submitMsg = $("submit-msg");
const activeSection = $("active-section");
const activeTitle = $("active-title");
const activeState = $("active-state");
const activeMeta = $("active-meta");
const activeLog = $("active-log");
const queueStatusEl = $("queue-status");
const recentList = $("recent-list");

let currentJobId = null;
let currentEs = null;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prUrl = input.value.trim();
  if (!prUrl) return;

  submitBtn.disabled = true;
  submitMsg.textContent = "submitting…";
  submitMsg.classList.remove("error");

  try {
    const r = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl }),
    });
    const data = await r.json();
    if (!r.ok) {
      submitMsg.textContent = data.error || `error: HTTP ${r.status}`;
      submitMsg.classList.add("error");
      return;
    }
    submitMsg.textContent = `Queued as ${data.jobId.slice(0, 8)}…`;
    input.value = "";
    openJob(data.jobId);
    refreshRecent();
  } catch (err) {
    submitMsg.textContent = `error: ${err.message}`;
    submitMsg.classList.add("error");
  } finally {
    submitBtn.disabled = false;
  }
});

function openJob(jobId) {
  if (currentEs) {
    currentEs.close();
    currentEs = null;
  }
  currentJobId = jobId;
  activeOutcome = null;
  activeSection.hidden = false;
  activeTitle.textContent = `Review ${jobId.slice(0, 8)}`;
  activeState.textContent = "queued";
  activeState.className = "badge queued";
  activeMeta.textContent = "";
  activeLog.innerHTML = "";

  const es = new EventSource(`/api/jobs/${jobId}/events`);
  currentEs = es;
  es.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    handleEvent(ev);
  };
  es.onerror = () => {
    // Stream may close on completion; that's fine. Refresh recent so the badge updates.
    refreshRecent();
  };
}

function handleEvent(ev) {
  appendLog(ev);
  if (ev.kind === "phase") {
    setState("running", ev.phase);
  } else if (ev.kind === "started") {
    setState("running");
  } else if (ev.kind === "queued") {
    setState("queued");
  } else if (ev.kind === "pr_meta") {
    renderPrMeta(ev);
  } else if (ev.kind === "done") {
    setState("done", null, activeOutcome);
    refreshRecent();
  } else if (ev.kind === "failed") {
    setState("failed");
    refreshRecent();
  } else if (ev.kind === "stream_end") {
    setState(ev.state, null, activeOutcome);
  } else if (ev.kind === "summary") {
    renderSummary(ev);
  } else if (ev.kind === "outcome_detected") {
    activeOutcome = ev.outcome;
    setState("running", null, activeOutcome);
  } else if (ev.kind === "skipped") {
    activeOutcome = ev.outcome || "skipped";
    setState("done", `skipped (${ev.reason})`, activeOutcome);
  }
}

let activeOutcome = null;

function setState(state, phase, outcome) {
  let text = state;
  if (phase) text = `${state} · ${phase}`;
  if (outcome) text = `${text} · ${outcomeLabel(outcome)}`;
  activeState.textContent = text;
  activeState.className = `badge ${state}`;
}

function outcomeLabel(o) {
  switch (o) {
    case "approved": return "✓ approved";
    case "changes_requested": return "⚠ changes requested";
    case "commented": return "💬 commented";
    case "skipped": return "↪ skipped";
    default: return o || "";
  }
}

function outcomeBadge(j) {
  if (!j.outcome) return "";
  const o = j.outcome;
  const cls = o === "approved" ? "approved"
    : o === "changes_requested" ? "changes_requested"
    : "commented";
  return `<span class="badge outcome-${cls}">${escapeHtml(outcomeLabel(o))}</span> `;
}

function renderPrMeta(ev) {
  activeTitle.textContent = `${ev.nameWithOwner} #${ev.number}`;
  activeMeta.innerHTML = `
    <strong>${escapeHtml(ev.title || "")}</strong><br/>
    <span>by @${escapeHtml(ev.authorLogin || "?")} · base <code>${escapeHtml(
      ev.baseRefName || "?",
    )}</code> ← head <code>${escapeHtml(ev.headRefName || "?")}</code>${
      ev.isDraft ? " · <em>draft</em>" : ""
    }</span><br/>
    <a href="${ev.url}" target="_blank" rel="noopener">open on GitHub →</a>
  `;
}

function renderSummary(ev) {
  const dur = ev.durationMs ? `${(ev.durationMs / 1000).toFixed(1)}s` : "—";
  const cost = ev.totalCostUsd != null ? `$${ev.totalCostUsd.toFixed(4)}` : "—";
  const turns = ev.numTurns ?? "—";
  const div = document.createElement("li");
  div.innerHTML =
    `<span class="ts">${formatTs(ev.ts)}</span>` +
    `<span class="kind kind-summary">summary</span>` +
    `duration ${dur} · cost ${cost} · turns ${turns}`;
  activeLog.appendChild(div);
  scrollLog();
}

function appendLog(ev) {
  const li = document.createElement("li");
  const ts = formatTs(ev.ts);
  const kind = ev.kind || "event";
  let body = "";
  switch (kind) {
    case "queued":
      body = `position ${ev.position}`;
      break;
    case "started":
      body = "worker started";
      break;
    case "phase":
      body = ev.phase;
      break;
    case "log":
      body = escapeHtml(ev.message || "");
      break;
    case "pr_meta":
      body = `${ev.nameWithOwner} #${ev.number} — ${escapeHtml(ev.title || "")}`;
      break;
    case "worktree_ready":
      body = ev.path;
      break;
    case "skill_resolved": {
      const tag =
        ev.source === "project"
          ? "[project]"
          : ev.source === "user"
            ? "[user]"
            : ev.source === "bundled"
              ? "[bundled]"
              : "";
      body =
        `<strong>${escapeHtml(ev.name || "")}</strong> ` +
        `<span>${escapeHtml(tag)}</span> ` +
        `<span>${escapeHtml(ev.pathDisplay || ev.path || "")}</span>`;
      break;
    }
    case "skill_missing":
      body =
        `<strong>no project review skill found</strong> — doing a generic review. ` +
        `<details><summary>paths searched</summary><pre>${escapeHtml(
          (ev.attempted || []).join("\n"),
        )}</pre></details>`;
      break;
    case "approval_policy": {
      const verdict = !ev.autoApprove
        ? "disabled"
        : ev.sizeOk
          ? "eligible"
          : "blocked (size)";
      body =
        `<strong>auto-approve: ${escapeHtml(verdict)}</strong> ` +
        `<span>${escapeHtml(ev.reason || "")}</span>`;
      break;
    }
    case "outcome_detected":
      body = `<strong>${escapeHtml(outcomeLabel(ev.outcome))}</strong>`;
      break;
    case "skipped":
      body =
        `<strong>skipped: ${escapeHtml(ev.reason || "")}</strong> ` +
        `<span>${escapeHtml(ev.detail || "")}</span>`;
      break;
    case "system":
      body = `claude session ${(ev.sessionId || "").slice(0, 8)} model=${ev.model || "?"}`;
      break;
    case "assistant_text":
      body = escapeHtml(ev.text || "");
      break;
    case "tool_use":
      body =
        `<strong>${escapeHtml(ev.tool || "tool")}</strong> ` +
        `<span>${escapeHtml(ev.summary || "")}</span>`;
      if (ev.full) {
        body +=
          ` <details><summary>details</summary><pre>${escapeHtml(
            JSON.stringify(ev.full, null, 2),
          )}</pre></details>`;
      }
      break;
    case "tool_result":
      body = `${ev.isError ? "error" : "ok"} (${ev.length}b): ${escapeHtml(ev.preview || "")}`;
      break;
    case "result":
      body = `claude ${ev.isError ? "error" : "ok"} · turns ${ev.numTurns}`;
      break;
    case "summary":
      // Already rendered via renderSummary
      return;
    case "stderr":
      body = escapeHtml(ev.text || "");
      break;
    case "failed":
      body = `<strong>${escapeHtml(ev.error || "failed")}</strong>${
        ev.code ? ` (${ev.code})` : ""
      }`;
      break;
    case "done":
      body = "finished";
      break;
    case "stream_end":
      return;
    default:
      body = escapeHtml(JSON.stringify(ev));
  }
  li.innerHTML =
    `<span class="ts">${ts}</span>` +
    `<span class="kind kind-${kind}">${kind}</span>` +
    body;
  activeLog.appendChild(li);
  scrollLog();
}

function scrollLog() {
  activeLog.scrollTop = activeLog.scrollHeight;
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

async function refreshRecent() {
  try {
    const r = await fetch("/api/jobs");
    const data = await r.json();
    renderRecent(data.jobs || []);
    renderQueueStatus(data.queue);
  } catch {}
}

function renderQueueStatus(q) {
  if (!q) return;
  const running = q.runningJobId ? "1 running" : "idle";
  const pending = q.pending?.length || 0;
  queueStatusEl.textContent =
    pending > 0 ? `${running} · ${pending} queued` : running;
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
    const label = j.prMeta
      ? `${j.nameWithOwner} #${j.number} — ${j.title || ""}`
      : j.title
        ? `${j.nameWithOwner} #${j.number} — ${j.title}`
        : j.prUrl;
    left.textContent = label;
    left.addEventListener("click", (e) => {
      e.preventDefault();
      openJob(j.id);
    });
    const right = document.createElement("span");
    right.className = "recent-meta";
    right.innerHTML = `${outcomeBadge(j)}<span class="badge ${j.state}">${j.state}</span>`;
    li.appendChild(left);
    li.appendChild(right);
    recentList.appendChild(li);
  }
}

async function loadConfig() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg.heroImage) {
      const img = document.querySelector(".hero-img");
      if (img && img.getAttribute("src") !== cfg.heroImage) {
        img.src = cfg.heroImage;
      }
    }
  } catch {}
}

loadConfig();
refreshRecent();
setInterval(refreshRecent, 5000);
