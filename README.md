# Happy Tasks

A collaboration-first task manager built for the Full Stack Challenge. It demonstrates how a familiar project workspace can stay responsive and consistent when projects grow beyond a few megabytes and several clients edit the same data at once.

**Live deployment:** https://web-atujfotjyq-uc.a.run.app — see [Demo path](#demo-path) for how to sign in and what to look at.

The implementation is deliberately practical: a Next.js application, a Go modular monolith, and PostgreSQL. REST handles commands and paginated reads; project-scoped Server-Sent Events (SSE) replay compact, durable changes instead of retransmitting an entire project.

## What is included

- Multiple projects with project creation and a responsive project switcher.
- Email/password authentication with bcrypt password hashes, random HttpOnly session cookies, logout, and an explicit local demo fallback.
- Organization membership isolation layered beneath project roles; project reads and invitations require the same active organization.
- Task creation, editing, deletion, search, status/priority filters, explicit assignee add/remove controls, tags, custom fields, and optimistic UI.
- Stable user identities, soft membership lifecycle (active/invited/suspended/removed), role enforcement, final-owner protection, paginated member search, and append-only assignment history.
- Dependency creation/removal with transactional cycle prevention.
- Nested comment threads with same-task database constraints, cursor-ready indexing, optimistic rollback, and near-real-time delivery.
- Comment reactions with one reaction per user/comment, transactional counts, and live reconciliation.
- Ephemeral task presence and live description-selection awareness over bounded WebSocket rooms, deduplicated by user across browser sessions.
- @handle comment mentions with durable in-app notifications and real-time unread-count reconciliation.
- A project activity timeline plus a native drag-and-drop Kanban board that uses the same task rules as the list.
- Conflict detection through `If-Match` versions and retry-safe writes through idempotency keys.
- Field-level task operation history with actor-scoped undo/redo; independent stale edits (for example status and priority) merge safely.
- Yjs CRDT description editing over a task-scoped WebSocket with durable snapshots, replayable updates, and a searchable text projection.
- Durable, ordered project event streams with reconnect/replay semantics.
- Transactional outbox delivery through Redpanda plus Redis cross-instance fan-out, leased presence, and bounded Yjs snapshot compaction.
- A virtualized task list and cursor-paginated API suitable for 10,000+ tasks.
- An actor-scoped Redis cache of each task's first comment page, invalidated read-after-write on the author's own comments and TTL-bounded otherwise.
- Installable PWA offline support: task creates/edits/deletes queue in IndexedDB while offline and replay in order on reconnect, with conflicts kept visible rather than silently dropped.
- Task file attachments for documents and photos up to 25 MB each, stored in S3-compatible object storage (MinIO/AWS S3) or natively in Google Cloud Storage — chosen automatically at startup, see [Object storage](#object-storage) — with authenticated download/delete, SHA-256 metadata, and durable cleanup retries.
- Installable PWA manifest, service worker shell caching, offline fallback, and connection status messaging.
- Mock mode for isolated UI development and API mode for the integrated product.
- Reversible migrations, deterministic demo/scale seeds, schema verification, CI, container builds, and a k6 scenario.
- A recorded 10,000-task load-test baseline in [`docs/load-test-results.md`](docs/load-test-results.md).

## Quick start

Prerequisite: Docker with Compose. Ports `3000`, `8080`, `5432`, `6379`, `9000`, `9001`, and `19092` must be available unless overridden in `.env`.

```bash
cp .env.example .env
make seed-demo
make stack-up
```

Open [http://localhost:3000](http://localhost:3000). The root route redirects to the seeded **Realtime Launch** project.

To add the complete local test pack—10,000 tasks, 12,000 comments, dependency graphs, heavily commented tasks, collaboration variations, named edge cases, and an empty project—run:

```bash
make seed-scenarios
```

Open **Scale & Scenario Lab** from the project sidebar. Re-running the command resets only the two fixture projects; it does not modify user-created projects.

The complete catalog and guided tests are in [`db/seed/SCENARIOS.md`](db/seed/SCENARIOS.md).

Useful commands:

```bash
make logs          # follow PostgreSQL, API, and web logs
make test          # Go and frontend tests
make lint          # Go vet plus frontend lint/typecheck
make seed-scale    # add the deterministic 10k-task dataset
make seed-scenarios # load the complete deterministic UI/API scenario pack
make db-verify     # verify constraints, indexes, isolation, and query plan
make load          # run the checked-in k6 scenario after the scale seed
make stack-down    # stop services and retain the database volume
make db-reset      # reset only the named disposable local database
```

The latest local scale baseline is recorded in [`docs/load-test-results.md`](docs/load-test-results.md).

`make db-reset` requires an explicit local-reset guard and never targets an arbitrary database. To remove the retained Compose volume, use `docker compose down --volumes` intentionally.

## Architecture

```text
Next.js 16 + React Query + virtualized list
       | REST + SSE + collaboration WebSockets
       v
Stateless Go API replicas
       | transactional domain writes   ` attachment bytes
       v                                 v
PostgreSQL 17                   MinIO locally / S3 or GCS in production
       | sync_events outbox
       v
     relay --> Redpanda --> Redis ephemeral fan-out
                              | project events
                              | presence leases
                              ` Yjs live updates
```

PostgreSQL is the system of record because task transitions, membership, dependencies, comments, idempotency, and event publication benefit from relational constraints and multi-row transactions. A competing-safe relay publishes committed `sync_events` to the Kafka-compatible Redpanda log, keyed by project. Redis carries only disposable last-mile delivery and presence leases. A missed broker or Redis notification does not lose task data because SSE clients replay `sync_events` after their last sequence.

MongoDB would make flexible task documents convenient, but unbounded embedded comments and dependency consistency would still require separate collections, indexes, and transactions. Cassandra becomes compelling later for very high-volume, append-heavy comment or activity projections, but it is not a good authority for graph-cycle checks and cross-entity invariants in this two-day scope.

The code is separated by responsibility:

- `apps/web/features`: product workflows and query-cache reconciliation.
- `apps/web/components/ui`: reusable design-system primitives.
- `apps/web/lib/api`: mock and HTTP adapters behind one `WorkspaceApi` contract.
- `internal/domain`: domain types and validation.
- `internal/app`: use cases and transactional orchestration.
- `internal/platform/database`: PostgreSQL implementation.
- `internal/platform/objectstorage`: attachment storage behind one `Store` interface, backed by S3 (MinIO/AWS) or native GCS.
- `internal/transport/httpapi`: REST/SSE transport concerns.
- `db/migrations`, `db/seed`, and `db/checks`: schema lifecycle and verification.

The API contract is checked in at [`api/openapi.yaml`](api/openapi.yaml). Deeper decisions live in:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/database-design.md`](docs/database-design.md)
- [`docs/ui-design.md`](docs/ui-design.md)

## Synchronization model

Every successful mutation performs these steps atomically:

1. Validate membership, input, and domain invariants.
2. Lock only the records or project dependency graph needed by the operation.
3. Change domain state.
4. Allocate the next project sequence and append a compact `sync_events` row.
5. Commit, then let connected clients wake and read events after their cursor.

The browser patches only affected React Query entries. If it detects a sequence gap, it invalidates the relevant paginated data and catches up from the durable stream. Reconnects send both an explicit cursor and `Last-Event-ID`. Slow or interrupted clients therefore converge without a full-project payload.

Task metadata uses field-level optimistic concurrency and explicit inverse operations. A stale write is accepted only when its changed fields are disjoint from committed operations after the client's version; same-field edits remain understandable business conflicts. Descriptions use Yjs over a task-scoped WebSocket because simultaneous character-level edits benefit from CRDT convergence. Go stores and relays opaque Yjs updates while PostgreSQL retains a snapshot and ordered deltas.

## Data and scale choices

- Tasks and comments are separate rows; a popular task cannot make a single project document grow without bound.
- Comments use keyset-friendly `(project_id, task_id, created_at, id)` ordering.
- Task queries use stable cursor pagination and selective indexes.
- Project IDs lead multi-tenant indexes and foreign keys enforce isolation.
- Dependency edges use uniqueness, self-edge checks, a project advisory lock, and a recursive reachability check to prevent cycles.
- Event payloads are capped and contain changed entities rather than project snapshots.
- The UI virtualizes rows, memoizes item rendering, and incrementally fetches pages.

The next scale steps are connection pooling, read replicas, topic/table partitioning, a dedicated SSE gateway, and Redis Cluster. Redpanda, Redis, the relay, and the Yjs compactor are already outside the domain transaction path, so API autoscaling does not change task correctness.

## Development without the full stack

The web application defaults to a deterministic in-memory adapter containing 10,000 tasks:

```bash
cd apps/web
npm ci
NEXT_PUBLIC_DATA_SOURCE=mock npm run dev
```

For local processes instead of Compose:

```bash
DATABASE_URL='postgres://taskapp:taskapp@localhost:5432/taskapp?sslmode=disable' go run ./cmd/api
cd apps/web
NEXT_PUBLIC_DATA_SOURCE=api NEXT_PUBLIC_API_BASE_URL=http://localhost:8080 npm run dev
```

Authentication is enabled by default in Compose; set `AUTH_REQUIRED=false` only for a deliberately unauthenticated local demo. New accounts receive a private starter project, and — if the demo/scenario seeds have been loaded — automatic membership in the shared demo projects too; see [Demo path](#demo-path). Signing in as `maya@example.test` with password `password` after loading the demo seed also still works (the credential is for local fixtures only). A project's aggregate data can exceed 2 MB because tasks remain paginated and file bytes are stored separately; task files support common documents and images up to 25 MB each, while the API still rejects a single oversized JSON mutation.

## Object storage

`internal/platform/objectstorage.Open` picks the attachment backend automatically:
`AWS_ACCESS_KEY_ID` set → S3 (MinIO locally via `S3_ENDPOINT`, real AWS S3 in a
deployment that has AWS credentials); unset → Google Cloud Storage over its native
API using Application Default Credentials, no keys involved. Both implementations
satisfy the same `Store` interface (`Put`/`Get`/`Delete`), so the rest of the app
never branches on which one is active. The live deployment uses the GCS path: the
`api` Cloud Run service runs under its own service account with bucket-scoped
`roles/storage.admin`, so there is no S3 credential material anywhere in that
environment.

## Deployment

`deploy/cloudrun/deploy.sh` deploys the whole stack to Google Cloud Run:

- `api` and `web` as autoscaled Cloud Run **Services** (scale-to-zero by default).
- `relay` and `description-compactor` as Cloud Run **Worker Pools** — background,
  non-HTTP, pull-based consumers; worker pools run a fixed instance count rather
  than autoscaling on their own (a real Cloud Run limitation), see the script's
  comments for the Kafka Autoscaler add-on if that's needed later.
- `migrate` as a Cloud Run **Job**, run once per deploy.
- A self-run Cloud SQL for PostgreSQL instance and a Cloud Storage bucket, both
  provisioned by the script (not a managed BaaS) and reached through a dedicated
  runtime service account — no long-lived credentials in Secret Manager beyond the
  database URL and the backing Redis/Kafka credentials.

Redis and the Kafka-compatible broker are expected to already exist as managed
services (Upstash Redis, Redpanda Serverless, or self-hosted equivalents) — the
script does not provision those.

```bash
cp deploy/cloudrun/env.example deploy/cloudrun/env
$EDITOR deploy/cloudrun/env   # GCP project/region, Cloud SQL password, REDIS_URL, REDPANDA_BROKERS, ...
set -a; . deploy/cloudrun/env; set +a
./deploy/cloudrun/deploy.sh
```

Requires `gcloud` (authenticated, billing enabled on the target project) and
Docker. Full prerequisites, defaults, and a couple of environment-specific
gotchas (Cloud SQL edition, `linux/amd64` builds on Apple Silicon, the gRPC
Python dependency some `gcloud` installs are missing) are documented as comments
at the top of the script and inline where they apply.

## Verification

The CI workflow applies migrations to an empty PostgreSQL instance, loads and verifies demo data, exercises a real transactional database flow, creates 10,000 tasks and 1,000 comments, rolls the latest migration down/up, runs Go race tests, lints/typechecks/tests/builds the frontend, validates Compose, and builds all deployable images.

Equivalent focused checks:

```bash
go vet ./cmd/... ./internal/...
go test -race ./cmd/... ./internal/...
go build ./cmd/...

npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web test
NEXT_PUBLIC_DATA_SOURCE=api npm --prefix apps/web run build
```

Set `TEST_DATABASE_URL` to include the PostgreSQL integration test. Set `TEST_API_BASE_URL=http://localhost:8080` to include the browser adapter's live HTTP flow.

## Demo path

Live deployment: **https://web-atujfotjyq-uc.a.run.app**

There's no shared demo login — sign up with your own account like any real user
would (`Create account`, any email/password). Registration always creates two
kinds of access in one step:

- A **private starter workspace** (`"<your name>'s workspace"`), empty, owned
  solely by you.
- Automatic membership in four **shared demo projects** — **Realtime Launch**,
  **Mobile Experience**, **Scale & Scenario Lab** (10,000 tasks), and **Empty
  Sandbox** — every account gets added to the same four, so any two reviewers
  signed up separately land in the same shared space and can collaborate on it
  live. Each one's description is prefixed `[Shared demo project — every new
  account joins this one automatically]` in the UI so it's never ambiguous
  which project is yours alone versus shared.

Steps 1–9 below use **Realtime Launch** unless noted. "Two participants" means
two accounts signed in at once (two browser profiles, or one normal + one
incognito window) — sign up twice with different emails, both land in the same
shared projects automatically.

1. Open two browser windows on the same project.
2. Create and edit a task in one window; observe the compact SSE update in the other.
3. Add a comment and show the remote comment count/feed update.
4. Add and remove a dependency, then attempt a cycle and inspect the domain error.
5. Change status and priority from two stale browser views to show field-level merging, then use the detail-header undo/redo controls.
6. Open the same task in two browser windows and edit its description concurrently to observe Yjs convergence.
7. Submit a stale same-field version to show the `409` conflict response.
8. Mention the other account's `@handle` in a comment and open the notification bell.
9. Switch to **Scale & Scenario Lab** to demonstrate cursor loading and virtualization.
10. With two accounts on the same task, check the presence strip and each other's live selection.
11. Open the activity feed to see the running log of what steps 2–9 just did.
12. Drag a task between columns on the Kanban board to trigger a status transition.
13. Attach a file to a task and download it back.
14. In **Scale & Scenario Lab**, open the task with 2,500 comments to see paginated comment loading; switch to **Empty Sandbox** for the empty-state UI.

## Deliberate boundaries

Sessions contain only a random token whose SHA-256 digest is persisted. Active organization membership is required alongside project roles for every project read and mutation; project owners/admins manage memberships and viewers are read-only, including the live description channel. The seeded `DEFAULT_ACTOR_ID` fallback and arbitrary `X-Actor-ID` overrides are development-only. Malware scanning, distributed rate limiting, and external identity federation remain deployment concerns.
