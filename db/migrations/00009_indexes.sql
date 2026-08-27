-- +goose Up
CREATE INDEX projects_updated_idx
    ON projects (updated_at DESC, id DESC);

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

-- +goose Down
DROP INDEX IF EXISTS idempotency_expiry_idx;
DROP INDEX IF EXISTS sync_events_retention_idx;
DROP INDEX IF EXISTS comments_task_time_idx;
DROP INDEX IF EXISTS task_dependencies_reverse_idx;
DROP INDEX IF EXISTS task_dependencies_forward_idx;
DROP INDEX IF EXISTS task_tags_tag_idx;
DROP INDEX IF EXISTS task_assignees_user_idx;
DROP INDEX IF EXISTS tasks_project_status_updated_idx;
DROP INDEX IF EXISTS tasks_project_updated_idx;
DROP INDEX IF EXISTS projects_updated_idx;
