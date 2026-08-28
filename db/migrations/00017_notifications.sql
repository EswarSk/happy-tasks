-- +goose Up
CREATE TABLE notifications (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    comment_id uuid NOT NULL,
    actor_id uuid NOT NULL REFERENCES users(id),
    notification_type text NOT NULL CHECK (notification_type = 'MENTION'),
    body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id),
    FOREIGN KEY (project_id, comment_id) REFERENCES comments(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    UNIQUE (project_id, comment_id, user_id, notification_type)
);

CREATE INDEX notifications_user_unread_idx
    ON notifications (project_id, user_id, created_at DESC, id DESC)
    WHERE read_at IS NULL;

CREATE INDEX notifications_user_time_idx
    ON notifications (project_id, user_id, created_at DESC, id DESC);

-- +goose Down
DROP TABLE IF EXISTS notifications;
