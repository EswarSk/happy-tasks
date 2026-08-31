\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, display_name, email, created_at) VALUES
    ('00000000-0000-7000-8000-000000000001', 'Maya Chen', 'maya@example.test', '2026-08-20T14:00:00Z'),
    ('00000000-0000-7000-8000-000000000002', 'Noah Williams', 'noah@example.test', '2026-08-20T14:01:00Z'),
    ('00000000-0000-7000-8000-000000000003', 'Priya Shah', 'priya@example.test', '2026-08-20T14:02:00Z')
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET password_hash = '$2a$10$PRAkSHebPVAcPzrNi9B5oe.nUjc3ZEyJdBf47pvpkg2jleyQCXYP.'
WHERE id IN ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003')
  AND password_hash IS NULL;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT '00000000-0000-7000-8000-000000000100', id,
       CASE WHEN id = '00000000-0000-7000-8000-000000000001'::uuid THEN 'OWNER' ELSE 'MEMBER' END
FROM users
WHERE id IN (
    '00000000-0000-7000-8000-000000000001',
    '00000000-0000-7000-8000-000000000002',
    '00000000-0000-7000-8000-000000000003'
)
ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO projects (id, organization_id, name, description, metadata, version, created_at, updated_at) VALUES
    (
        '01000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000100',
        'Realtime Launch',
        '[Shared demo project — every new account joins this one automatically] Ship a reliable collaborative task workspace.',
        '{"color":"indigo","team":"Platform"}',
        1,
        '2026-08-21T09:00:00Z',
        '2026-08-25T16:30:00Z'
    ),
    (
        '01000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-000000000100',
        'Mobile Experience',
        '[Shared demo project — every new account joins this one automatically] Plan the responsive workspace and offline states.',
        '{"color":"emerald","team":"Product"}',
        1,
        '2026-08-22T09:00:00Z',
        '2026-08-25T15:00:00Z'
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_members (project_id, user_id, role) VALUES
    ('01000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', 'OWNER'),
    ('01000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'MEMBER'),
    ('01000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000003', 'MEMBER'),
    ('01000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'OWNER'),
    ('01000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003', 'MEMBER')
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO tasks (
    id, project_id, title, description, status, priority, custom_fields,
    version, created_by, created_at, updated_at
) VALUES
    (
        '10000000-0000-7000-8000-000000000001',
        '01000000-0000-7000-8000-000000000001',
        'Design durable event envelope',
        'Define compact events with project-local sequences and entity versions.',
        'DONE', 'HIGH', '{"area":"sync","estimate":3}', 3,
        '00000000-0000-7000-8000-000000000001',
        '2026-08-21T10:00:00Z', '2026-08-25T15:00:00Z'
    ),
    (
        '10000000-0000-7000-8000-000000000002',
        '01000000-0000-7000-8000-000000000001',
        'Implement SSE replay',
        'Replay durable project events before switching to the live tail.',
        'IN_PROGRESS', 'URGENT', '{"area":"sync","estimate":5}', 2,
        '00000000-0000-7000-8000-000000000001',
        '2026-08-21T10:15:00Z', '2026-08-25T15:30:00Z'
    ),
    (
        '10000000-0000-7000-8000-000000000003',
        '01000000-0000-7000-8000-000000000001',
        'Build virtualized task list',
        'Render only visible task rows while pages load by cursor.',
        'IN_PROGRESS', 'HIGH', '{"area":"web","estimate":5}', 2,
        '00000000-0000-7000-8000-000000000002',
        '2026-08-21T10:30:00Z', '2026-08-25T16:00:00Z'
    ),
    (
        '10000000-0000-7000-8000-000000000004',
        '01000000-0000-7000-8000-000000000001',
        'Verify reconnect recovery',
        'Cover disconnect, missed events, replay, and duplicate delivery.',
        'TODO', 'HIGH', '{"area":"quality","estimate":3}', 1,
        '00000000-0000-7000-8000-000000000003',
        '2026-08-22T09:00:00Z', '2026-08-25T13:00:00Z'
    ),
    (
        '10000000-0000-7000-8000-000000000005',
        '01000000-0000-7000-8000-000000000001',
        'Record performance baseline',
        'Measure list latency and event payload sizes with 10,000 tasks.',
        'BLOCKED', 'MEDIUM', '{"area":"platform","estimate":2}', 1,
        '00000000-0000-7000-8000-000000000001',
        '2026-08-22T09:20:00Z', '2026-08-25T12:00:00Z'
    ),
    (
        '10000000-0000-7000-8000-000000000006',
        '01000000-0000-7000-8000-000000000002',
        'Define compact task cards',
        'Adapt table fields into a scannable mobile card.',
        'TODO', 'MEDIUM', '{"area":"mobile","estimate":2}', 1,
        '00000000-0000-7000-8000-000000000003',
        '2026-08-22T10:00:00Z', '2026-08-25T11:00:00Z'
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO task_assignees (project_id, task_id, user_id) VALUES
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000002'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000002'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000003'),
    ('01000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000006', '00000000-0000-7000-8000-000000000003')
ON CONFLICT (task_id, user_id) DO NOTHING;

INSERT INTO task_tags (project_id, task_id, tag) VALUES
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'architecture'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'realtime'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000002', 'backend'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000002', 'realtime'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000003', 'frontend'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000004', 'testing'),
    ('01000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000005', 'performance'),
    ('01000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000006', 'mobile')
ON CONFLICT (task_id, tag) DO NOTHING;

INSERT INTO task_dependencies (
    project_id, task_id, depends_on_task_id, created_by, created_at
) VALUES
    (
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000002',
        '10000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000001',
        '2026-08-23T10:00:00Z'
    ),
    (
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000004',
        '10000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-000000000003',
        '2026-08-23T10:05:00Z'
    ),
    (
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000005',
        '10000000-0000-7000-8000-000000000003',
        '00000000-0000-7000-8000-000000000001',
        '2026-08-23T10:10:00Z'
    )
ON CONFLICT (task_id, depends_on_task_id) DO NOTHING;

INSERT INTO comments (
    id, project_id, task_id, parent_id, author_id, body, version, created_at
) VALUES
    (
        '20000000-0000-7000-8000-000000000001',
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000002',
        NULL,
        '00000000-0000-7000-8000-000000000002',
        'Replay should begin after the bootstrap cursor so no update falls into a gap.',
        1, '2026-08-25T14:00:00Z'
    ),
    (
        '20000000-0000-7000-8000-000000000002',
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000002',
        '20000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000001',
        'Agreed. Notifications are wake-up hints; durable rows remain authoritative.',
        1, '2026-08-25T14:05:00Z'
    ),
    (
        '20000000-0000-7000-8000-000000000003',
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000003',
        NULL,
        '00000000-0000-7000-8000-000000000003',
        'The list stays smooth with 10,000 seeded tasks on my machine.',
        1, '2026-08-25T15:20:00Z'
    ),
    (
        '20000000-0000-7000-8000-000000000004',
        '01000000-0000-7000-8000-000000000001',
        '10000000-0000-7000-8000-000000000003',
        '20000000-0000-7000-8000-000000000003',
        '00000000-0000-7000-8000-000000000001',
        'That is excellent. I will capture the query plan and frame timing in the demo notes.',
        1, '2026-08-25T15:24:00Z'
    )
ON CONFLICT (id) DO UPDATE
SET parent_id = EXCLUDED.parent_id;

INSERT INTO notifications (
    id, project_id, user_id, task_id, comment_id, actor_id,
    notification_type, body, created_at
) VALUES (
    '40000000-0000-7000-8000-000000000001',
    '01000000-0000-7000-8000-000000000001',
    '00000000-0000-7000-8000-000000000001',
    '10000000-0000-7000-8000-000000000002',
    '20000000-0000-7000-8000-000000000001',
    '00000000-0000-7000-8000-000000000002',
    'MENTION', 'You were mentioned in a comment.', '2026-08-25T14:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

UPDATE tasks AS task
SET comment_count = counts.total
FROM (
    SELECT project_id, task_id, count(*)::bigint AS total
    FROM comments
    WHERE deleted_at IS NULL
    GROUP BY project_id, task_id
) AS counts
WHERE task.project_id = counts.project_id
  AND task.id = counts.task_id;

INSERT INTO agent_runs (
    id, project_id, task_id, orchestrator, external_run_id, workflow_name,
    definition_id, definition_version, status, started_at, created_at, updated_at
) VALUES (
    '50000000-0000-7000-8000-000000000001',
    '01000000-0000-7000-8000-000000000001',
    '10000000-0000-7000-8000-000000000002',
    'happyrobot', 'hr-run-sse-replay-001', 'Ship SSE replay',
    'workflow-sse-replay', '7', 'RUNNING',
    '2026-08-30T17:20:00Z', '2026-08-30T17:20:00Z', '2026-08-30T17:23:00Z'
)
ON CONFLICT (project_id, orchestrator, external_run_id) DO UPDATE
SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;

INSERT INTO agent_run_nodes (
    id, run_id, external_node_id, agent_name, label, node_type, status,
    position_x, position_y, output, started_at, completed_at, updated_at
) VALUES
    ('51000000-0000-7000-8000-000000000001', '50000000-0000-7000-8000-000000000001', 'plan', 'Coordinator', 'Plan execution', 'orchestrator', 'SUCCEEDED', 120, 240, '{"steps":4}', '2026-08-30T17:20:00Z', '2026-08-30T17:20:08Z', '2026-08-30T17:20:08Z'),
    ('51000000-0000-7000-8000-000000000002', '50000000-0000-7000-8000-000000000001', 'inspect', 'Repository analyst', 'Inspect replay path', 'agent', 'SUCCEEDED', 450, 100, '{"filesRead":8}', '2026-08-30T17:20:08Z', '2026-08-30T17:21:14Z', '2026-08-30T17:21:14Z'),
    ('51000000-0000-7000-8000-000000000003', '50000000-0000-7000-8000-000000000001', 'implement', 'Backend agent', 'Implement replay recovery', 'agent', 'RUNNING', 450, 380, '{}', '2026-08-30T17:21:14Z', NULL, '2026-08-30T17:23:00Z'),
    ('51000000-0000-7000-8000-000000000004', '50000000-0000-7000-8000-000000000001', 'verify', 'Verification agent', 'Run reconnect scenarios', 'agent', 'PENDING', 800, 240, '{}', NULL, NULL, '2026-08-30T17:20:00Z')
ON CONFLICT (run_id, external_node_id) DO UPDATE
SET status = EXCLUDED.status, output = EXCLUDED.output, started_at = EXCLUDED.started_at,
    completed_at = EXCLUDED.completed_at, updated_at = EXCLUDED.updated_at;

INSERT INTO agent_run_edges (run_id, source_node_id, target_node_id) VALUES
    ('50000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000002'),
    ('50000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000003'),
    ('50000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000002', '51000000-0000-7000-8000-000000000004'),
    ('50000000-0000-7000-8000-000000000001', '51000000-0000-7000-8000-000000000003', '51000000-0000-7000-8000-000000000004')
ON CONFLICT DO NOTHING;

INSERT INTO agent_run_events (
    run_id, sequence, external_event_id, node_id, event_type, message, payload, occurred_at
) VALUES
    ('50000000-0000-7000-8000-000000000001', 1, 'hr-event-001', NULL, 'run.started', 'Workflow run started', '{}', '2026-08-30T17:20:00Z'),
    ('50000000-0000-7000-8000-000000000001', 2, 'hr-event-002', '51000000-0000-7000-8000-000000000001', 'node.succeeded', 'Execution plan created with four steps', '{"durationMs":8000}', '2026-08-30T17:20:08Z'),
    ('50000000-0000-7000-8000-000000000001', 3, 'hr-event-003', '51000000-0000-7000-8000-000000000002', 'node.succeeded', 'Replay and reconnect paths inspected', '{"durationMs":66000}', '2026-08-30T17:21:14Z'),
    ('50000000-0000-7000-8000-000000000001', 4, 'hr-event-004', '51000000-0000-7000-8000-000000000003', 'node.started', 'Implementing durable replay recovery', '{}', '2026-08-30T17:21:14Z'),
    ('50000000-0000-7000-8000-000000000001', 5, 'hr-event-005', '51000000-0000-7000-8000-000000000003', 'node.progress', 'Added gap detection; wiring recovery tests', '{"progress":60}', '2026-08-30T17:23:00Z')
ON CONFLICT DO NOTHING;

INSERT INTO project_streams (project_id, last_sequence) VALUES
    ('01000000-0000-7000-8000-000000000001', 4),
    ('01000000-0000-7000-8000-000000000002', 0)
ON CONFLICT (project_id) DO UPDATE
SET last_sequence = GREATEST(project_streams.last_sequence, EXCLUDED.last_sequence);

INSERT INTO sync_events (
    project_id, sequence, event_type, aggregate_type, aggregate_id,
    aggregate_version, actor_id, request_id, payload, occurred_at
) VALUES
    (
        '01000000-0000-7000-8000-000000000001', 1,
        'task.updated', 'task', '10000000-0000-7000-8000-000000000001', 3,
        '00000000-0000-7000-8000-000000000001',
        '30000000-0000-7000-8000-000000000001',
        '{"id":"10000000-0000-7000-8000-000000000001","projectId":"01000000-0000-7000-8000-000000000001","title":"Design durable event envelope","status":"DONE","version":3}',
        '2026-08-25T15:00:00Z'
    ),
    (
        '01000000-0000-7000-8000-000000000001', 2,
        'comment.created', 'comment', '20000000-0000-7000-8000-000000000001', 1,
        '00000000-0000-7000-8000-000000000002',
        '30000000-0000-7000-8000-000000000002',
        '{"id":"20000000-0000-7000-8000-000000000001","projectId":"01000000-0000-7000-8000-000000000001","taskId":"10000000-0000-7000-8000-000000000002","body":"Replay should begin after the bootstrap cursor so no update falls into a gap.","version":1}',
        '2026-08-25T15:05:00Z'
    ),
    (
        '01000000-0000-7000-8000-000000000001', 3,
        'task.updated', 'task', '10000000-0000-7000-8000-000000000003', 2,
        '00000000-0000-7000-8000-000000000002',
        '30000000-0000-7000-8000-000000000003',
        '{"id":"10000000-0000-7000-8000-000000000003","projectId":"01000000-0000-7000-8000-000000000001","title":"Build virtualized task list","status":"IN_PROGRESS","version":2}',
        '2026-08-25T16:00:00Z'
    ),
    (
        '01000000-0000-7000-8000-000000000001', 4,
        'comment.created', 'comment', '20000000-0000-7000-8000-000000000003', 1,
        '00000000-0000-7000-8000-000000000003',
        '30000000-0000-7000-8000-000000000004',
        '{"id":"20000000-0000-7000-8000-000000000003","projectId":"01000000-0000-7000-8000-000000000001","taskId":"10000000-0000-7000-8000-000000000003","body":"The list stays smooth with 10,000 seeded tasks on my machine.","version":1}',
        '2026-08-25T16:20:00Z'
    )
ON CONFLICT DO NOTHING;

COMMIT;
