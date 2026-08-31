-- +goose Up
CREATE TABLE agent_runs (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    orchestrator text NOT NULL CHECK (length(btrim(orchestrator)) BETWEEN 1 AND 100),
    external_run_id text NOT NULL CHECK (length(btrim(external_run_id)) BETWEEN 1 AND 200),
    workflow_name text NOT NULL CHECK (length(btrim(workflow_name)) BETWEEN 1 AND 200),
    definition_id text NOT NULL CHECK (length(btrim(definition_id)) BETWEEN 1 AND 200),
    definition_version text NOT NULL CHECK (length(btrim(definition_version)) BETWEEN 1 AND 100),
    status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, orchestrator, external_run_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX agent_runs_task_latest_idx
    ON agent_runs (project_id, task_id, created_at DESC, id DESC);
CREATE INDEX agent_runs_active_idx
    ON agent_runs (project_id, updated_at DESC)
    WHERE status IN ('PENDING', 'RUNNING', 'WAITING');

CREATE TABLE agent_run_nodes (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    external_node_id text NOT NULL CHECK (length(btrim(external_node_id)) BETWEEN 1 AND 200),
    agent_name text NOT NULL CHECK (length(btrim(agent_name)) BETWEEN 1 AND 200),
    label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 300),
    node_type text NOT NULL CHECK (length(btrim(node_type)) BETWEEN 1 AND 100),
    status text NOT NULL CHECK (status IN ('PENDING', 'READY', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')),
    attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
    position_x integer NOT NULL,
    position_y integer NOT NULL,
    output jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output) = 'object'),
    error text,
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, id),
    UNIQUE (run_id, external_node_id),
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE agent_run_edges (
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    source_node_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    label text NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, source_node_id, target_node_id),
    FOREIGN KEY (run_id, source_node_id) REFERENCES agent_run_nodes(run_id, id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, target_node_id) REFERENCES agent_run_nodes(run_id, id) ON DELETE CASCADE,
    CHECK (source_node_id <> target_node_id)
);

CREATE INDEX agent_run_edges_target_idx ON agent_run_edges (run_id, target_node_id);

CREATE TABLE agent_run_events (
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence > 0),
    external_event_id text NOT NULL CHECK (length(btrim(external_event_id)) BETWEEN 1 AND 200),
    node_id uuid,
    event_type text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 100),
    message text NOT NULL DEFAULT '' CHECK (length(message) <= 10000),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, sequence),
    UNIQUE (run_id, external_event_id),
    FOREIGN KEY (run_id, node_id) REFERENCES agent_run_nodes(run_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS agent_run_edges;
DROP TABLE IF EXISTS agent_run_nodes;
DROP TABLE IF EXISTS agent_runs;
