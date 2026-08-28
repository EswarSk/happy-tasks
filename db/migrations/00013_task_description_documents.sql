-- +goose Up
-- Yjs updates are opaque to the Go API. The first client publishes a full
-- state snapshot; later clients publish incremental updates that can be
-- merged by every Yjs peer. Keeping the snapshot separate bounds reconnect
-- work without pretending the server understands the CRDT binary format.
CREATE TABLE task_description_documents (
    project_id  uuid NOT NULL,
    task_id     uuid NOT NULL,
    initialized boolean NOT NULL DEFAULT false,
    snapshot    bytea,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, task_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    CHECK ((initialized = false AND snapshot IS NULL) OR (initialized = true AND snapshot IS NOT NULL))
);

CREATE TABLE task_description_updates (
    id          bigserial PRIMARY KEY,
    project_id  uuid NOT NULL,
    task_id     uuid NOT NULL,
    actor_id    uuid NOT NULL REFERENCES users(id),
    update_data bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE INDEX task_description_updates_replay_idx
    ON task_description_updates (project_id, task_id, id);

-- +goose Down
DROP INDEX IF EXISTS task_description_updates_replay_idx;
DROP TABLE IF EXISTS task_description_updates;
DROP TABLE IF EXISTS task_description_documents;
