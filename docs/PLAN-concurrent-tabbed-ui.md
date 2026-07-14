# prsnooze — Concurrent Reviews + Tabbed UI

**Status:** Plan (awaiting sign-off before code)
**Branch:** `feat/concurrent-tabbed-ui`
**Date:** 2026-07-14

---

## In one line

Let prsnooze review **several PRs at the same time**, each in its **own tab** with
live status, tell you when they're done, and never lose or leak work when the
server restarts.

---

## Why (the problems today)

1. **One-at-a-time.** prsnooze reviews a single PR, finishes, then starts the
   next. Four PRs = wait for all four back-to-back.
2. **You have to babysit the page.** The tagline is "review while you sleep,"
   but today you must keep the tab open and watch to know what happened.
3. **A restart loses everything.** Job state lives only in memory. If the
   server crashes or restarts, the list is wiped, stuck jobs show "running"
   forever, and any review that was mid-flight becomes an **orphaned process**
   that keeps running (and can even post to GitHub) with nobody cleaning it up.
   *(We hit both of these this session.)*

---

## What we're building (8 items)

### 1. Run multiple reviews at once
Instead of one at a time, prsnooze can review several PRs in parallel.
- Controlled by a setting, **`MAX_CONCURRENT_REVIEWS`**.
- **Default is 1** — so nothing changes unless you turn it up.
- Each review still gets its **own private folder (worktree)** and its **own
  Claude session**, exactly as today — they don't share anything while running.

### 2. "Take turns" on the download step (per repo)
The only thing parallel reviews share is a repo's download step (`git fetch`).
Two PRs from the **same repo** trying to download at the same instant is what
causes git to break.
- Fix: if one review is already doing the ~10-second git prep for a repo, a
  second review of the **same repo waits its turn**, then goes.
- **Different repos never wait** — they run fully in parallel.
- After the prep, all reviews run in parallel regardless.

> Plain version: *fetch takes turns per repo; reviews run all at once.*

### 3. Tabs — one per PR
- Paste a PR link → it opens as a **tab** with its own live progress.
- You can **paste several links at once** (one per line) → one tab each.
- Each tab keeps streaming in the background, so switching tabs is instant and
  you never lose a review's progress.
- Open tabs are remembered if you refresh the page.

### 4. Tab status at a glance (color + icon)
Every tab shows where its review stands:

| Icon | Meaning |
|------|---------|
| ⏳ | waiting / preparing |
| 🔵 | in progress |
| ✓ | approved |
| 💬 | commented |
| ⚠ | changes requested |
| ✗ | failed |

The running tab gently pulses so you can see it's alive.

### 5. Tell you when it's done
- A **browser notification** as each review finishes
  (e.g. *"PR #591 — changes requested"*).
- **Optional sound** (off by default), so you get pinged even across the room.

### 6. Survive restarts — and never leak processes
When the server stops or crashes:
- **On shutdown:** cleanly stop any running review processes first.
- **Own process group:** reviews are launched so the *whole tree* (Claude + the
  `gh`/`git` helpers it spawns) can be stopped together — no leftover children.
- **On startup:** reload past jobs from disk, mark any that were mid-flight as
  **"interrupted"** (honest state, not a fake "running"), and if a leftover
  orphan from before is still alive, **kill it** before continuing.

> Result: a graceful stop leaves nothing behind; a crash is detected and
> cleaned up on the next start. A machine reboot needs nothing (the OS clears
> it).

### a. The browser tab becomes a status light
The **favicon and page title** reflect overall state without you opening the
page:
- `👀 (2 running)` while reviews are working
- `😴 prsnooze` when idle / all done
- a red dot when something **needs you** (changes-requested / failed)

So a glance at your browser tabs tells you the story.

### c. "While you were away" welcome-back banner
When you reload after being gone, a friendly one-line summary at the top:

> *"3 reviews finished while you snoozed — 2 approved ✓, 1 needs you ⚠"*

Turns coming back into a moment, not a scan.

---

## Explicitly NOT in this build

- **Dark mode** (was option b) — skipped.
- Results-first tab layout, cancel/retry buttons, cost/duration in the list,
  fetch coalescing, auto-start on boot (options 7–12) — deferred to a later
  polish pass.

---

## Settings (defaults)

| Setting | Default | What it does |
|---------|---------|--------------|
| `MAX_CONCURRENT_REVIEWS` | `1` (shipped) | How many reviews run at once. Set higher to enable parallelism. |
| Sound on finish | off | Opt-in chime when a review ends. |

Your machine's cap will be set in your local `.env` — **you tell me: 2, 3, or 4.**

---

## How we'll roll it out (so you can validate in steps)

1. **Backend first** — items **1, 2, 6** (concurrency + per-repo lock +
   restart/orphan safety). After this you can already run your 4 PRs.
2. **Frontend next** — items **3, 4, 5, a, c** (tabs, status, notifications,
   status-light, welcome banner).

Work happens on branch **`feat/concurrent-tabbed-ui`**, committed in logical
chunks. **Nothing is pushed** — you review locally first. Your existing
uncommitted tweaks (`package-lock.json`, `style.css`) are left untouched.

---

## Open questions

1. **Concurrency cap for your machine** — 2, 3, or 4?
2. Anything in "NOT in scope" you'd actually like pulled into this build?
