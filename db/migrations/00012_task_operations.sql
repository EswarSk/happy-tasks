-- +goose Up
-- A task operation is a reversible, field-scoped mutation.  The current task
-- row remains authoritative; this table records the small before/after delta
-- needed for safe undo/redo and for detecting overlapping stale edits.
CREATE TABLE task_operations (
    id              uuid PRIMARY KEY,
    project_id      uuid NOT NULL,
    task_id         uuid NOT NULL,
    actor_id        uuid NOT NULL REFERENCES users(id),
    request_id      uuid NOT NULL,
    operation_type  text NOT NULL CHECK (operation_type IN ('UPDATE', 'UNDO', 'REDO')),
    changed_fields  text[] NOT NULL CHECK (cardinality(changed_fields) > 0),
    before_state    jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
    after_state     jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
    base_version    bigint NOT NULL CHECK (base_version > 0),
    resulting_version bigint NOT NULL CHECK (resulting_version > 0),
    state           text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'UNDONE', 'INVALIDATED')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    acted_at        timestamptz,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    UNIQUE (request_id)
);

CREATE INDEX task_operations_task_version_idx
    ON task_operations (project_id, task_id, resulting_version DESC, created_at DESC);

CREATE INDEX task_operations_actor_state_idx
    ON task_operations (project_id, task_id, actor_id, state, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS task_operations_actor_state_idx;
DROP INDEX IF EXISTS task_operations_task_version_idx;
DROP TABLE IF EXISTS task_operations;
