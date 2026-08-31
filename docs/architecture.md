# Collaborative Task Management System - Technical Design

**Status:** Implemented baseline for the take-home; production hardening seams are called out below.

**Backend:** Go

**Frontend:** Next.js (App Router)

**Primary database:** PostgreSQL

**Last updated:** 2026-08-29

## 1. Executive summary

Build a collaborative task-management application in which users create projects, manage tasks, model task dependencies and status transitions, and comment on tasks. Changes made in one client appear in other clients in near real time without retransmitting an entire project.

The implementation is a **modular monolith**, not a collection of microservices. The Go API owns domain rules, persistence, transactions, and synchronization. The Next.js application owns presentation, local interaction state, optimistic UI, and reconciliation of server events. PostgreSQL is the source of truth.

Each successful project mutation writes both the new domain state and a compact synchronization event in one database transaction. Competing relay replicas publish the transactional outbox to Redpanda, keyed by project, and a consumer group uses Redis for cross-instance last-mile fan-out. A project-scoped SSE endpoint still replays PostgreSQL events after a client's acknowledged sequence, so broker or Redis loss degrades latency rather than correctness.

The Go domain remains a modular monolith, while delivery concerns are separate deployables. API replicas hold no authoritative collaboration state: PostgreSQL owns relational truth, Redpanda owns replicated delivery, and Redis owns disposable awareness and local fan-out.

## 2. Requirements distilled from the assignment

### 2.1 Required capabilities

- Create and list multiple projects.
- Create, update, list, and delete tasks within a project.
- Store task title, status, assignees, priority, description, tags, custom fields, and dependencies.
- Enforce dependency and status-transition rules consistently.
- Add and view task comments.
- Propagate changes to other clients in near real time.
- Maintain consistency across clients.
- Avoid Firebase, Supabase, and other managed real-time databases.
- Avoid retransmitting whole project payloads as projects grow beyond 2 MB.

### 2.2 Chosen extended challenges

The two-day build targets the highest-signal portions of:

- **Performance and scale:** cursor pagination, virtualized rendering, indexes, a 10,000-task seed, and a repeatable load test.
- **Developer experience:** tests, CI, OpenAPI, generated contract types, migrations, seed data, Docker, and a clean README.
- **Advanced collaboration:** actor-scoped metadata undo/redo, a Yjs description document, unique-user task presence and selection awareness, activity, and @mention notifications.
- **Open-ended extension:** dependency graph visualization and a native drag-and-drop Kanban board.

### 2.3 Bonus-point mapping

| Bonus | Two-day implementation | Later extension |
| --- | --- | --- |
| Undo/redo | Actor-scoped field-level inverse operations for task metadata | General command history for deletes/dependencies |
| OT/CRDT-inspired collaboration | Yjs-backed description document over a separate WebSocket channel | Rich block editing |
| Event-based backend | Transactional `sync_events` outbox relayed to Redpanda | Dedicated gateway tier |
| Clear domain model | Explicit Go domain services and database constraints | Extract only when scale requires it |
| Type-safe API contract | OpenAPI as source of truth; generated Go and TypeScript types | Versioned public API SDKs |
| Optimistic UI and rollback | Tasks, status changes, and comments; an IndexedDB-backed offline mutation queue replays in order on reconnect | General conflict-resolution UI beyond version/field merging |
| Database transactions | Domain mutation, idempotency record, and event written atomically | Distributed workflows via outbox consumers |
| Caching strategy | Browser query cache, PostgreSQL buffer cache, an actor-scoped Redis cache of each task's first comment page (invalidated on the author's own writes, short TTL otherwise) | Cached reaction summaries; read replicas for older pages |
| Rate limiting/backpressure | Per-instance token buckets, payload limits, bounded queues | Edge/Redis global limits |

The implementation does not call ordinary version-conflict handling a CRDT. CRDTs solve a different problem and are used only for the description field, where automatic concurrent character-level merging is valuable.

## 3. Goals and non-goals

### 3.1 Goals

- A complete vertical slice that remains correct across concurrent clients, disconnects, and retries.
- Compact entity-level updates rather than project-level refreshes.
- Deterministic, project-local event ordering and replay.
- Domain invariants enforced on the server and backed by database constraints where possible.
- Fast browsing of projects containing at least 10,000 tasks.
- Clear ownership boundaries between UI, transport, application orchestration, domain logic, and storage.
- A clean local setup and evidence-backed performance claims.
- An evolution path that does not require rewriting the domain model.

### 3.2 Non-goals for the two-day build

- Billing, organization administration UI, or granular RBAC beyond organization membership plus project roles.
- ~~Offline-first mutation queues~~ — added since: task creates/updates/deletes now queue in IndexedDB while offline and replay in order on reconnect, conflicts kept visible rather than silently dropped. The two-day build's non-goal was just an installable shell and safe offline fallback.
- General-purpose event sourcing. Current relational rows remain authoritative.
- General-purpose rich-text/block CRDT beyond the description document.
- Kubernetes and multi-region active-active writes.
- Full-text search, arbitrary workflow builders, Gantt charts, and external integrations.
- Perfect fairness for a single project with extreme write contention.

These are conscious scope choices, not architectural dead ends.

## 4. Architecture

```text
Browser
  Next.js App Router
  - UI and routing
  - TanStack Query cache
  - optimistic updates/rollback
  - SSE reconciliation
          |
          | REST/JSON commands and cursor queries
          | project-scoped SSE event stream
          v
Stateless Go API replicas
  - HTTP transport and generated contracts
  - application services/use cases
  - domain policies
  - repositories/transactions
  - local bounded connection hubs
          |
          | SQL transaction
          v
PostgreSQL
  - normalized current state
  - idempotency records
  - per-project stream sequence
  - durable append-only sync_events
          |
          `-> outbox relay -> Redpanda -> Redis -> every API replica
```

The same shape, visually, with the deployment topology (which pieces are autoscaled Cloud Run Services vs. fixed-count Worker Pools) and the resilience path made explicit:

<p align="center">
<svg viewBox="0 0 1200 830" width="100%" role="img" aria-label="Architecture diagram: a browser sends REST commands to a Go API on Cloud Run, which writes domain state and an outbox event to Postgres in one transaction. A relay worker pool publishes that outbox to Redpanda and fans it out through Redis back to API replicas, which push it to clients over SSE and WebSocket. A dashed path lets clients replay missed events straight from Postgres if the broker path is unavailable. A description-compactor worker pool bounds the Yjs update log, and the API writes attachment bytes to Cloud Storage.">
<rect x="0" y="0" width="1200" height="830" fill="#FAFAF9"/>
<defs>
<marker id="arch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="#3F3F46"/>
</marker>
<marker id="arch-arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="#4F46E5"/>
</marker>
</defs>
<rect x="150" y="150" width="900" height="130" rx="12" fill="none" stroke="#4F46E5" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.55"/>
<text x="168" y="172" font-family="monospace" font-size="11" letter-spacing="1" fill="#4F46E5">CLOUD RUN SERVICES &#183; AUTOSCALE 0&#8594;N</text>
<rect x="150" y="470" width="900" height="120" rx="12" fill="none" stroke="#047857" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.55"/>
<text x="168" y="492" font-family="monospace" font-size="11" letter-spacing="1" fill="#047857">CLOUD RUN WORKER POOLS &#183; FIXED INSTANCE COUNT</text>
<rect x="150" y="640" width="900" height="120" rx="12" fill="none" stroke="#B45309" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.55"/>
<text x="168" y="662" font-family="monospace" font-size="11" letter-spacing="1" fill="#B45309">MANAGED DATA &amp; MESSAGING</text>
<rect x="420" y="20" width="300" height="86" rx="10" fill="#FFFFFF" stroke="#18181B" stroke-width="1.5"/>
<text x="570" y="46" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="16" fill="#18181B">Browser</text>
<text x="570" y="66" text-anchor="middle" font-family="monospace" font-size="10.5" fill="#71717A">Next.js App Router &#183; React Query</text>
<text x="570" y="80" text-anchor="middle" font-family="monospace" font-size="10.5" fill="#71717A">Yjs client &#183; service worker + IndexedDB</text>
<rect x="800" y="30" width="200" height="66" rx="9" fill="#EEF2FF" stroke="#4F46E5" stroke-width="1.2"/>
<text x="900" y="55" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="13" fill="#18181B">web</text>
<text x="900" y="72" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">Cloud Run Service &#183; app shell</text>
<line x1="800" y1="63" x2="722" y2="63" stroke="#3F3F46" stroke-width="1.3" marker-end="url(#arch-arrow)" opacity="0.75"/>
<text x="761" y="55" text-anchor="middle" font-family="monospace" font-size="9" fill="#71717A">serves page</text>
<line x1="540" y1="106" x2="540" y2="150" stroke="#3F3F46" stroke-width="1.5" marker-end="url(#arch-arrow)"/>
<text x="440" y="128" text-anchor="end" font-family="monospace" font-size="10.5" fill="#18181B">REST: commands,</text>
<text x="440" y="141" text-anchor="end" font-family="monospace" font-size="10.5" fill="#18181B">cursor-paginated reads</text>
<line x1="605" y1="150" x2="605" y2="106" stroke="#4F46E5" stroke-width="2" marker-end="url(#arch-arrow-accent)"/>
<text x="628" y="128" font-family="monospace" font-size="10.5" fill="#4F46E5">SSE + WS:</text>
<text x="628" y="141" font-family="monospace" font-size="10.5" fill="#4F46E5">live updates</text>
<rect x="430" y="188" width="320" height="72" rx="10" fill="#EEF2FF" stroke="#4F46E5" stroke-width="1.8"/>
<text x="590" y="214" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="15" fill="#18181B">api &#183; Go</text>
<text x="590" y="232" text-anchor="middle" font-family="monospace" font-size="10" fill="#71717A">HTTP transport &#183; domain policy &#183; idempotency</text>
<text x="590" y="246" text-anchor="middle" font-family="monospace" font-size="10" fill="#71717A">rate limiter &#183; actor-scoped comment cache</text>
<rect x="800" y="195" width="200" height="58" rx="9" fill="#FFFBEB" stroke="#B45309" stroke-width="1.2"/>
<text x="900" y="219" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="12.5" fill="#18181B">Cloud Storage</text>
<text x="900" y="235" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">task file attachments</text>
<line x1="750" y1="224" x2="800" y2="224" stroke="#3F3F46" stroke-width="1.3" marker-end="url(#arch-arrow)" opacity="0.75"/>
<text x="775" y="215" text-anchor="middle" font-family="monospace" font-size="9" fill="#71717A">bytes</text>
<line x1="590" y1="260" x2="590" y2="310" stroke="#4F46E5" stroke-width="2.5" marker-end="url(#arch-arrow-accent)"/>
<text x="606" y="288" font-family="monospace" font-size="10.5" font-weight="600" fill="#4F46E5">1 transaction: domain write + outbox event</text>
<rect x="410" y="310" width="360" height="94" rx="10" fill="#FFFFFF" stroke="#18181B" stroke-width="1.8"/>
<text x="590" y="334" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="15" fill="#18181B">PostgreSQL &#183; Cloud SQL</text>
<text x="590" y="353" text-anchor="middle" font-family="monospace" font-size="10" fill="#71717A">tasks &#183; comments &#183; dependencies</text>
<text x="590" y="368" text-anchor="middle" font-family="monospace" font-size="10" fill="#71717A">sync_events outbox &#183; idempotency keys</text>
<text x="590" y="393" text-anchor="middle" font-family="monospace" font-size="9.5" font-weight="600" fill="#4F46E5">&#8212; the source of truth &#8212;</text>
<path d="M 410 350 C 300 350, 300 240, 428 218" fill="none" stroke="#71717A" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#arch-arrow)"/>
<text x="210" y="270" font-family="monospace" font-size="9.5" fill="#71717A">replay by sequence on reconnect &#8212;</text>
<text x="210" y="282" font-family="monospace" font-size="9.5" fill="#71717A">correct even if the loop below is down</text>
<path d="M 500 404 L 500 440 L 300 440 L 300 470" fill="none" stroke="#047857" stroke-width="1.8" marker-end="url(#arch-arrow)"/>
<text x="316" y="452" font-family="monospace" font-size="10" fill="#047857">poll outbox, 100/batch</text>
<path d="M 680 404 L 680 440 L 895 440 L 895 470" fill="none" stroke="#047857" stroke-width="1.6" marker-end="url(#arch-arrow)"/>
<text x="712" y="452" font-family="monospace" font-size="10" fill="#047857">compact Yjs update log</text>
<rect x="190" y="500" width="260" height="66" rx="10" fill="#ECFDF5" stroke="#047857" stroke-width="1.8"/>
<text x="320" y="524" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="14" fill="#18181B">relay</text>
<text x="320" y="541" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">publishes outbox &#183; consumer-group</text>
<text x="320" y="554" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">fan-out to Redis</text>
<rect x="765" y="500" width="260" height="66" rx="10" fill="#ECFDF5" stroke="#047857" stroke-width="1.8"/>
<text x="895" y="524" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="14" fill="#18181B">description-compactor</text>
<text x="895" y="541" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">bounds Yjs snapshot growth</text>
<text x="895" y="554" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">for live description editing</text>
<line x1="290" y1="566" x2="290" y2="640" stroke="#4F46E5" stroke-width="2" marker-end="url(#arch-arrow-accent)"/>
<text x="306" y="606" font-family="monospace" font-size="10" fill="#4F46E5">publish</text>
<rect x="190" y="668" width="260" height="62" rx="10" fill="#FFFBEB" stroke="#B45309" stroke-width="1.8"/>
<text x="320" y="692" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="13.5" fill="#18181B">Redpanda Serverless</text>
<text x="320" y="710" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">durable, Kafka-compatible log</text>
<line x1="450" y1="699" x2="765" y2="699" stroke="#4F46E5" stroke-width="2" marker-end="url(#arch-arrow-accent)"/>
<text x="608" y="691" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#4F46E5">relay consumer group: cross-instance fan-out</text>
<rect x="765" y="668" width="260" height="62" rx="10" fill="#FFFBEB" stroke="#B45309" stroke-width="1.8"/>
<text x="895" y="692" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="13.5" fill="#18181B">Upstash Redis</text>
<text x="895" y="710" text-anchor="middle" font-family="monospace" font-size="9.5" fill="#71717A">ephemeral fan-out &#183; presence &#183; comment cache</text>
<path d="M 1025 699 C 1110 699, 1110 224, 750 224" fill="none" stroke="#4F46E5" stroke-width="2.2" marker-end="url(#arch-arrow-accent)"/>
<text x="1060" y="470" text-anchor="middle" font-family="monospace" font-size="10" fill="#4F46E5" transform="rotate(-90 1060 470)">subscribe: every API replica wakes</text>
</svg>
</p>

The loop that matters: a mutation is never "sent" to other clients directly — it is committed once to Postgres, and every connected replica discovers it independently, either through the indigo fan-out path (fast) or by replaying Postgres directly (always correct, even if Redpanda or Redis is degraded).

### 4.1 Why a modular monolith

The Go API remains a modular monolith for domain rules and transactions. A small relay is a separate deployable because broker delivery has a different lifecycle, not because business logic was split into services. It publishes only committed outbox rows, so domain handlers and clients do not depend on Redpanda availability.

### 4.2 Runtime components

| Component | Responsibility | Must not own |
| --- | --- | --- |
| Next.js web | Rendering, navigation, forms, optimistic cache updates, event reconciliation | Domain authority or direct database access |
| Go HTTP transport | Decode/validate protocol inputs, auth context, map errors, serialize responses | SQL and business decisions |
| Go application services | Coordinate use cases and transaction boundaries | HTTP details and UI state |
| Go domain packages | Status policies, dependency rules, entity validation | Database drivers and framework types |
| Go repositories | Typed SQL and persistence mapping | User-facing error semantics |
| Synchronization module | Allocate stream sequence, append/replay events, manage SSE clients | Mutating domain state independently |
| PostgreSQL | Authoritative state, constraints, atomicity, durable event history | Real-time socket lifecycle |

## 5. Repository and module boundaries

Recommended layout:

```text
.
├── api/
│   └── openapi.yaml
├── apps/
│   └── web/
│       ├── app/
│       ├── components/
│       ├── features/
│       │   ├── projects/
│       │   ├── tasks/
│       │   ├── comments/
│       │   └── activity/
│       ├── lib/
│       │   ├── api/generated/
│       │   ├── query/
│       │   └── realtime/
│       └── tests/
├── cmd/
│   └── api/main.go
├── internal/
│   ├── app/
│   ├── project/
│   ├── task/
│   ├── comment/
│   ├── syncstream/
│   ├── idempotency/
│   ├── platform/
│   │   ├── database/
│   │   ├── httpserver/
│   │   ├── logging/
│   │   └── telemetry/
│   └── transport/httpapi/
├── db/
│   ├── migrations/
│   ├── queries/
│   └── seed/
├── deploy/
│   └── docker-compose.yml
├── scripts/
│   └── load/
├── docs/
│   └── architecture.md
├── go.mod
└── Makefile
```

### 5.1 Backend package rules

- `internal/task`, `internal/project`, and `internal/comment` contain domain types, errors, and policies.
- `internal/app` exposes use cases such as `CreateTask`, `ChangeTaskStatus`, and `AddDependency`.
- Repositories are interfaces defined near the use case that consumes them; PostgreSQL implementations live under `platform/database`.
- `transport/httpapi` depends on application interfaces, never on concrete SQL repositories.
- Domain packages do not import HTTP, PostgreSQL, logging, or generated OpenAPI packages.
- A transaction manager passes transaction-scoped repositories to a closure, keeping atomic boundaries visible.
- SQL is checked in and generated with `sqlc`; `pgx` provides pooling and driver access.

### 5.2 Frontend boundaries

The focused [UI design](./ui-design.md) defines the design-system choice,
workspace layout, responsive behavior, product components, synchronization
states, and implementation order. This section defines only architectural
ownership boundaries.

- Route segments compose features but do not perform raw `fetch` calls.
- A generated API client is the only REST transport layer.
- TanStack Query owns server state. Local component state owns unfinished form inputs and transient UI state.
- Feature hooks (`useTasks`, `useUpdateTask`, `useProjectEvents`) translate contracts into UI behavior.
- The real-time reconciler only writes to or invalidates query-cache entries. It does not render UI.
- Presentational components receive values and callbacks; they do not know endpoint paths.
- Filters, sorting, and selected project/task live in URL state when shareable.
- No global client-state library is introduced unless a real non-server state need appears.

## 6. Domain model and relational schema

The focused [database design](./database-design.md) expands the storage model,
comment pagination, optional reactions, consistency choices, and the hot-task
scaling path. This section remains the system-level summary.

Use UUIDv7 identifiers for externally created entities because they are client-generatable and roughly time ordered. Use `bigint` only for project-local stream sequences. All timestamps are UTC `timestamptz` generated by PostgreSQL.

### 6.1 Core tables

#### `users`

```text
id uuid primary key
display_name text not null
email citext unique not null
created_at timestamptz not null
```

The take-home uses seeded demo users and a clearly labeled development identity
selector. Local requests resolve to `DEFAULT_ACTOR_ID`; arbitrary
`X-Actor-ID` overrides are ignored unless `ALLOW_DEMO_ACTOR_OVERRIDE=true` is
explicitly enabled for multi-actor tests. The `user_identities`
provider/subject table is the seam for a verified OIDC/JWT gateway in
production, without coupling the assignment to an auth vendor.

Authentication is enabled by default in Compose with bcrypt password hashes and
random HttpOnly session cookies. `AUTH_REQUIRED=false` is reserved for a
deliberately unauthenticated local demo; the seeded actor fallback remains
explicitly local-only. New accounts receive an organization membership and a
starter project.

#### Organizations and files

`organizations` and `organization_members` sit beneath the existing
`project_members` roles. Every project belongs to one organization, and all
project reads, project creation, and membership invitations require an active
organization membership. `task_attachments` stores file metadata and a
SHA-256 checksum while the binary lives in MinIO locally, and in a deployment
lives in either S3 or Google Cloud Storage depending on which credentials are
configured (`internal/platform/objectstorage.Open` picks the backend; see the
root README's Object storage section).
Each upload records a delayed cleanup intent before writing the object and
cancels it inside the attachment metadata transaction. Attachment and task
deletes enqueue object removal through a database trigger. API replicas lease
and retry those idempotent deletion jobs, covering request failures, process
crashes, cascades, and temporary object-store outages. The 25 MB
per-file limit is enforced by the transport, service, and database; a project
can still grow beyond 2 MB because task pages and event payloads remain
bounded.

#### `projects`

```text
id uuid primary key
name text not null
description text not null default ''
metadata jsonb not null default '{}'
version bigint not null default 1
created_at timestamptz not null
updated_at timestamptz not null
```

#### `project_members`

```text
project_id uuid not null references projects(id) on delete cascade
user_id uuid not null references users(id)
role text not null
primary key (project_id, user_id)
```

This makes assignee and future authorization validation explicit.

Migration 00011 adds a stable membership ID, role (`OWNER`, `ADMIN`, `MEMBER`,
`VIEWER`), lifecycle (`ACTIVE`, `INVITED`, `SUSPENDED`, `REMOVED`), timestamps,
and a version for `If-Match` guarded lifecycle changes. Removal is soft so
comments and assignment history keep their original identity. Reads and writes
require an active user plus active membership; the final active owner cannot be
removed, suspended, or demoted.

#### `tasks`

```text
id uuid primary key
project_id uuid not null references projects(id) on delete cascade
title text not null
description text not null default ''
status task_status not null
priority task_priority not null
custom_fields jsonb not null default '{}'
version bigint not null default 1
created_by uuid not null references users(id)
created_at timestamptz not null
updated_at timestamptz not null
unique (project_id, id)
```

Use small PostgreSQL enums for stable, reviewed workflow values in the take-home. If workflows become user-configurable, migrate status and transitions to tables without changing the task API shape.

#### `task_assignees`

```text
project_id uuid not null
task_id uuid not null
user_id uuid not null
primary key (task_id, user_id)
foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
foreign key (project_id, user_id) references project_members(project_id, user_id)
```

This table is the current assignment projection. Assignment additions and
removals are appended to `task_assignment_operations` with actor, request ID,
stable membership ID, and server time in the same transaction. Membership
removal removes current assignments and appends `UNASSIGNED` operations while
incrementing affected task versions, keeping stale clients from overwriting
the cleanup.

#### `task_tags`

```text
project_id uuid not null
task_id uuid not null
tag text not null
primary key (task_id, tag)
foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
```

Tags are normalized because they are filtered and indexed. Arbitrary low-query metadata remains JSONB.

#### `task_dependencies`

An edge `(task_id, depends_on_task_id)` means the first task is blocked by the second.

```text
project_id uuid not null
task_id uuid not null
depends_on_task_id uuid not null
created_by uuid not null references users(id)
created_at timestamptz not null
primary key (task_id, depends_on_task_id)
check (task_id <> depends_on_task_id)
foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
foreign key (project_id, depends_on_task_id) references tasks(project_id, id) on delete cascade
```

Including `project_id` in both foreign keys makes cross-project edges impossible even if application validation is bypassed.

#### `comments`

```text
id uuid primary key
project_id uuid not null
task_id uuid not null
parent_id uuid
content text not null
author_id uuid not null references users(id)
created_at timestamptz not null
updated_at timestamptz
version bigint not null default 1
unique (project_id, id)
unique (project_id, task_id, id)
foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
foreign key (project_id, task_id, parent_id) references comments(project_id, task_id, id)
```

The UI supports nested add/list threads. The composite self-reference keeps
replies on the same task, while immutable parent links prevent cycles. The
schema leaves room for edit and soft deletion without changing identifiers or
breaking descendant placement.

### 6.2 Synchronization and retry tables

#### `project_streams`

```text
project_id uuid primary key references projects(id) on delete cascade
last_sequence bigint not null default 0
```

#### `sync_events`

```text
project_id uuid not null
sequence bigint not null
event_type text not null
aggregate_type text not null
aggregate_id uuid not null
aggregate_version bigint
actor_id uuid
request_id uuid not null
payload jsonb not null
occurred_at timestamptz not null
primary key (project_id, sequence)
unique (request_id)
```

`sync_events` is an integration/change stream, not the source of domain state. Payloads are compact client projections, tombstones, or entity references.

#### `idempotency_keys`

```text
actor_id uuid not null
idempotency_key text not null
request_hash bytea not null
response_status integer not null
response_body jsonb not null
created_at timestamptz not null
expires_at timestamptz not null
primary key (actor_id, idempotency_key)
```

Reusing a key with a different request hash returns `409 IDEMPOTENCY_KEY_REUSED`.

### 6.3 Indexes

Initial indexes are tied to demonstrated queries:

```text
tasks(project_id, updated_at desc, id desc)
tasks(project_id, status, updated_at desc, id desc)
task_assignees(project_id, user_id, task_id)
task_tags(project_id, tag, task_id)
task_dependencies(project_id, task_id)
task_dependencies(project_id, depends_on_task_id)
comments(project_id, task_id, created_at asc, id asc)
sync_events(project_id, sequence)
sync_events(occurred_at)
idempotency_keys(expires_at)
```

Use `EXPLAIN (ANALYZE, BUFFERS)` against the 10,000-task seed before adding more indexes. Every index increases write cost, so speculative indexes are avoided.

## 7. API contract

OpenAPI 3.1 is checked in as the protocol source of truth. Generate Go request/response types and handler interfaces with `oapi-codegen`, and TypeScript types/client bindings with `openapi-typescript`. CI fails when generated output is stale.

All entity routes are nested below a project even when IDs are globally unique. This makes project isolation visible and ensures every repository query includes `project_id`.

### 7.1 Primary endpoints

```text
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/{projectId}
PATCH  /v1/projects/{projectId}

GET    /v1/projects/{projectId}/bootstrap
GET    /v1/projects/{projectId}/tasks
POST   /v1/projects/{projectId}/tasks
GET    /v1/projects/{projectId}/tasks/{taskId}
PATCH  /v1/projects/{projectId}/tasks/{taskId}
DELETE /v1/projects/{projectId}/tasks/{taskId}

POST   /v1/projects/{projectId}/tasks/{taskId}/dependencies
DELETE /v1/projects/{projectId}/tasks/{taskId}/dependencies/{dependencyTaskId}

GET    /v1/projects/{projectId}/tasks/{taskId}/comments
POST   /v1/projects/{projectId}/tasks/{taskId}/comments

GET    /v1/projects/{projectId}/activity
GET    /v1/projects/{projectId}/events

GET    /health/live
GET    /health/ready
GET    /metrics
```

### 7.2 Query conventions

- List endpoints use opaque keyset cursors, never offset pagination.
- Default page size is 50; maximum is 200.
- Task order is stable, for example `(updated_at DESC, id DESC)`.
- Filters include status, assignee, and tag. Unsupported combinations return a clear `400` rather than silently scanning.
- Responses return `{ items, nextCursor }`.
- `bootstrap` returns project details, the first task page, lightweight member data, and a `streamCursor` captured in the same repeatable-read transaction.
- Comments are lazy-loaded per task and separately paginated.

### 7.3 Mutation conventions

- Every mutation accepts `Idempotency-Key` and `X-Request-ID` headers.
- Updates/deletes require `If-Match: \"<version>\"`.
- Successful updates increment the entity version once.
- `409 VERSION_CONFLICT` returns the current server projection and version so the UI can reconcile.
- Domain violations such as an invalid status transition or dependency cycle return `422` with stable machine-readable codes.
- Validation errors include a list of field paths and messages.
- Errors use one shape:

```json
{
  "error": {
    "code": "DEPENDENCY_CYCLE",
    "message": "Adding this dependency would create a cycle.",
    "requestId": "...",
    "details": {}
  }
}
```

### 7.4 Payload discipline

- A normal event contains the changed entity projection, project sequence, type, ID, and version.
- A typical event target is under 10 KB; the server enforces a hard 64 KB event payload limit.
- If a changed entity exceeds that limit, emit a reference event and let clients fetch `/tasks/{id}`.
- Deletions emit only an ID, type, version/tombstone, and sequence.
- No mutation or synchronization event includes the complete project or complete task collection.

## 8. Transaction and event data flow

### 8.1 Mutation path

```text
1. Client applies an optimistic cache patch.
2. Client sends REST mutation with Idempotency-Key and If-Match.
3. HTTP layer validates shape and builds actor/request context.
4. Application service begins a database transaction.
5. Service checks idempotency and domain invariants.
6. Repository updates normalized state using expected version.
7. Service increments project_streams.last_sequence atomically.
8. Service inserts sync_events(project_id, sequence, ...).
9. Service stores the idempotent response.
10. Commit makes state, response, and event visible together.
11. HTTP returns the canonical entity and sequence.
12. Relay replicas claim the committed outbox row and publish it to Redpanda.
13. A consumer group forwards the event through Redis to every API replica.
14. Every client applies the event if its sequence/version is newer.
```

The `project_streams` row is incremented near the end of each mutation. Its row lock serializes only stream allocation for one project. A second transaction cannot allocate the next project sequence until the previous allocation commits, so replay order matches commit visibility. Unrelated projects remain fully concurrent.

### 8.2 Initial load without a lost-update window

1. Client requests `/bootstrap`.
2. The server opens a read-only repeatable-read transaction.
3. It reads `project_streams.last_sequence`, project data, and the first task page from one snapshot.
4. Response includes that `streamCursor`.
5. Client connects to `/events?after=<streamCursor>`.
6. The server first replays durable events after the cursor, then stays open for live events.

Any mutation committed after the bootstrap snapshot has a greater project sequence and is replayed. A mutation visible inside the snapshot is already represented in the returned rows. This prevents both gaps and project-level refetches.

## 9. Real-time transport and replay

### 9.1 SSE decision

Use SSE for the initial synchronization channel because application writes already use REST and the remaining traffic is one-way server-to-client. SSE is simpler to operate, inspect, reconnect, and demonstrate than a bidirectional WebSocket protocol. It works over normal HTTP and naturally supports event IDs and heartbeats.

Use a fetch-based SSE client so headers, explicit cursors, response status, and `AbortSignal` are controllable. In production, same-site cookie authentication avoids exposing credentials in URLs.

WebSockets carry only the high-frequency description CRDT channel; durable task metadata still uses REST plus SSE. Ephemeral presence and cursors can be added as another isolated room without complicating durable task mutation delivery.

### 9.2 SSE event envelope

```text
id: 1842
event: task.updated
data: {
  "projectId": "...",
  "sequence": 1842,
  "aggregate": { "type": "task", "id": "...", "version": 7 },
  "payload": { ...compact task projection... },
  "occurredAt": "...",
  "requestId": "..."
}
```

Sequence numbers are local to a project because the endpoint is project scoped. The client stores only the highest consecutively applied sequence for the active project.

### 9.3 Reconnect and replay

- Client reconnects with the last applied sequence using exponential backoff plus jitter, starting around 250 ms and capped around 10 seconds.
- Server queries `sync_events WHERE project_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3` before joining the live tail.
- To avoid a replay-to-live race, the handler registers a bounded wake-up subscription before replay, captures the current stream high-water mark, replays through that mark, then queries once more before waiting. Notifications only prompt another durable query; they are never treated as the event itself.
- Clients discard duplicate sequences and ignore entity payloads older than the cached entity version.
- Events are applied in sequence. A detected gap pauses application and requests replay from the last contiguous sequence.
- Heartbeat comments are sent every 15 seconds to keep intermediaries from closing idle streams.
- Events are retained for at least 24 hours in the take-home. Cleanup is time based and records each project's oldest available sequence.
- The initial activity feed is explicitly a recent-activity view over this window. A production audit history uses a separately retained projection rather than coupling audit retention to synchronization replay.
- If the requested sequence is older than retention, the endpoint returns `409 REPLAY_WINDOW_EXPIRED`; the client clears project-scoped cache, re-runs bootstrap, and reconnects from its new cursor.

### 9.4 Redpanda delivery is not the transaction authority

`sync_events` is a transactional outbox. Competing relay replicas use `FOR UPDATE SKIP LOCKED`, while a per-project predecessor check prevents later events from overtaking an unpublished earlier sequence. Publishing can duplicate after a crash between broker acknowledgement and the database marker; consumers discard duplicates by project sequence.

The distributor consumer group publishes broker messages to Redis for cross-instance fan-out. Lost or coalesced last-mile messages do not lose data because:

- reconnect always reads from `sync_events`;
- instances periodically poll for outstanding sequences while subscribers exist;
- a process restart starts from each subscriber's cursor, not process memory.

Without Redpanda or Redis, the API retains the PostgreSQL polling and `LISTEN/NOTIFY` fallback used for local development.

### 9.5 Backpressure

- Each SSE connection has a bounded queue, for example 256 events or 1 MB, whichever comes first.
- The hub never blocks a mutation handler or database listener on a slow client.
- On overflow, the server emits `system.resync_required` when possible and closes the stream.
- The client reconnects from its last successfully applied sequence; durable replay recovers the gap.
- Replay is paged and capped per response loop to prevent one reconnect from monopolizing memory.
- Limit concurrent SSE streams per demo identity/IP.

## 10. Consistency, concurrency, and idempotency

### 10.1 Consistency model

- PostgreSQL current-state rows are authoritative.
- A successful HTTP response means both the domain change and synchronization event committed.
- Clients are eventually consistent within the propagation delay, normally below one second locally.
- Mutations use optimistic concurrency per entity rather than holding user-facing locks.
- Project event order is deterministic; there is intentionally no global order across projects.

### 10.2 Version conflicts

Updates use a single conditional statement:

```sql
UPDATE tasks
SET title = $1, version = version + 1, updated_at = now()
WHERE project_id = $2 AND id = $3 AND version = $4
RETURNING *;
```

No returned row means missing entity or stale version; a scoped read distinguishes `404` from `409`. The UI rolls back its optimistic patch, shows the latest server value, and lets the user retry deliberately. Silent last-write-wins is not used for mutable task fields.

### 10.3 Request retries

- Create operations use client-generated UUIDv7 IDs and idempotency keys.
- All mutations store the request hash and canonical response under the actor/key in the same transaction.
- An identical retry returns the stored response without creating another event.
- The idempotency TTL is 24 hours for the take-home, cleaned by a bounded background job.
- Client retry policy retries connection failures and selected `5xx` responses, never domain `4xx` responses.

### 10.4 Optimistic UI

For each mutation the web client:

1. cancels affected queries;
2. stores previous cached values;
3. applies an optimistic entity-level patch with a pending marker;
4. sends the request;
5. replaces optimistic data with the canonical response; or
6. restores the previous values and displays a targeted error.

When the originating client later receives its event, `requestId`, sequence, and entity version make the event a harmless confirmation rather than a second change.

## 11. Domain invariants

### 11.1 Status transitions

Define an explicit policy in the task domain package and test it as a table:

```text
TODO        -> IN_PROGRESS, BLOCKED
IN_PROGRESS -> TODO, BLOCKED, DONE
BLOCKED     -> TODO, IN_PROGRESS
DONE        -> IN_PROGRESS
```

The exact graph is a product choice and can be adjusted, but all entry points call the same policy. The database enum restricts values; the domain service restricts edges.

### 11.2 Dependency-cycle enforcement

Adding `A depends on B` must reject:

- `A == B`;
- either task outside the route project;
- a duplicate edge; and
- any path where `B` already depends directly or transitively on `A`.

Algorithm inside one transaction:

1. Acquire a project-scoped transaction advisory lock dedicated to dependency graph writes.
2. Confirm both task rows exist in that project.
3. Run a recursive CTE from `B` following `depends_on_task_id`.
4. If the traversal reaches `A`, return `422 DEPENDENCY_CYCLE`.
5. Insert the edge, append the event, and commit.

The lock prevents two concurrent individually valid edge insertions from jointly creating a cycle. It serializes only dependency writes within the same project, not task edits or different projects. The recursive CTE uses both dependency-direction indexes and should cap depth defensively.

Task deletion cascades assignees, tags, dependencies, and comments in the same transaction and emits one task-deleted event. Clients remove related projections by task ID.

## 12. Performance and optimization

### 12.1 Read path

- Use keyset pagination and selected projections; do not use `SELECT *` for task lists.
- Return description only in the detail/bootstrap view if list rendering does not need it.
- Lazy-load comments and dependency details when a task is opened.
- Cap page sizes and filter cardinality.
- Use `sqlc` queries and `pgxpool` with bounded connections.
- Set statement timeouts for interactive requests.
- Use batch queries for assignees/tags on a page, avoiding N+1 reads.

### 12.2 Frontend rendering

- Use `@tanstack/react-virtual` for task rows or Kanban-card columns.
- Use TanStack Query infinite queries for cursor pages.
- Normalize task cache updates by ID or update only pages containing the changed ID.
- Do not re-render the whole list on every SSE event; memoize rows and patch one entity.
- Debounce filters that trigger network requests.
- Route-level code split and lazy-load heavy task-detail UI.

### 12.3 Cache strategy

Redis is used only for ephemeral collaboration delivery and presence leases.

- TanStack Query caches project/task pages and reconciles them with SSE.
- Short `staleTime` values reduce focus refetches while reconnect logic provides correctness.
- Detail responses expose `ETag`/entity version for conditional reads where useful.
- Highly dynamic task lists use `Cache-Control: private, no-cache`, allowing validation without serving stale shared content.
- PostgreSQL indexes and buffer cache handle the demonstrated dataset.

It does not cache authoritative tasks or concurrency versions. PostgreSQL remains the source for replay and all relational reads.

### 12.4 Rate limits and resource limits

Initial per-instance token buckets provide abuse protection and clear `429` responses:

- separate read, mutation, comment, and SSE-connection budgets;
- maximum request body and field sizes;
- server timeouts on headers, request bodies, and ordinary responses;
- no ordinary write timeout inherited by long-lived SSE handlers;
- bounded database pool and graceful overload responses;
- maximum replay batch and event payload sizes.

Per-instance limits are explicitly documented as approximate under horizontal scaling. A reverse proxy or Redis-backed limiter becomes authoritative later.

### 12.5 Performance proof

Seed one project with 10,000 tasks, realistic tags/assignees, dependencies, and comments. The checked-in k6 script measures task-list p50/p95 latency, read error rate, and compact response size. Mutation, SSE, and collaboration behavior are covered by the integration and browser checks.

Targets on the documented development machine, not universal promises:

- p95 first task page below 250 ms after warm-up;
- p95 task mutation below 300 ms at the documented test concurrency;
- p95 local event propagation below 750 ms;
- ordinary event payload below 10 KB;
- no project-sized response after an individual mutation;
- smooth list interaction because only visible rows render.

Record the machine, seed size, command, concurrency, and raw summary in [`docs/load-test-results.md`](load-test-results.md). If a target is missed, report the result and bottleneck honestly.

## 13. Reliability and failure handling

| Failure | Expected behavior |
| --- | --- |
| Database mutation succeeds but API process dies before HTTP response | Client retries with the same idempotency key and receives the stored response |
| Notification is lost | Listener polling or client replay reads the committed event |
| API instance restarts | Clients reconnect with their project sequence and replay |
| Client is offline briefly | Replays all retained events in order |
| Client is offline beyond retention | Receives `REPLAY_WINDOW_EXPIRED`, re-bootstraps safely |
| Slow SSE consumer | Bounded queue closes connection; client replays from last applied sequence |
| Duplicate/out-of-order delivery | Client deduplicates by sequence and entity version |
| Concurrent stale edit | Conditional update fails with `409`; optimistic patch rolls back |
| Concurrent dependency insertions | Project graph lock plus recursive check preserves acyclicity |
| Event payload exceeds cap | Reference event triggers one entity fetch |
| PostgreSQL unavailable | Readiness fails, mutations return `503`, and no success is acknowledged |
| Process receives shutdown | Stop accepting traffic, close listeners, drain ordinary requests, close SSE so clients reconnect |

Backups, point-in-time recovery, and multi-AZ PostgreSQL are deployment responsibilities for production and outside the take-home environment.

## 14. Observability

### 14.1 Implement now

- Structured JSON logs with timestamp, level, request ID, actor ID, route template, project ID, status, latency, and error code.
- Redact authorization, cookies, comment content, descriptions, and request bodies.
- Prometheus-compatible counters/histograms for request count/latency, database duration, active SSE connections, replayed events, stream lag, queue overflows, conflicts, and rate-limit rejections.
- `/health/live` proves the process loop is alive.
- `/health/ready` verifies PostgreSQL and migration compatibility.
- Frontend logs or reports stream state changes in development; the UI visibly shows live/reconnecting/offline state.

### 14.2 Add with production scale

- OpenTelemetry trace propagation across HTTP, SQL, broker relay, and workers.
- Dashboards and alerts for p95 latency, error budget, replay lag, and dropped/closed streams.
- Central log storage and deploy/version annotations.

## 15. Security

The assignment does not require authentication, but the implementation ships
with an enforced email/password session boundary by default. The explicit
`AUTH_REQUIRED=false` local fallback is not production authentication.

Implement now:

- Validate and cap all inputs at the transport boundary and again for domain invariants.
- Parameterize all SQL through generated queries.
- Scope every entity read/write by project ID.
- Validate project membership before assignment.
- Escape user text in React; do not render untrusted HTML.
- Restrict CORS to the configured web origin.
- Use secure response headers, safe error messages, and secret-free logs.
- Run containers as non-root users and pin dependency versions/lockfiles.
- Keep secrets in environment variables and provide only `.env.example`.

Production additions beyond this take-home are OIDC/SSO federation, CSRF
protection for cookie mutations, audit-retention policy, secret management,
TLS at the edge, and optional PostgreSQL row-level security as defense in
depth.

## 16. Testing strategy

### 16.1 Unit tests

- Allowed and rejected status transitions.
- Task validation and patch semantics.
- Dependency self-edge and cycle-detection decisions.
- Cursor encode/decode and invalid cursor handling.
- Event reconciliation, duplicate handling, and optimistic rollback reducers.

### 16.2 PostgreSQL integration tests

Run against a real PostgreSQL service, not SQLite mocks:

- migration up/down and clean-seed behavior;
- cross-project dependency constraints;
- recursive cycle detection;
- concurrent dependency additions;
- optimistic-version conflicts;
- mutation and event atomicity;
- idempotent retry behavior;
- ordered stream allocation under concurrent writes;
- replay boundaries and retention-expired response;
- keyset pagination with equal timestamps.

### 16.3 HTTP contract tests

- Generated OpenAPI validation.
- Error code/status mapping.
- request size, page size, and rate limits.
- SSE replay, heartbeat, and slow-consumer termination.

### 16.4 End-to-end tests

Playwright opens two isolated browser contexts:

1. both open the same project;
2. client A creates/edits/deletes a task and client B converges;
3. a comment appears without refresh;
4. client B disconnects while A makes several changes;
5. B reconnects and catches up in order;
6. simultaneous updates produce a visible conflict/rollback;
7. a dependency cycle is rejected;
8. a 10,000-task project renders and loads another cursor page.

CI runs formatting, static analysis, generated-contract drift, unit tests, PostgreSQL integration tests, frontend tests, a production build, and the focused two-client E2E test.

## 17. Docker and local development

`docker compose up --build` starts:

- `db`: PostgreSQL with a health check and named volume;
- `migrate`: one-shot migration job that exits successfully before the API starts;
- `minio`: local S3-compatible attachment storage with a named volume;
- `api`: Go server on port 8080;
- `web`: Next.js server on port 3000.

Seed commands are explicit and repeatable:

```text
make seed-demo       # small human-readable dataset
make seed-scale      # deterministic 10,000-task project
make test
make test-e2e
make load-test
```

The seed is idempotent or starts from a clearly named disposable database. The README includes prerequisites, environment variables, architecture summary, synchronization semantics, tradeoffs, test commands, and the exact clean-clone setup rehearsal.

In production, route `/api` and `/events` through the same TLS origin to avoid CORS and cookie complexity. Proxy buffering must be disabled for SSE, and idle timeouts must exceed the heartbeat interval.

## 18. Scaling stages

### Stage 0 - distributed collaboration baseline

- One or a few Go API instances.
- One PostgreSQL primary.
- REST + project-scoped SSE.
- Transactional `sync_events` outbox relayed to Redpanda.
- Redis cross-instance event fan-out and leased presence.
- Redpanda-backed Yjs update delivery across API replicas.
- In-process hubs that own connections only and are reconstructable.
- Cursor queries, indexes, virtualization, and browser query cache.

This is the code that should actually exist and be demonstrated.

### Stage 1 - horizontal application scale

- Put stateless Go instances behind a load balancer; sticky sessions are unnecessary.
- Every instance receives Redis last-mile messages and serves its own connected clients.
- Use a connection pooler if instance count grows.
- Move global rate limiting to Redis or the edge.
- Add read replicas for eventually consistent list/report queries, while mutations and bootstrap cursor snapshots stay on the primary.

### Stage 2 - dedicated gateways and projections

- Increase Redpanda partitions and replication; keep `project_id` as the key.
- Split the SSE gateway from the API when connection count, not business traffic, drives scale.
- Preserve PostgreSQL replay initially; later use the broker's retained stream where its guarantees and retention are sufficient.
- Use consumer offsets and event request IDs for at-least-once, idempotent consumption.

There is no database-and-broker dual write. The durable database event is always committed first, and the relay can retry safely.

### Stage 3 - very large tenants and collaboration

- Time/hash partition `sync_events`; archive old activity to object storage.
- Partition tasks by project/tenant if database measurements justify it.
- Add derived read models for activity, analytics, and search.
- Isolate hot projects across stream partitions and real-time gateway shards.
- Shard Redis presence/cursor channels as concurrent project count grows.
- Compact Yjs description snapshots plus incremental CRDT updates on a bounded schedule; add awareness/presence as an ephemeral channel.
- Consider regional read delivery and a single write home per project before attempting multi-region active-active writes.

## 19. Important tradeoffs

| Decision | Benefit | Cost/limit |
| --- | --- | --- |
| Go modular monolith | Fast build, simple transactions, strong boundaries | Modules share one deploy/release cadence |
| PostgreSQL authoritative state | Familiar queries and invariants | Primary remains write coordinator |
| Durable change stream, not full event sourcing | Reliable replay without rebuilding all state from events | Historical events cannot reconstruct every past entity version |
| SSE for durable updates | Simple one-way protocol and reconnect model | Not suited to cursors/CRDT operations |
| Redpanda outbox delivery | Durable ordered transport without a database/broker dual write | At-least-once consumers must deduplicate |
| Project-local sequence | Correct, simple replay order | Stream allocation serializes briefly per project |
| Optimistic concurrency | Prevents silent lost updates | User may need to resolve a conflict |
| Advisory lock for graph writes | Correct cycle prevention under concurrency | Same-project dependency writes serialize |
| Normalized queryable fields + JSONB custom fields | Good integrity and extension flexibility | JSONB fields have weaker schema and should not absorb core fields |
| Redis for ephemeral fan-out | Cross-instance presence and low-latency delivery | Redis loss temporarily removes awareness |
| S3-compatible attachment storage | Every API replica reads the same durable objects | Binary writes use cleanup intents rather than a distributed database/S3 transaction |
| CRDT limited to text only | Core metadata semantics stay understandable | Block-level formatting remains future work; live selection is ephemeral awareness |

## 20. Two-day implementation order

The priority is one proven end-to-end synchronization slice before breadth.

### Day 1 - correctness spine

1. Scaffold repository, Docker Compose, migrations, seed users/project, and health endpoints.
2. Write OpenAPI core schemas and generate Go/TypeScript contracts.
3. Implement task/project domain types, repositories, status rules, and versioned mutations.
4. Add `project_streams`, `sync_events`, transaction helper, and transactional notify.
5. Implement bootstrap and SSE replay/live tail with heartbeats.
6. Build the first Next.js project/task screen, query cache, and event reconciler.
7. Prove a task created in browser A appears in browser B without project refetch.
8. Add comments and dependency transactions/cycle detection.

**Day 1 exit criterion:** two clients synchronize create/update/comment changes, and every mutation has a durable replayable event.

### Day 2 - scale proof and finish

1. Add optimistic updates, rollback, version conflict UI, and reconnect state.
2. Implement cursor pagination, task virtualization, indexes, and 10,000-task seed.
3. Add activity feed projection from sync events.
4. Add idempotency, rate/payload limits, bounded SSE queues, graceful shutdown, and structured metrics/logs.
5. Write focused unit, integration, and two-client Playwright tests.
6. Run/record load tests and inspect query plans.
7. Finish CI, README, architecture diagram, and clean-clone rehearsal.
8. Record the five-minute demo only after a timed dry run.

**Cut order if time is tight:** global cross-entity undo, activity-feed polish, extra filters, and visual flourishes. Never cut transactional events, reconnect replay, graph correctness, conflict handling, clean setup, or core tests.

## 21. Demo and acceptance criteria

The submission is done when all of the following are observable and repeatable:

### Functional

- A user can create projects and CRUD tasks with required configuration fields.
- Assignees must be project members.
- Status changes follow the documented transition map.
- Dependencies reject self, cross-project, duplicate, and cyclic edges.
- Comments appear chronologically and synchronize between clients.

### Synchronization and consistency

- Two independent browser contexts converge without manual refresh.
- Network inspection shows an entity-level event, not a whole-project payload.
- A disconnected client replays multiple missed events in project sequence.
- A stale simultaneous edit produces a rollback and understandable conflict state.
- Retrying a successful request with the same idempotency key creates no duplicate entity/event.
- Killing an API instance after commit does not lose the committed change on reconnect.

### Performance and scale

- The deterministic seed creates at least 10,000 tasks.
- The UI renders only visible task rows and loads pages by cursor.
- Query plans use the documented indexes.
- The checked-in load script and recorded results are reproducible.
- Payload sizes and latency are shown with actual measurements.

### Engineering quality

- `docker compose up --build` works from a clean clone using documented steps.
- OpenAPI documentation is viewable and generated types are current.
- Unit, PostgreSQL integration, and two-client E2E tests pass in CI.
- Logs contain a request ID and stable error code without leaking content.
- The README explains the architecture, synchronization flow, scaling path, and tradeoffs.

### Five-minute demo sequence

1. Open the seeded 10,000-task project in two browser windows.
2. Create and update a task in A; show the compact SSE payload and immediate update in B.
3. Add a comment and show the activity feed update.
4. Attempt a dependency cycle and show the server rejection.
5. Disconnect B, perform several mutations in A, reconnect B, and show ordered recovery.
6. Trigger a stale edit and show optimistic rollback/conflict resolution.
7. Show smooth virtual scrolling, passing tests/CI, OpenAPI, and the architecture diagram.

The most compelling message is not that the application broadcasts updates. It is that the application remains correct when delivery is duplicated, delayed, disconnected, retried, or concurrent - while large projects are updated incrementally.

## 22. Decision record summary

| ID | Decision | Status |
| --- | --- | --- |
| ADR-001 | Use a Go modular monolith and Next.js App Router | Implement now |
| ADR-002 | Use PostgreSQL as authoritative current state | Implement now |
| ADR-003 | Use REST for commands/queries and SSE for durable server updates | Implement now |
| ADR-004 | Write compact sync events atomically with domain mutations | Implement now |
| ADR-005 | Use per-project ordered sequences and replay | Implement now |
| ADR-006 | Use OpenAPI-generated Go and TypeScript contracts | Implement now |
| ADR-007 | Use keyset pagination and virtualized rendering | Implement now |
| ADR-008 | Use optimistic concurrency and idempotent mutations | Implement now |
| ADR-009 | Use `sync_events` as a transactional outbox | Implement now |
| ADR-010 | Use the Kafka protocol through Redpanda for durable delivery | Implement now |
| ADR-011 | Use Redis only for ephemeral presence and last-mile fan-out | Implement now |
| ADR-012 | Use a separate CRDT channel only for collaborative text | Implement now |
