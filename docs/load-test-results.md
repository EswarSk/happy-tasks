# Load-test results

> Only the very first row below (2026-08-28, the original `## Baseline` table)
> predates the Redpanda outbox relay and Redis cross-instance fan-out
> introduced on 2026-08-29 — it's kept as a database/API reference point, not a
> current-architecture claim. Every other result on this page, including the
> Yjs/WebSocket collaboration stress tests, already runs against that
> distributed architecture. The 2026-08-30 row re-confirms the read path
> against the current codebase (SameSite session-cookie fix, the new
> actor-scoped Redis comment-page cache, and the auto-join showcase projects
> from this session).

The checked-in scenario at [`scripts/load/tasks.js`](../scripts/load/tasks.js)
measures authenticated, cursor-backed task-page reads against the seeded
10,000-task project. Run it after starting the Compose stack and loading the
scale seed.

## Baseline

| Date | Machine | Seed | Concurrency | Requests | Errors | Median | p95 | Page body |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-08-28 | Apple Silicon MacBook Pro, macOS Darwin 25.6.0 | 10,000 tasks / 12,000 comments | 20 VUs for 30s | 2,920 | 0.00% | 4.88 ms | 8.61 ms | 59,124 B |

Command used:

```bash
VUS=20 DURATION=30s BASE_URL=http://127.0.0.1:18080 \
  k6 run scripts/load/tasks.js
```

The k6 compact-page check stayed below 256 KiB for every response. The
database plan for the same first page was an index scan using
`tasks_project_updated_idx`.

That historical baseline used the pre-authenticated demo configuration. The
authenticated multi-user results below are the current reference.

This is a local baseline, not a universal capacity claim. Re-run it after
changing the schema, query, seed size, or deployment topology.

## Authenticated multi-user run

The load script logs in eight seeded fixture users during `setup()` and assigns
their session cookies across the virtual users. The scale seed grants those
users membership in the heavy project; the fixture password is `password`.

| Date | Users | Concurrency | Task-page requests | Task-page errors | Median | p95 | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-08-29 | 8 | 20 VUs for 30s | 2,760 | 0.00% | 17.29 ms | 30.35 ms | Pass |
| 2026-08-29 | 8 | 100 VUs for 30s | 14,300 | 76.94% | 5.05 ms | 35.04 ms | Rate-limited |
| 2026-08-30 | 8 | 20 VUs for 30s | 2,808 | 0.00% | 13.61 ms | 21.1 ms | Pass — 50-item page body 39,807 B |

Commands used:

```bash
VUS=20 DURATION=30s BASE_URL=http://127.0.0.1:8080 \
  PROJECT_ID=02000000-0000-7000-8000-000000000001 \
  k6 run scripts/load/tasks.js

VUS=100 DURATION=30s BASE_URL=http://127.0.0.1:8080 \
  PROJECT_ID=02000000-0000-7000-8000-000000000001 \
  k6 run scripts/load/tasks.js
```

At 20 VUs, all 2,760 task-page requests succeeded. At 100 VUs, the API
returned `429` responses after the configured per-source read bucket was
exhausted; p95 latency for completed requests remained 35.04 ms and no 5xx
errors were observed. This is a rate-limit ceiling, not evidence of database
failure.

## Mixed CRUD, files, comments, and live descriptions

The checked-in [`scripts/load/full-workload.js`](../scripts/load/full-workload.js)
ran 1,000 heavy-project readers alongside 25 CRUD clients, 50 hot-thread
commenters, and 10 clients uploading, listing, downloading, and deleting 3 MiB
attachments. The CRUD path covered task create, read, update, comment, and
delete with large descriptions and custom fields.

The mixed run produced no 5xx responses. Some requests reached the configured
per-source rate limiter and returned `429`, so this run demonstrates graceful
rate limiting and error isolation rather than an uncapped 1,085-user capacity
claim. An end-to-end canary completed every CRUD and file operation.

The Yjs WebSocket scenario at
[`scripts/load/description-workload.mjs`](../scripts/load/description-workload.mjs)
also passed with 100 connected clients and 100 acknowledged concurrent
description edits: 0 rejected and 0 failed edits.

A same-task CRDT stress run used 1,000 concurrent authenticated WebSocket
clients (eight fixture identities reused across the clients) with distinct
simulated source IPs. All 1,000 clients connected and all 1,000 Yjs updates were
persisted. Within the runner's 10-second acknowledgement timeout, 734 acks
arrived and 266 clients timed out; the server had persisted those updates even
though their client-side ack wait expired. This is a backpressure/ack-latency
finding at 1,000 collaborators, not a clean 1,000-client acknowledgement pass.

The dedicated all-CRUD run then used 1,000 VUs, one iteration per VU. Every
user completed create, read, update, comment, and delete successfully: 5,010
HTTP requests, 0 failed requests, and 5,002/5,002 checks passed. HTTP p95 was
1.34 s and throughput was 177.54 completed user iterations per second.

The run enabled `DISTINCT_SOURCE_IPS=true` in the load runner to model 1,000
independent clients. Without that option, all local VUs share one source IP
and the application's per-source mutation limiter correctly returns `429`
after its bucket is exhausted.

The long-duration same-task run used 1,000 unique disposable users and held
1,000 authenticated sessions open for 60 seconds, with each client attempting
an edit every 5 seconds. All 1,000 sessions connected, but only 461 of 5,592
attempted edits were acknowledged within the unchanged 10-second client SLA;
839 updates were durably stored by the end of the run. No server errors were
observed. This currently fails a strict 1,000-collaborator real-time SLA due to
acknowledgement backpressure, even though the sessions themselves remained
healthy.

Commands used:

```bash
READ_VUS=1000 CRUD_VUS=25 COMMENT_VUS=50 FILE_VUS=10 \
  BASE_URL=http://127.0.0.1:8080 \
  k6 run scripts/load/full-workload.js

CLIENTS=100 TASK_ID=<temporary-task-id> BASE_URL=http://127.0.0.1:8080 \
  node scripts/load/description-workload.mjs

READ_VUS=0 CRUD_VUS=1000 COMMENT_VUS=0 FILE_VUS=0 \
  DISTINCT_SOURCE_IPS=true BASE_URL=http://127.0.0.1:8080 \
  k6 run scripts/load/full-workload.js

CLIENTS=1000 USER_COUNT=1000 DISTINCT_SOURCE_IPS=true \
  DURATION_MS=60000 EDIT_INTERVAL_MS=5000 EDIT_TIMEOUT_MS=10000 \
  BASE_URL=http://127.0.0.1:8080 PROJECT_ID=<sandbox-project-id> \
  TASK_ID=<temporary-task-id> node scripts/load/description-workload.mjs
```
