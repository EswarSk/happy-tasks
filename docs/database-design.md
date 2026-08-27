# Database Design - Tasks, Comments, Reactions, and Synchronization

**Status:** Proposed for the take-home implementation

**Primary store:** PostgreSQL

**Related design:** [System architecture](./architecture.md)

## 1. Decision summary

Use normalized PostgreSQL tables for authoritative project, task, dependency,
comment, and reaction state. Use compact rows and keyset pagination rather than
loading a project aggregate. Every successful mutation writes a durable
`sync_events` row in the same transaction as the domain change.

Comments are required by the assignment. Reactions are included in this design
as an optional, low-risk extension; the two-day build should add them only after
comment creation, pagination, replay, and multi-client synchronization are
working.

The practical initial design provides:

- stable comment ordering;
- duplicate-safe writes;
- project and task isolation enforced by foreign keys;
- compact real-time events;
- efficient access to recent and older comments;
- optimistic concurrency for edits and deletion;
- an upgrade path for hot tasks, cached first pages, asynchronous counters, and
  a separate comment service.

## 2. Why comments and likes are a classic system-design problem

The basic tables are straightforward. Scale changes the problem:

- one popular task can receive a disproportionate share of writes;
- millions of readers may request the same first page;
- comment ordering must remain stable while new comments arrive;
- retries must not create duplicate comments or reactions;
- deleting a comment must not corrupt reply structure;
- exact reaction counters can become contended rows;
- broadcasting every change must not force clients to reload the whole thread;
- the system needs different consistency guarantees for authored content,
  per-user reaction state, and aggregate counters.

The design therefore separates authoritative records from derived counts,
cached pages, and real-time delivery.

## 3. Required access patterns

Design tables and indexes for known operations rather than hypothetical
queries.

### Projects and tasks

- List projects available to a user.
- Load one project and the first cursor page of tasks.
- Filter tasks by status, assignee, or tag.
- Read and update one task by project and task ID.
- Traverse task dependencies in both directions.

### Comments

- Load the newest comment page for one task.
- Load older comments using a stable cursor.
- Add one comment exactly once even if the client retries.
- Optionally edit or soft-delete a comment using its version.
- Append a new comment to an open thread through real-time synchronization.
- Show a task's comment count without loading the thread.

### Reactions - optional

- Add, change, or remove the current user's reaction.
- Prevent the same user from creating duplicate reactions.
- Return reaction counts grouped by type.
- Return the current user's reaction with the comment page.
- Broadcast changed aggregate counts without broadcasting the user list.

### Synchronization

- Replay all project changes after a project-local sequence.
- Fetch only the affected entity when an event contains a reference.
- Retain enough history for short disconnects without treating the event table
  as the permanent audit log.

## 4. Logical model

```text
users
  | 1
  |                project_members
  +--------------------< >--------------------+
                                                | *
                                             projects
                                                | 1
                   +----------------------------+------------------+
                   |                                               |
                   | *                                             | 1
                 tasks --------------------------+          project_streams
                   | 1                                           | 1
        +----------+-------------+                               | *
        |          |             |                           sync_events
        | *        | *           | *
  assignees      tags      task_dependencies
                               task -> task
                   |
                   | 1
                   | *
                comments
                   | 1
                   | *
           comment_reactions
```

Stable, queryable relationships are relational. Only genuinely flexible task
configuration belongs in JSONB.

## 5. Core schema

The DDL below is intentionally close to executable PostgreSQL, while leaving
enum definitions and migration naming to implementation.

### 5.1 Users, projects, and membership

```sql
CREATE TABLE users (
    id           uuid PRIMARY KEY,
    display_name text        NOT NULL,
    email        citext      NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id          uuid PRIMARY KEY,
    name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    description text        NOT NULL DEFAULT '',
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    version     bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id),
    role       text NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
```

The take-home uses seeded users and a development identity selector. The
membership table still makes assignment validation and future authorization
boundaries explicit.

### 5.2 Tasks and relationships

```sql
CREATE TABLE tasks (
    id            uuid PRIMARY KEY,
    project_id    uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title         text        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
    description   text        NOT NULL DEFAULT '',
    status        task_status NOT NULL,
    priority      task_priority NOT NULL,
    custom_fields jsonb       NOT NULL DEFAULT '{}'::jsonb,
    comment_count bigint      NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
    version       bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by    uuid        NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, id)
);

CREATE TABLE task_assignees (
    project_id uuid NOT NULL,
    task_id    uuid NOT NULL,
    user_id    uuid NOT NULL,
    PRIMARY KEY (task_id, user_id),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, user_id)
        REFERENCES project_members(project_id, user_id)
);

CREATE TABLE task_tags (
    project_id uuid NOT NULL,
    task_id    uuid NOT NULL,
    tag        text NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
    PRIMARY KEY (task_id, tag),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE TABLE task_dependencies (
    project_id         uuid        NOT NULL,
    task_id            uuid        NOT NULL,
    depends_on_task_id uuid        NOT NULL,
    created_by         uuid        NOT NULL REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, depends_on_task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE
);
```

The repeated `project_id` is deliberate. It allows the database to reject
cross-project relationships rather than trusting every application call site.

## 6. Comment design

### 6.1 Authoritative comment row

```sql
CREATE TABLE comments (
    id          uuid PRIMARY KEY,
    project_id  uuid        NOT NULL,
    task_id     uuid        NOT NULL,
    author_id   uuid        NOT NULL,
    body        text        NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    version     bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz,
    deleted_at  timestamptz,
    deleted_by  uuid,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, author_id)
        REFERENCES project_members(project_id, user_id),
    FOREIGN KEY (deleted_by)
        REFERENCES users(id),
    CHECK (
        (deleted_at IS NULL AND deleted_by IS NULL)
        OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);
```

Important choices:

- The client creates a UUIDv7 comment ID before submitting. This lets the UI
  render optimistically and makes retries naturally address the same entity.
- PostgreSQL assigns timestamps. Client clocks never determine canonical order.
- `version` protects optional edit/delete operations from silent overwrites.
- Direct comment deletion is soft: replace the displayed body with a deleted
  marker and retain thread position, authorship metadata, and event history.
- Deleting the containing task may hard-delete comments through the foreign key,
  because the whole aggregate has been intentionally removed. The task deletion
  event is the client tombstone.
- The initial product has a flat chronological thread. Do not add nested replies
  merely because the word "thread" is used. A `parent_comment_id` can be added
  later with a same-task composite foreign key if product requirements demand
  replies.

### 6.2 Ordering and cursor pagination

Create this index:

```sql
CREATE INDEX comments_task_time_idx
    ON comments (project_id, task_id, created_at DESC, id DESC);
```

Load the newest page:

```sql
SELECT id, task_id, author_id, body, version,
       created_at, updated_at, deleted_at
FROM comments
WHERE project_id = $1 AND task_id = $2
ORDER BY created_at DESC, id DESC
LIMIT $3;
```

Load older comments using a cursor containing `(created_at, id)`:

```sql
SELECT id, task_id, author_id, body, version,
       created_at, updated_at, deleted_at
FROM comments
WHERE project_id = $1
  AND task_id = $2
  AND (created_at, id) < ($3, $4)
ORDER BY created_at DESC, id DESC
LIMIT $5;
```

The API returns the newest page in descending order for efficient pagination;
the client reverses that page when rendering an oldest-to-newest conversation.
Using both timestamp and ID prevents duplicates or missing rows when timestamps
are equal.

Do not use offset pagination. New comments inserted while the user loads older
pages would shift offsets and cause duplicate or skipped results.

### 6.3 Creating a comment

One transaction performs:

1. Validate the author is a project member and the task exists in the project.
2. Check the idempotency key and client-generated comment ID.
3. Insert the comment.
4. Increment `tasks.comment_count`.
5. Allocate the next project stream sequence.
6. Insert one `comment.created` synchronization event.
7. Store the canonical idempotent response.
8. Commit and notify listeners using only the project ID and sequence.

The event contains the small renderable comment projection so connected clients
can append it without reloading the task or comment page:

```json
{
  "type": "comment.created",
  "projectId": "...",
  "sequence": 1842,
  "comment": {
    "id": "...",
    "taskId": "...",
    "author": { "id": "...", "displayName": "..." },
    "body": "...",
    "version": 1,
    "createdAt": "..."
  },
  "requestId": "..."
}
```

Cap the comment body at 10 KB and the event at 64 KB. If future comment content
can exceed the event cap, publish only the comment ID and fetch it separately.

### 6.4 Editing and deleting comments

Editing and deletion are not required for the initial assignment, but the schema
supports them cleanly:

- require `If-Match` with the current comment version;
- update only when `version = expected_version`;
- increment the version once;
- decrement `tasks.comment_count` exactly once when an active comment becomes
  deleted;
- write `comment.updated` or `comment.deleted` in the same transaction;
- return `409 VERSION_CONFLICT` when another edit won;
- retain a soft-deleted row and emit a body-free tombstone projection.

The take-home UI should not implement these operations until required comment
creation, pagination, replay, and optimistic rollback are complete.

## 7. Reaction design - optional extension

Model a like as a reaction type rather than creating a special-purpose likes
table. Restrict each user to one active reaction per comment; changing a
reaction is an update, not another row.

```sql
CREATE TABLE comment_reactions (
    project_id    uuid        NOT NULL,
    comment_id    uuid        NOT NULL,
    user_id       uuid        NOT NULL,
    reaction_type text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id),
    FOREIGN KEY (project_id, comment_id)
        REFERENCES comments(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, user_id)
        REFERENCES project_members(project_id, user_id),
    CHECK (reaction_type IN ('LIKE', 'CELEBRATE', 'INSIGHTFUL'))
);

CREATE INDEX comment_reactions_comment_type_idx
    ON comment_reactions (comment_id, reaction_type);
```

Initial reaction counts can be calculated for the comments on one page:

```sql
SELECT comment_id, reaction_type, count(*)
FROM comment_reactions
WHERE comment_id = ANY($1)
GROUP BY comment_id, reaction_type;
```

For a 50-comment page, this is a bounded query and avoids prematurely
maintaining counters. The same page query separately selects the current user's
reaction for those comment IDs.

Reaction mutation semantics:

- `PUT /comments/{commentId}/reaction` creates or changes one reaction;
- `DELETE /comments/{commentId}/reaction` removes it;
- both operations are idempotent;
- a transaction updates the row and writes `comment.reactions_changed`;
- the mutation response contains the user's state and new aggregate counts;
- the broadcast event contains aggregate counts, not the complete user list.

### 7.1 Counter strategy for very hot comments

Counting indexed rows is sufficient for the take-home. At large scale:

1. Keep `comment_reactions` as the source of truth for per-user state and
   uniqueness.
2. Publish reaction changes from the transactional outbox.
3. Maintain a derived `comment_reaction_counts` projection asynchronously.
4. Cache counts and the first comment page because those reads dominate.
5. Accept that displayed aggregate counts may lag briefly while the current
   user's own reaction remains read-after-write consistent.

Do not increment one globally hot counter row on every reaction indefinitely.
If exact synchronous counters become a measured bottleneck, use striped counter
rows keyed by `(comment_id, reaction_type, stripe)` or move the projection to a
stream processor and cache.

## 8. Synchronization tables

```sql
CREATE TABLE project_streams (
    project_id    uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE TABLE sync_events (
    project_id        uuid        NOT NULL,
    sequence          bigint      NOT NULL,
    event_type        text        NOT NULL,
    aggregate_type    text        NOT NULL,
    aggregate_id      uuid        NOT NULL,
    aggregate_version bigint,
    actor_id          uuid,
    request_id        uuid        NOT NULL,
    payload           jsonb       NOT NULL,
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, sequence),
    UNIQUE (request_id)
);

CREATE TABLE idempotency_keys (
    actor_id        uuid        NOT NULL,
    idempotency_key text        NOT NULL,
    request_hash    bytea       NOT NULL,
    response_status integer     NOT NULL,
    response_body   jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    PRIMARY KEY (actor_id, idempotency_key)
);
```

The event stream is for synchronization and short replay, not full event
sourcing. PostgreSQL rows remain authoritative. Events are retained for a
documented window, and clients re-bootstrap if their cursor is older than that
window.

`LISTEN/NOTIFY` is only a low-latency wake-up mechanism. Notifications contain
the project and latest sequence; consumers always read durable event rows.

## 9. Index plan

Create only indexes tied to demonstrated queries:

```sql
CREATE INDEX tasks_project_updated_idx
    ON tasks (project_id, updated_at DESC, id DESC);

CREATE INDEX tasks_project_status_updated_idx
    ON tasks (project_id, status, updated_at DESC, id DESC);

CREATE INDEX task_assignees_user_idx
    ON task_assignees (project_id, user_id, task_id);

CREATE INDEX task_tags_tag_idx
    ON task_tags (project_id, tag, task_id);

CREATE INDEX task_dependencies_forward_idx
    ON task_dependencies (project_id, task_id, depends_on_task_id);

CREATE INDEX task_dependencies_reverse_idx
    ON task_dependencies (project_id, depends_on_task_id, task_id);

CREATE INDEX comments_task_time_idx
    ON comments (project_id, task_id, created_at DESC, id DESC);

CREATE INDEX sync_events_retention_idx
    ON sync_events (occurred_at);

CREATE INDEX idempotency_expiry_idx
    ON idempotency_keys (expires_at);
```

Some primary keys already create indexes. The migration should avoid a redundant
secondary index after checking the final query and constraint plan with
`EXPLAIN (ANALYZE, BUFFERS)`.

## 10. Consistency choices

Not every value needs the same consistency level:

| Data | Consistency | Reason |
| --- | --- | --- |
| Comment body and deletion | Strong per mutation | Never silently lose authored content |
| Current user's reaction | Read-after-write | The user's own action must feel correct |
| Aggregate reaction count | Exact initially; eventually consistent at extreme scale | Slight counter lag is acceptable |
| Comment ordering | Stable server order | Client clocks are untrusted |
| Task comment count | Exact initially; derived later if hot | Useful badge, but not domain-critical |
| Real-time delivery | At least once with deduplication | Replay is safer than pretending exactly-once delivery |

The client deduplicates project events by sequence and entity updates by version.
HTTP idempotency prevents retries from creating duplicate authoritative rows.

## 11. Hot-task scaling path

Do not introduce all of this in the take-home. The evolution path is:

### Stage 0 - two-day build

- One PostgreSQL primary.
- Direct indexed comment queries.
- Keyset pagination, 50 comments per page.
- Exact `tasks.comment_count` updated transactionally.
- Direct bounded reaction aggregation if reactions are implemented.
- Compact comment events over project-scoped SSE.

### Stage 1 - read-heavy popular tasks

- Cache the first comment page and reaction summaries in Redis.
- Invalidate or update cache entries from committed events.
- Send older-page reads to PostgreSQL read replicas when replica lag is
  acceptable.
- Keep writes and synchronization cursors on the primary.

### Stage 2 - high write and fan-out volume

- Relay committed outbox events to Kafka or NATS.
- Extract a stateless comment service only when ownership or load justifies it.
- Move aggregate counters to asynchronous projections.
- Run a dedicated real-time gateway for large connection counts.
- Partition comments by project hash or time only after table-size measurements
  show a benefit.

### Stage 3 - extreme global scale

- Give each project or task a write home to avoid cross-region ordering claims.
- Shard authoritative comment storage by tenant/project.
- Store append-oriented comment-feed projections in Cassandra if the access
  pattern and volume justify it.
- Keep per-user reaction uniqueness in an authoritative store or explicitly
  design conflict resolution for duplicated regional writes.
- Use a content delivery and cache strategy for public, heavily read threads.

Cassandra is credible at Stage 3 for append-heavy projections. It is not the
cleanest initial source of truth for project membership, task dependencies,
multi-row mutations, and comment/event atomicity.

## 12. Failure cases and expected behavior

| Failure | Behavior |
| --- | --- |
| Client retries comment creation | Same UUID and idempotency key return the stored response |
| API dies after database commit | Retry returns the committed result; replay delivers the event |
| SSE notification is lost | Client or listener queries durable events after its last sequence |
| Comment arrives while older pages load | Keyset pagination remains stable; live event appends separately |
| Duplicate event arrives | Project sequence deduplication drops it |
| Comment edit is stale | Conditional update returns `409`; optimistic change rolls back |
| Reaction request is repeated | Upsert/delete remains idempotent |
| Reaction counter lags at scale | User state remains correct; aggregate converges from events |
| Slow real-time client | Bounded queue closes; client reconnects and replays |
| Task is deleted | Transaction emits a task tombstone; cascades remove comments/reactions |

## 13. Verification plan

### Database integration tests

- A comment cannot reference a task in another project.
- A non-member cannot author a project comment.
- Duplicate comment retries produce one row, one count increment, and one event.
- Comment ordering remains stable when timestamps are equal.
- Comment creation and event insertion roll back together.
- A stale comment edit returns a version conflict.
- Soft deletion preserves ordering and emits no deleted body.
- One user has at most one reaction per comment.
- Changing a reaction updates counts without duplicate rows.
- Task deletion removes comments and reactions transactionally.

### Multi-client tests

- Client A adds a comment and Client B receives it without refreshing.
- Client B disconnects, misses comments, reconnects, and replays them in order.
- An optimistic comment appears immediately and reconciles with the canonical
  server timestamp.
- A forced write failure removes the optimistic comment and shows an error.
- Loading older pages while new comments arrive creates no duplicates.

### Scale checks

- Seed a hot task with at least 100,000 comments for database testing.
- Confirm first-page and older-page queries use `comments_task_time_idx`.
- Record p50/p95 latency and payload size.
- Confirm comment creation transmits one compact event, not the project or full
  comment history.
- If reactions are implemented, load-test toggles separately from comment
  creation and document counter behavior.

## 14. Two-day implementation boundary

Implement:

- flat comments;
- create and paginated list;
- optimistic creation with rollback;
- server timestamps and stable cursor ordering;
- idempotency;
- exact task comment count;
- `comment.created` synchronization and reconnect replay;
- database integration and two-client E2E tests.

Implement only if core work is complete:

- reaction add/change/remove;
- reaction summaries;
- comment edit and soft-delete UI.

Design but do not implement:

- nested replies;
- Redis comment-page cache;
- asynchronous or striped reaction counters;
- broker fan-out;
- database partitioning and sharding;
- Cassandra projections;
- global multi-region writes.

This boundary demonstrates that the design can scale without burdening the
take-home with infrastructure that its measured workload does not need.
