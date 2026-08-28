# Happy Tasks

A collaboration-first task manager built for the Full Stack Challenge. It demonstrates how a familiar project workspace can stay responsive and consistent when projects grow beyond a few megabytes and several clients edit the same data at once.

The implementation is deliberately practical: a Next.js application, a Go modular monolith, and PostgreSQL. REST handles commands and paginated reads; project-scoped Server-Sent Events (SSE) replay compact, durable changes instead of retransmitting an entire project.

## What is included

- Multiple projects with project creation and a responsive project switcher.
- Task creation, editing, deletion, search, status/priority filters, explicit assignee add/remove controls, tags, custom fields, and optimistic UI.
- Stable user identities, soft membership lifecycle (active/invited/suspended/removed), role enforcement, final-owner protection, paginated member search, and append-only assignment history.
- Dependency creation/removal with transactional cycle prevention.
- Append-oriented comments with cursor-ready indexing and near-real-time delivery.
- Conflict detection through `If-Match` versions and retry-safe writes through idempotency keys.
- Field-level task operation history with actor-scoped undo/redo; independent stale edits (for example status and priority) merge safely.
- Yjs CRDT description editing over a task-scoped WebSocket with durable snapshots, replayable updates, and a searchable text projection.
- Durable, ordered project event streams with reconnect/replay semantics.
- A virtualized task list and cursor-paginated API suitable for 10,000+ tasks.
- Mock mode for isolated UI development and API mode for the integrated product.
- Reversible migrations, deterministic demo/scale seeds, schema verification, CI, container builds, and a k6 scenario.

## Quick start

Prerequisite: Docker with Compose. Ports `3000`, `8080`, and `5432` must be available unless overridden in `.env`.

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

`make db-reset` requires an explicit local-reset guard and never targets an arbitrary database. To remove the retained Compose volume, use `docker compose down --volumes` intentionally.

## Architecture

```text
Next.js 16 + React Query + virtualized list
             | REST reads/writes
             | project SSE stream
             v
Go API (Chi modular monolith)
  projects | tasks | comments | dependencies | sync
             |
             | one transaction: domain write + sync event
             v
PostgreSQL 17
  normalized state | sync_events | idempotency records
             |
             `-- LISTEN/NOTIFY wake-up hint
```

PostgreSQL is the system of record because task transitions, membership, dependencies, comments, idempotency, and event publication benefit from relational constraints and multi-row transactions. `LISTEN/NOTIFY` is only a low-latency hint; a missed notification does not lose data because clients replay `sync_events` after their last sequence.

MongoDB would make flexible task documents convenient, but unbounded embedded comments and dependency consistency would still require separate collections, indexes, and transactions. Cassandra becomes compelling later for very high-volume, append-heavy comment or activity projections, but it is not a good authority for graph-cycle checks and cross-entity invariants in this two-day scope.

The code is separated by responsibility:

- `apps/web/features`: product workflows and query-cache reconciliation.
- `apps/web/components/ui`: reusable design-system primitives.
- `apps/web/lib/api`: mock and HTTP adapters behind one `WorkspaceApi` contract.
- `internal/domain`: domain types and validation.
- `internal/app`: use cases and transactional orchestration.
- `internal/platform/database`: PostgreSQL implementation.
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

The first scale step is read replicas, connection pooling, table partitioning, and a dedicated SSE tier reading the same durable log. A broker can later fan out wake-ups without changing correctness. Cassandra is an optional projection store only when measured comment/activity traffic warrants a separately optimized write path.

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

## Verification

The CI workflow applies migrations to an empty PostgreSQL instance, loads and verifies demo data, exercises a real transactional database flow, creates 10,000 tasks and 1,000 comments, rolls the latest migration down/up, runs Go race tests, lints/typechecks/tests/builds the frontend, validates Compose, and builds all deployable images.

Equivalent focused checks:

```bash
go vet ./cmd/... ./internal/...
go test -race ./cmd/... ./internal/...
go build -o /tmp/happy-task-api ./cmd/api

npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web test
NEXT_PUBLIC_DATA_SOURCE=api npm --prefix apps/web run build
```

Set `TEST_DATABASE_URL` to include the PostgreSQL integration test. Set `TEST_API_BASE_URL=http://localhost:8080` to include the browser adapter's live HTTP flow.

## Demo path

1. Open two browser windows on the same project.
2. Create and edit a task in one window; observe the compact SSE update in the other.
3. Add a comment and show the remote comment count/feed update.
4. Add and remove a dependency, then attempt a cycle and inspect the domain error.
5. Change status and priority from two stale browser views to show field-level merging, then use the detail-header undo/redo controls.
6. Open the same task in two browser windows and edit its description concurrently to observe Yjs convergence.
7. Submit a stale same-field version to show the `409` conflict response.
8. Switch to the seeded scale project to demonstrate cursor loading and virtualization.

## Deliberate boundaries

Authentication is represented locally by the seeded `DEFAULT_ACTOR_ID`; arbitrary `X-Actor-ID` overrides are ignored unless `ALLOW_DEMO_ACTOR_OVERRIDE=true` is explicitly enabled for local multi-actor tests. `user_identities` provides the stable provider/subject boundary for a production OIDC/JWT gateway without coupling the take-home to an auth vendor. Presence, live cursors, comment reactions, global search, and broker-backed fan-out remain documented extension points. The description CRDT is already isolated behind its WebSocket/document tables, so those additions do not force a rewrite of the core task model.
