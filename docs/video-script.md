# 5-minute demo video — literal shooting script

Recording setup before you hit record:
- Two browser windows side by side (or one normal + one incognito), each sized to roughly half your screen.
- Window A signed in as `maya@example.test` / `password`. Window B signed in as `noah@example.test` / `password`.
- Have `docs/architecture.md` open in a second desktop/tab (rendered in your editor or GitHub, so the SVG diagram shows), and your editor open to the three files listed in section 5.
- Zoom browser to 100%. Close DevTools before recording (open it only for the one beat that calls for it).

Say every **SAY** line close to verbatim — they're written to be spoken, not read. **DO** lines are literal clicks; follow them in order. Timecodes are targets, not hard cuts — land within ~5s of each.

---

## 1. Cold open (0:00–0:20)

**SAY:** "This is Happy Tasks — a collaborative task manager I built for the Happy Robot take-home. The brief asked for real-time sync across clients, dependency graphs, comments, and a system that stays correct under concurrent edits and 10,000 tasks. I'll show all of that live, then walk through how it's built."

**DO:** Screen is on Window A, already at `https://web-atujfotjyq-uc.a.run.app/login`.

---

## 2. Sign in (0:20–0:30)

**DO (Window A):** Page shows eyebrow "Happy Tasks", heading "Welcome back", subtext "Sign in to access your projects, files, and collaboration history." Click the **Email** field, type `maya@example.test`. Click **Password**, type `password`. Click **Sign in**.

**SAY:** "I'll sign in as Maya in this window, and as a second teammate, Noah, in the other."

**DO (Window B):** Same steps with `noah@example.test` / `password`.

---

## 3. Live demo (0:30–2:30)

### 3a. Live sync across clients (0:30–1:00)

**DO (both windows):** In the left sidebar, click **Realtime Launch** (shows a `5` badge). Both windows now show the same 5-row task list: TSK-000001 through TSK-000005.

**SAY:** "Both of us are looking at the same project. I'll create a task as Maya, with no refresh on Noah's side."

**DO (Window A):** Click **+ New task** (top right). In the modal ("Create a task" / "Choose the project first, then give the task a clear outcome."), confirm the **Project** dropdown reads **Realtime Launch** — if it shows a different project, click it and pick **Realtime Launch**. Click the **Task title** field, type `Record the demo video`. Click **Create task**.

**DO (Window B):** Point at the task list — the new "Record the demo video" row appears at the top without any reload.

**SAY:** "That update came over a server-sent event stream, keyed to this project only — not a broadcast of the whole task list. Every mutation is one committed Postgres row, and every connected client discovers it independently."

### 3b. Dependency cycle rejection (1:00–1:35)

**DO (Window A):** In the sidebar, click **Scale & Scenario Lab** (shows a `10k` badge). The list is sorted by "Updated recently," so these rows are at or near the top. Click the row **[Conflict] Two clients edit the same task version** (key `TSK-546C3A`).

**SAY:** "This project is a deterministic 10,000-task fixture, seeded with specific edge cases — including a dependency chain built to test cycle prevention."

**DO:** In the right detail panel, scroll down past **Properties** to the **Dependencies** section, which reads "No dependencies yet." Click the **Search tasks to add…** field, type `Cycle rejection`. A dropdown option appears: `TSK-657900 · [Dependencies] Cycle rejection lab — final node`. Click that option.

**SAY:** "This task already depends, two hops downstream, on the one I'm about to link back to it. Adding this edge would close the loop."

**DO:** Point at the red inline message that appears: **"Adding this dependency would create a cycle."** — directly above the existing hint **"Cycle-forming dependency edges are rejected transactionally."**

**SAY:** "Rejected server-side, inside the same transaction as the write — not a client-side check that a direct API call could bypass."

### 3c. Scale and virtualization (1:35–2:05)

**DO (Window A):** Still in Scale & Scenario Lab, click into the task list area and scroll down quickly (mouse wheel or trackpad) for 3–4 seconds.

**SAY:** "Scrolling through all ten thousand rows — the list only renders what's on screen and pages by cursor, so this stays smooth regardless of project size."

**DO:** Open DevTools (Cmd+Option+I), click the **Network** tab, scroll the list once more, and point at one of the XHR requests to the `/tasks` endpoint — show its response size is small (a single page), not the whole dataset. Close DevTools.

### 3d. Comments and activity (2:05–2:30)

**DO (Window A):** Click the row **[Comments] Hot thread with thousands of chronological replies** (key `TSK-41D39F`, shows a `2500` comment-bubble signal in the list). In the detail panel, click the **Comments** tab.

**SAY:** "Comment threads page independently of the task list, so a two-thousand-five-hundred-comment thread doesn't slow down anything else in the project."

**DO:** Scroll the comment list briefly to show it loading in pages, then click **Activity** tab next to it to show the chronological event log for the project.

---

## 4. Architecture walkthrough (2:30–3:30)

**DO:** Switch to the window/tab with `docs/architecture.md` open, scrolled to the section 4 diagram (the boxed diagram titled with Browser → api → PostgreSQL → relay → Redpanda → Redis).

**SAY:** "Here's the shape of it. The browser only ever talks REST to the API for commands and cursor-paginated reads, and holds one SSE and one WebSocket connection for live updates. The Go API is a modular monolith — one deployable, but internally split into transport, application services, domain policy, and repositories, so business rules don't leak into HTTP handling.

Every mutation is one Postgres transaction: the domain write and an outbox event land together, or neither does. A separate relay — a fixed-size Cloud Run worker pool, not an autoscaled service, because it's a steady background job — polls that outbox and publishes to Redpanda. Every API replica consumes from Redpanda through a shared consumer group and fans out over Redis, so a client connected to any replica sees the update.

The dashed path on the left is the fallback: if Redpanda or Redis is degraded, a reconnecting client replays missed events directly from Postgres by sequence number, which is always correct because Postgres is the only source of truth — the broker path is a fast lane, not the record of what happened."

**DO:** Point at the "1 transaction: domain write + outbox event" arrow, then the dashed replay-by-sequence path, as you say those two lines.

---

## 5. Design approach, decisions, and tradeoffs (3:30–4:30)

**DO:** Split-screen or quick-cut between `docs/architecture.md` section 19 ("Important tradeoffs") and three source files: `internal/transport/httpapi/handler.go`, `internal/app/service.go`, `internal/transport/httpapi/rate_limit.go`.

**SAY:** "A few decisions worth calling out.

I used SSE, not WebSockets, for the durable update stream — it's a simpler one-way protocol with a well-understood reconnect model, and I only needed server-to-client push for state updates. WebSockets are reserved for the one place that actually needs bidirectional traffic: collaborative text editing, where I use a CRDT — Yjs — scoped to the task description field only, not the whole task. Everything else — status, priority, assignees — uses field-level optimistic concurrency with an If-Match version header, so two people editing different fields on the same task never conflict, and a stale write on the same field comes back as a 409 with enough state to resolve it in the UI.

I debugged a real production bug this way: clients were showing 'reconnecting' for up to fifteen seconds after a real connection succeeded. Root cause was the reverse proxy withholding the response until real body bytes existed, even after the server flushed an empty body. The fix was writing an SSE comment immediately after headers, before any replay or wait logic — you can see that in handler.go.

I also went back and re-examined the rate limiter after noticing it was keying on a header a client could just set itself. The fix reads the rightmost non-private entry in X-Forwarded-For — the one position a single trusted reverse-proxy hop, like Cloud Run, can't let a client forge — and only trusts a client-supplied actor override on endpoints that don't need it for correctness.

And the comment cache is intentionally keyed per-viewer, not per-comment, because whether a comment shows as 'reacted' depends on who's looking — a shared cache entry would leak one viewer's reaction state to another."

---

## 6. Wrap-up (4:30–5:00)

**DO:** Back to Window A, sidebar visible.

**SAY:** "That's Happy Tasks: Postgres as the single source of truth, a durable outbox instead of trusting delivery, field-level concurrency instead of last-write-wins, and a fallback path that keeps working even when the fast path doesn't. Everything you just saw is running on Cloud Run right now, backed by Cloud SQL, Redpanda, and Redis — the deployment section and full tradeoff list are in the README and architecture doc in the repo. Thanks for watching."

**DO:** End on the project list or the architecture diagram — whichever you're on. Stop recording.

---

## Reference: exact demo data used above

| Beat | Project | Task key | Title |
| --- | --- | --- | --- |
| 3a | Realtime Launch | (new) | Record the demo video |
| 3b | Scale & Scenario Lab | TSK-546C3A | [Conflict] Two clients edit the same task version |
| 3b | Scale & Scenario Lab | TSK-657900 | [Dependencies] Cycle rejection lab — final node |
| 3d | Scale & Scenario Lab | TSK-41D39F | [Comments] Hot thread with thousands of chronological replies |

Login credentials used: `maya@example.test` / `password` (Window A), `noah@example.test` / `password` (Window B) — pre-seeded demo users, not the account you'd use to submit for review.
