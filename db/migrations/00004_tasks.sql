-- +goose Up
CREATE TABLE tasks (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
    description text NOT NULL DEFAULT '',
    status task_status NOT NULL DEFAULT 'TODO',
    priority task_priority NOT NULL DEFAULT 'MEDIUM',
    custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(custom_fields) = 'object'),
    comment_count bigint NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, id)
);

-- +goose Down
DROP TABLE IF EXISTS tasks;
