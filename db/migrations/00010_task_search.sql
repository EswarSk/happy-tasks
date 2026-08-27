-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX tasks_project_priority_updated_idx
    ON tasks (project_id, priority, updated_at DESC, id DESC);

CREATE INDEX tasks_title_trgm_idx
    ON tasks USING gin (title gin_trgm_ops);

CREATE INDEX tasks_description_trgm_idx
    ON tasks USING gin (description gin_trgm_ops);

CREATE INDEX task_tags_tag_trgm_idx
    ON task_tags USING gin (tag gin_trgm_ops);

-- +goose Down
DROP INDEX IF EXISTS task_tags_tag_trgm_idx;
DROP INDEX IF EXISTS tasks_description_trgm_idx;
DROP INDEX IF EXISTS tasks_title_trgm_idx;
DROP INDEX IF EXISTS tasks_project_priority_updated_idx;
DROP EXTENSION IF EXISTS pg_trgm;
