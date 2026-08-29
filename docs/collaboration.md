# Collaboration behavior

The workspace has two intentionally different synchronization paths:

* Task metadata (title, status, priority, assignments, tags, and custom fields)
  uses PostgreSQL row locking plus field-level operation history. A stale
  `If-Match` is accepted when every changed field is disjoint from operations
  committed after that version. Same-field edits return `VERSION_CONFLICT`.
* Task descriptions use a Yjs document over
  `GET /v1/projects/{projectId}/tasks/{taskId}/description/live` (WebSocket
  upgrade). The first client stores a full Yjs snapshot; later updates are
  opaque Yjs deltas persisted and relayed to peers. A plain-text projection is
  kept in `tasks.description` for search and list bootstrap, without bumping
  the metadata version. Each task allows up to 100 live editors; additional
  sessions remain connected as read-only observers. A later reconnect can claim
  a slot after an editor leaves.

Undo and redo are explicit task actions in the detail header. They are scoped
to the authenticated actor and operate on the latest metadata operation. An
inverse is applied only if the affected fields still equal the operation's
expected state, preserving independent collaborator edits. A new metadata edit
invalidates that actor's redo stack. Description editing has local Yjs undo
semantics and is deliberately not mixed with metadata undo.

The current CRDT relay is intentionally storage-agnostic: Go never parses Yjs
binary updates. The take-home uses an in-process room for low-latency peers on
one API instance and PostgreSQL for durable reconnect. Horizontal deployments
can replace the room fan-out with Redis/NATS without changing the browser
protocol or storage model. Production deployments should also enforce an
edge origin policy in addition to the API allowlist and compact old update
rows into a new snapshot on a bounded schedule. Because Go deliberately treats
the binary document as opaque, the searchable plain-text projection is
eventually consistent and supplied by converged clients; a production
compaction worker should derive and verify that projection while writing the
next snapshot.
