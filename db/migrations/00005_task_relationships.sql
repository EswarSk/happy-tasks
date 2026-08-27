-- +goose Up
CREATE TABLE task_assignees (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    PRIMARY KEY (task_id, user_id),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, user_id)
        REFERENCES project_members(project_id, user_id)
);

CREATE TABLE task_tags (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    tag text NOT NULL CHECK (length(btrim(tag)) BETWEEN 1 AND 64),
    PRIMARY KEY (task_id, tag),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE TABLE task_dependencies (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    depends_on_task_id uuid NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id),
    FOREIGN KEY (project_id, task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, depends_on_task_id)
        REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS task_assignees;
