# Local scenario pack

Run the deterministic pack against the local Compose database:

```bash
make seed-scenarios
```

Defaults are `TASK_COUNT=10000` and `COMMENT_COUNT=12000`. Override them when needed, keeping at least 100 tasks:

```bash
TASK_COUNT=25000 COMMENT_COUNT=50000 make seed-scenarios
```

The command migrates the database, resets only the two fixture projects below, loads the records, analyzes the relevant tables, and fails unless all distribution checks pass.

## Fixture projects

| Project | ID | Purpose |
|---|---|---|
| Scale & Scenario Lab | `02000000-0000-7000-8000-000000000001` | 10k tasks, 12k comments, 8 members, dependency graphs, event history, and named edge cases |
| Empty Sandbox | `02000000-0000-7000-8000-000000000002` | Empty state, first-task creation, project isolation, and zero-count behavior |
| Realtime Launch | `01000000-0000-7000-8000-000000000001` | Small, readable collaboration demo from `demo.sql` |
| Mobile Experience | `01000000-0000-7000-8000-000000000002` | Small responsive-project demo from `demo.sql` |

The UI uses the seeded Maya identity, which belongs to all four projects.

## Named tasks

The newest eleven rows in **Scale & Scenario Lab** are deliberately recognizable:

| Search text | Scenario |
|---|---|
| `[P0]` | Blocked urgent incident, three assignees, multiple dependencies, multiline acceptance criteria, comments |
| `[Release]` | Completed high-priority release coordination |
| `[Unassigned]` | No-assignee ownership state |
| `[Layout]` | Very long title and description, list truncation, detail scrolling, responsive layout |
| `[i18n]` | Japanese, Arabic, Hindi, emoji, and accented text |
| `[Minimal]` | Empty description, no assignees, no primary tag, no comments |
| `[Comments]` | Visible hot thread with exactly 2,500 comments by eight authors |
| `[Dependencies]` | Final node of the documented cycle-rejection chain |
| `[Offline]` | Reconnect and missed-event replay scenario |
| `[Conflict]` | Version 7 task for two-client stale-write testing |
| `[Transitions]` | Valid and invalid status-transition testing |

## Coverage generated across the full project

- All 16 status/priority combinations, distributed nearly evenly.
- 857+ unassigned tasks and 500+ multi-assignee tasks at the default size.
- No-tag, one-tag, and multi-tag records.
- String, number, and boolean custom fields.
- Empty, short, multiline, Unicode, and long descriptions.
- Roughly 2,000 dependency edges with independent tasks, sparse chains, fan-in, and a diamond.
- No-comment tasks, ordinary threads, distributed comments, and one 2,500-comment hot thread.
- Mentions, numbered reproduction steps, Unicode, long comments, incident notes, decisions, and code/header examples.
- Varied entity versions for optimistic-concurrency tests.
- A 200-event durable replay window without bloating the seed with one event per entity.
- An entirely empty project alongside small and large projects.

## Dependency cycle test

The named path is:

```text
[Dependencies] -> [Offline] -> [Conflict]
```

Open `[Conflict]` and try to add `[Dependencies]` as a dependency. The API should reject the reverse edge with `DEPENDENCY_CYCLE` because it would close the loop. The incident and layout tasks also demonstrate fan-in and diamond-shaped graphs.

## Comment load test

Open `[Comments] Hot thread with thousands of chronological replies`. The task badge should show `2500`; the first 50 comments load immediately and **Load older comments** follows the API cursor until the thread is exhausted. Creating a new comment should update the thread and task counter without double-counting the SSE echo.

## Conflict and real-time test

1. Open `[Conflict]` in two browser windows.
2. Change it in window A.
3. Save the stale version from window B and verify the `409` conflict UI.
4. Keep both windows open, create a comment or update another task, and verify the remote client reconciles the SSE event.
5. Temporarily stop the API, restart it, and verify replay continues after the last applied sequence.

## API checks

```bash
project=02000000-0000-7000-8000-000000000001
actor=00000000-0000-7000-8000-000000000001

curl -H "X-Actor-ID: $actor" \
  "http://localhost:8080/v1/projects/$project/tasks?limit=20&q=Comments&priority=HIGH"

curl -H "X-Actor-ID: $actor" \
  "http://localhost:8080/v1/projects/$project/tasks?limit=100&status=BLOCKED&priority=URGENT"
```

The scenario verifier lives at [`db/checks/verify-scenarios.sql`](../checks/verify-scenarios.sql). It checks exact configured counts, the empty project, every status and priority, assignment distributions, dependency volume, the hot thread, denormalized comment counters, and replay-event count.
