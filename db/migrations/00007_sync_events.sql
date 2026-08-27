-- +goose Up
CREATE TABLE project_streams (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE TABLE sync_events (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 50),
    aggregate_id uuid NOT NULL,
    aggregate_version bigint CHECK (aggregate_version IS NULL OR aggregate_version > 0),
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    request_id uuid NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, sequence),
    UNIQUE (request_id)
);

-- +goose Down
DROP TABLE IF EXISTS sync_events;
DROP TABLE IF EXISTS project_streams;
