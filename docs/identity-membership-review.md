# Identity, Membership, and Assignment Review

**Status:** Implemented baseline in migration `00011_identity_membership_assignment_history.sql`; this note also records the remaining production-hardening seam.

This note reviews the database boundary for soft member removal, authorization,
ownership, identity deletion, and assignment history. The identity, membership,
authorization, optimistic-concurrency, and assignment-history portions are now
implemented. User anonymization and verified production authentication remain
explicit follow-on work rather than being implied by the demo actor selector.

## Recommended model

Keep a stable `users` row and a stable `(project_id, user_id)` membership row.
Removal changes lifecycle state; it does not delete either row. This preserves
comment/task authorship and lets historical foreign keys remain valid.

The following is target-state DDL. For an existing large table, use the online
sequence below rather than applying the defaults and `NOT NULL` changes in one
step.

```sql
ALTER TABLE users
    ADD COLUMN state text NOT NULL DEFAULT 'ACTIVE'
        CHECK (state IN ('ACTIVE', 'DISABLED', 'ANONYMIZED')),
    ADD COLUMN disabled_at timestamptz,
    ADD COLUMN anonymized_at timestamptz;

ALTER TABLE project_members
    ADD COLUMN joined_at timestamptz,
    ADD COLUMN removed_at timestamptz,
    ADD COLUMN removed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD CHECK (removed_at IS NULL OR removed_at >= joined_at);
```

`removed_at IS NULL` is the only definition of active membership. `removed_by`
is deliberately nullable because anonymizing or deleting that actor must not
invalidate the historical removal.

Do not hard-delete users that are referenced by comments, tasks, dependencies,
events, or memberships. Anonymization should revoke credentials/sessions,
disable memberships, unassign tasks, and replace or null PII while retaining the
stable user ID. In a production evolution, keep authentication credentials and
PII in a separate table so they can be erased without rewriting domain history.

## Required indexes

```sql
-- Reverse lookup: projects currently available to one user.
CREATE INDEX CONCURRENTLY project_members_active_user_idx
    ON project_members (user_id, project_id)
    INCLUDE (role, version)
    WHERE removed_at IS NULL;

-- Project bootstrap/member list and last-owner check.
CREATE INDEX CONCURRENTLY project_members_active_project_role_idx
    ON project_members (project_id, role, user_id)
    WHERE removed_at IS NULL;

-- Global user disable/anonymization can find current assignments without a
-- project-by-project scan.
CREATE INDEX CONCURRENTLY task_assignees_user_project_task_idx
    ON task_assignees (user_id, project_id, task_id);

-- Bounded cleanup workers can walk keys in expiry/retention order.
CREATE INDEX CONCURRENTLY idempotency_cleanup_idx
    ON idempotency_keys (expires_at, actor_id, idempotency_key);

CREATE INDEX CONCURRENTLY sync_events_cleanup_idx
    ON sync_events (occurred_at, project_id, sequence);
```

The current `(project_id, user_id)` primary key already supports one project's
membership lookup. It does not efficiently support `WHERE user_id = ?`, hence
the reverse partial index.

## Authorization and concurrency invariants

- Every project read or mutation requires both an active user and an active
  membership: `users.state = 'ACTIVE' AND project_members.removed_at IS NULL`.
- Every project mutation checks the actor membership in its transaction and
  holds `SELECT ... FOR SHARE` on that row; it permits concurrent authorization
  checks but conflicts with the removal update. This linearizes an in-flight
  mutation either before or after member removal.
- Assignment creation additionally locks each assignee membership row and
  checks it is active in the same transaction that creates the assignment.
- Member removal must lock the same membership row before marking it removed
  and closing/removing every active assignment. This prevents a remove/assign
  race.
- Owner transfer/removal must lock the parent `projects` row, then confirm at
  least one other active owner exists. All ownership mutations for a project
  take this lock, preventing two concurrent removals from both succeeding.
- Prefer a database trigger as defense in depth for last-owner protection. The
  application still returns the stable `LAST_PROJECT_OWNER` domain error.
- A project delete is a separate owner-authorized operation. Last-owner
  protection must not block the membership deletes caused by project cascade.
- Long-lived SSE subscriptions must be keyed by actor as well as project.
  Committing `member.removed` closes that actor's existing streams on every API
  instance, or the stream revalidates membership on a short authorization
  lease. Authorizing only when the stream opens leaks later project events.
- Reactivation updates the existing membership row and increments its version.
  If join/remove cycles require a complete audit, append membership events; do
  not infer that history from the current row.

PostgreSQL cannot reference a partial unique index from a foreign key, so a
foreign key to `project_members` proves historical membership, not active
membership. Active membership must be protected by the locked transactional
check above.

## Assignment history

Do not overwrite assignment history in the current `task_assignees` table. Two
clean options are:

1. Keep `task_assignees` as the small current-state table and append every
   assign/unassign action to `task_assignment_operations` in the same
   transaction.
2. Replace it with temporal `task_assignments` rows and a partial unique index
   allowing one active assignment per task/user.

For this project, option 1 minimizes query and migration risk:

```sql
CREATE TABLE task_assignment_operations (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('ASSIGNED', 'UNASSIGNED')),
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    request_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, request_id, task_id, user_id, action),
    -- Migration 00011 intentionally has no task FK, preserving audit rows
    -- when a task is hard-deleted.
    FOREIGN KEY (project_id, user_id)
        REFERENCES project_members(project_id, user_id)
);

CREATE INDEX task_assignment_operations_task_time_idx
    ON task_assignment_operations
       (project_id, task_id, occurred_at DESC, id DESC);

CREATE INDEX task_assignment_operations_user_time_idx
    ON task_assignment_operations
       (user_id, occurred_at DESC, id DESC);
```

Member removal deletes current `task_assignees` rows but first appends matching
`UNASSIGNED` audit rows. The membership removal, assignment cleanup, audit rows,
domain event, idempotent response, and stream sequence commit atomically.

Migration 00011 intentionally omits a task foreign key from the append-only
operation table so assignment history survives a hard task delete. If a future
retention policy prefers cascading audit rows, make that choice explicit and
document it as a change in audit semantics.

## User anonymization

- Reject anonymization while the user is the sole active owner of any project;
  require owner transfer or explicit project archival/deletion first.
- Lock the user plus affected project/membership rows in deterministic project
  order to avoid deadlocks.
- Revoke sessions and credentials, set `state = 'ANONYMIZED'`, clear/null email,
  and use a generic display name. A nullable email with a unique partial index
  (`WHERE email IS NOT NULL`) is cleaner than manufacturing tombstone emails.
- Preserve `users.id`; comments and task history continue to resolve to the
  generic user projection.
- Never include email in sync-event payloads. Comment/event content has a short
  documented retention window or requires a separate scrub/encryption policy
  for stronger erasure requirements.

## Cleanup and retention

- Delete expired idempotency rows in ordered, bounded batches using
  `FOR UPDATE SKIP LOCKED`; never perform one unbounded delete.
- Treat idempotency response bodies as potentially sensitive because they can
  contain comment or profile projections.
- Delete expired sync events in bounded batches and update an explicit
  `project_streams.oldest_available_sequence`. Replay checks that watermark
  before reading, returning `REPLAY_WINDOW_EXPIRED` deterministically.
- `actor_id ON DELETE SET NULL` on events is correct for historical delivery.
- Retention cleanup and live event insertion operate concurrently; they must not
  reset or derive `last_sequence` from retained rows.

## Future partitioning constraints

- Project-scoped data is already the correct sharding boundary because
  dependencies cannot cross projects and event order is project-local.
- PostgreSQL partitioned unique/primary constraints must include the partition
  key. Before hash partitioning by `project_id`, evolve task/comment identity
  from `PRIMARY KEY (id)` to `PRIMARY KEY (project_id, id)` and event request
  uniqueness to `(project_id, request_id)`.
- The same rule applies to relationship/audit tables: their future keys become
  `task_assignees(project_id, task_id, user_id)`,
  `task_tags(project_id, task_id, tag)`,
  `task_dependencies(project_id, task_id, depends_on_task_id)`, and
  `task_assignment_operations(project_id, id)`. Several current keys omit the
  project column even though the column is stored in the row.
- UUIDv7 makes global ID collisions negligible, but PostgreSQL cannot enforce a
  global unique `id` across ordinary project partitions without a coordinator.
- If workspaces are introduced, add an immutable `workspace_id` routing key to
  projects and high-volume child tables. Enforce composite foreign keys so a
  project/member/task cannot cross a workspace boundary.
- Model `workspace_members` separately from `project_members`; do not overload
  one lifecycle row with both organization access and project-specific roles.
- Hash partitioning by project preserves hot-path lookup and uniqueness better
  than time partitioning. Time-based retention can remain bounded batch deletion
  or become a second-level partition only after accepting PostgreSQL's unique
  constraint limitations.

## Online migration sequence

1. Audit for projects with zero active owners and repair them first.
2. Add lifecycle columns as nullable, without volatile defaults or table
   rewrites.
3. Backfill `joined_at` and lifecycle state in bounded primary-key batches.
4. Add checks and foreign keys as `NOT VALID`, validate separately, then set
   required columns `NOT NULL`.
5. Build partial/reverse indexes with `CREATE INDEX CONCURRENTLY`; a Goose file
   containing these operations must use `-- +goose NO TRANSACTION`.
6. Deploy reads that require `removed_at IS NULL` before enabling removal.
7. Deploy dual writes to assignment history, backfill a baseline if needed,
   then enable removal/unassignment workflows.
8. Add last-owner trigger only after the owner audit and application lock order
   are in place.
9. Verify retry behavior during removal: one membership update, one set of
   unassignment audits, and one stream event per logical request.

## Verification checklist

- [x] Removed members cannot read, mutate, comment, reconnect to SSE, or be
      newly assigned, and their already-open SSE streams are closed promptly.
- [x] Their historical comments and authored task metadata still render.
- [x] Removal concurrently racing with assignment leaves no active assignment
      (the same membership row locks are used by both paths).
- [x] Two concurrent owner removals are serialized by the project owner lock;
      the final active owner is rejected.
- [x] Membership changes and reactivation increment versions and emit one
      replayable event each; stale `If-Match` values return `VERSION_CONFLICT`.
- [ ] Anonymization is blocked for a sole owner and preserves comment history
      after successful transfer.
- [x] Reverse membership lookup uses the indexed `(user_id, project_id)` path;
      active-directory reads also exclude globally inactive users.
- [x] Assignment audit contains actor, request, user, task, operation, and
      server time; retrying does not duplicate it.
- [ ] Idempotency and sync cleanup are bounded, indexed, and safe with multiple
      workers.
- [ ] Replay before the retained watermark returns
      `REPLAY_WINDOW_EXPIRED` rather than a silent gap.
- [ ] A partitioning rehearsal finds no primary/unique constraint missing the
      intended routing key.
