-- +goose Up
-- An undo/redo changes the task version without creating a second logical
-- operation. Track the latest version touched by that operation so stale
-- same-field writes still conflict after an inverse/replay action.
ALTER TABLE task_operations
    ADD COLUMN last_action_version bigint;

UPDATE task_operations
SET last_action_version = resulting_version;

ALTER TABLE task_operations
    ALTER COLUMN last_action_version SET NOT NULL,
    ADD CONSTRAINT task_operations_last_action_version_check
        CHECK (last_action_version > 0);

CREATE INDEX task_operations_task_action_version_idx
    ON task_operations (project_id, task_id, last_action_version DESC, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS task_operations_task_action_version_idx;

ALTER TABLE task_operations
    DROP CONSTRAINT IF EXISTS task_operations_last_action_version_check,
    DROP COLUMN IF EXISTS last_action_version;
