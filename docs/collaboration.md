# Collaboration behavior

The workspace has three synchronization paths with deliberately different durability.

## Durable project changes

Task metadata, comments, assignments, dependencies, reactions, notifications,
and memberships commit their relational state and a compact `sync_events` row
in one PostgreSQL transaction. Competing relay replicas claim unpublished rows
with `FOR UPDATE SKIP LOCKED`, preserve project order, and publish them to the
Kafka-compatible Redpanda topic keyed by `project_id`.

A distributor consumer group forwards committed events through Redis to every
API replica. Local SSE connections receive the event directly when contiguous;
gaps, queue overflow, Redis loss, and reconnects recover from PostgreSQL using
the project cursor. Redis and Redpanda therefore improve delivery scale without
becoming part of the domain transaction.

Task metadata keeps field-level optimistic concurrency. Disjoint stale edits
merge; same-field edits return `VERSION_CONFLICT`. Actor-scoped undo/redo only
replays an operation while its affected fields still match the expected state.

## Collaborative descriptions

Descriptions use Yjs over a task-scoped WebSocket. An update is acknowledged
only after it is persisted in PostgreSQL and replicated by Redpanda. Document
messages are keyed by `project_id:task_id`; the distributor relays them through
Redis to the in-process rooms on every API replica. Duplicate delivery is safe
because Yjs updates are idempotent.

Description updates do not allocate project sequences or create project events
per keystroke. The plain-text task projection remains eventually consistent and
does not increment the metadata version. Each task permits 100 live editors;
additional sessions and VIEWER members remain read-only observers.

A Yjs-aware worker locks one document, merges its accumulated deltas into a
verified snapshot, updates the searchable projection, and deletes only the
covered rows. Description appends lock the same document row, so compaction
cannot race an acknowledged update. The threshold and polling interval are
deployment settings; low-volume documents also compact after two idle polling
intervals so their searchable projection converges without waiting for the
threshold.

## Presence and selections

Presence is ephemeral and shown only while a task is open. Redis stores session
leases for 45 seconds and publishes task/selection changes to every API replica.
The browser collapses multiple sessions for the same actor into one task-level
person and excludes the signed-in actor. Clients renew leases, reconnect with
exponential backoff, and receive an active cross-instance snapshot when joining.
A crashed process leaves no authoritative state behind; the lease expires
automatically.

Redis failure temporarily removes awareness but cannot lose tasks, comments, or
acknowledged description updates.
