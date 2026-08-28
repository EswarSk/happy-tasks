-- +goose Up
-- A composite parent reference keeps every reply inside the same project and
-- task. The parent row is retained on soft deletion so descendants never lose
-- their position in the discussion tree.
ALTER TABLE comments
    ADD COLUMN parent_id uuid,
    ADD CONSTRAINT comments_project_task_id_unique UNIQUE (project_id, task_id, id),
    ADD CONSTRAINT comments_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id),
    ADD CONSTRAINT comments_parent_same_task_fk
        FOREIGN KEY (project_id, task_id, parent_id)
        REFERENCES comments(project_id, task_id, id);

CREATE INDEX comments_parent_time_idx
    ON comments (project_id, task_id, parent_id, created_at, id)
    WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS comments_parent_time_idx;

ALTER TABLE comments
    DROP CONSTRAINT IF EXISTS comments_parent_same_task_fk,
    DROP CONSTRAINT IF EXISTS comments_parent_not_self,
    DROP CONSTRAINT IF EXISTS comments_project_task_id_unique,
    DROP COLUMN IF EXISTS parent_id;
