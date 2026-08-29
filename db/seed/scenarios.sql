\set ON_ERROR_STOP on

\if :{?task_count}
\else
    \set task_count 10000
\endif

\if :{?comment_count}
\else
    \set comment_count 12000
\endif

BEGIN;

-- These identities are shared by the deterministic scenario projects. The
-- first three intentionally match demo.sql so either seed can run first.
INSERT INTO users (id, display_name, email, created_at) VALUES
    ('00000000-0000-7000-8000-000000000001', 'Maya Chen', 'maya@example.test', '2026-08-20T14:00:00Z'),
    ('00000000-0000-7000-8000-000000000002', 'Noah Williams', 'noah@example.test', '2026-08-20T14:01:00Z'),
    ('00000000-0000-7000-8000-000000000003', 'Priya Shah', 'priya@example.test', '2026-08-20T14:02:00Z'),
    ('00000000-0000-7000-8000-000000000004', 'Mateo Silva', 'mateo@example.test', '2026-08-20T14:03:00Z'),
    ('00000000-0000-7000-8000-000000000005', 'Aisha Okafor', 'aisha@example.test', '2026-08-20T14:04:00Z'),
    ('00000000-0000-7000-8000-000000000006', 'Kenji Tanaka', 'kenji@example.test', '2026-08-20T14:05:00Z'),
    ('00000000-0000-7000-8000-000000000007', 'Sofia Rossi', 'sofia@example.test', '2026-08-20T14:06:00Z'),
    ('00000000-0000-7000-8000-000000000008', 'Omar Haddad', 'omar@example.test', '2026-08-20T14:07:00Z')
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET password_hash = '$2a$10$PRAkSHebPVAcPzrNi9B5oe.nUjc3ZEyJdBf47pvpkg2jleyQCXYP.'
WHERE id BETWEEN '00000000-0000-7000-8000-000000000001'::uuid AND '00000000-0000-7000-8000-000000000008'::uuid
  AND password_hash IS NULL;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT '00000000-0000-7000-8000-000000000100', id,
       CASE WHEN id = '00000000-0000-7000-8000-000000000001'::uuid THEN 'OWNER' ELSE 'MEMBER' END
FROM users
WHERE id BETWEEN '00000000-0000-7000-8000-000000000001'::uuid AND '00000000-0000-7000-8000-000000000008'::uuid
ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO projects (id, organization_id, name, description, metadata, version, created_at, updated_at) VALUES
    (
        '02000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000100',
        'Scale & Scenario Lab',
        'Ten-thousand-task workspace covering scale, collaboration, comments, filters, dependencies, conflicts, and UI edge cases.',
        '{"color":"amber","seed":"scenario-pack","fixture":true}',
        1,
        '2026-08-01T00:00:00Z',
        '2026-08-27T12:00:00Z'
    ),
    (
        '02000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-000000000100',
        'Empty Sandbox',
        'A deliberately empty project for loading, empty-state, first-task, and project-isolation tests.',
        '{"color":"slate","seed":"scenario-pack","fixture":true,"scenario":"empty"}',
        1,
        '2026-08-01T00:00:00Z',
        '2026-08-26T12:00:00Z'
    )
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    metadata = EXCLUDED.metadata,
    updated_at = EXCLUDED.updated_at;

INSERT INTO project_members (project_id, user_id, role)
SELECT
    project.id,
    member.id,
    CASE WHEN member.id = '00000000-0000-7000-8000-000000000001'::uuid THEN 'OWNER' ELSE 'MEMBER' END
FROM (
    VALUES
        ('02000000-0000-7000-8000-000000000001'::uuid),
        ('02000000-0000-7000-8000-000000000002'::uuid)
) AS project(id)
CROSS JOIN (
    VALUES
        ('00000000-0000-7000-8000-000000000001'::uuid),
        ('00000000-0000-7000-8000-000000000002'::uuid),
        ('00000000-0000-7000-8000-000000000003'::uuid),
        ('00000000-0000-7000-8000-000000000004'::uuid),
        ('00000000-0000-7000-8000-000000000005'::uuid),
        ('00000000-0000-7000-8000-000000000006'::uuid),
        ('00000000-0000-7000-8000-000000000007'::uuid),
        ('00000000-0000-7000-8000-000000000008'::uuid)
) AS member(id)
ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role;

INSERT INTO project_streams (project_id, last_sequence) VALUES
    ('02000000-0000-7000-8000-000000000001', 0),
    ('02000000-0000-7000-8000-000000000002', 0)
ON CONFLICT (project_id) DO NOTHING;

-- Re-running this seed resets only the two explicitly marked fixture projects.
-- This keeps the scenario pack deterministic without touching user projects.
DELETE FROM sync_events
WHERE project_id IN (
    '02000000-0000-7000-8000-000000000001',
    '02000000-0000-7000-8000-000000000002'
);
DELETE FROM tasks
WHERE project_id IN (
    '02000000-0000-7000-8000-000000000001',
    '02000000-0000-7000-8000-000000000002'
);
UPDATE project_streams
SET last_sequence = 0
WHERE project_id IN (
    '02000000-0000-7000-8000-000000000001',
    '02000000-0000-7000-8000-000000000002'
);

INSERT INTO tasks (
    id, project_id, title, description, status, priority, custom_fields,
    comment_count, version, created_by, created_at, updated_at
)
SELECT
    md5('scale-task-' || item.number::text)::uuid,
    '02000000-0000-7000-8000-000000000001'::uuid,
    CASE
        WHEN item.number = :task_count::integer THEN '[P0] Checkout retry storm affecting enterprise customers'
        WHEN item.number = :task_count::integer - 1 THEN '[Release] Ship version 3.14.0 across web, API, and worker fleets'
        WHEN item.number = :task_count::integer - 2 THEN '[Unassigned] Clarify ownership before the planning review'
        WHEN item.number = :task_count::integer - 3 THEN '[Layout] This deliberately long task title verifies truncation, responsive wrapping, keyboard focus, and detail-panel readability without allowing one record to distort the entire virtualized list'
        WHEN item.number = :task_count::integer - 4 THEN '[i18n] Verify 日本語, العربية, हिन्दी, emoji 🚀, and accented text café'
        WHEN item.number = :task_count::integer - 5 THEN '[Minimal] Valid task with no description, tags, assignees, or comments'
        WHEN item.number = :task_count::integer - 6 THEN '[Comments] Hot thread with thousands of chronological replies'
        WHEN item.number = :task_count::integer - 7 THEN '[Dependencies] Cycle rejection lab — final node'
        WHEN item.number = :task_count::integer - 8 THEN '[Offline] Reconnect after missed project events'
        WHEN item.number = :task_count::integer - 9 THEN '[Conflict] Two clients edit the same task version'
        WHEN item.number = :task_count::integer - 10 THEN '[Transitions] Exercise every valid and invalid status move'
        ELSE 'Scale task ' || lpad(item.number::text, 5, '0') || ' · ' ||
             (ARRAY['API reliability', 'Frontend polish', 'Realtime sync', 'Quality automation', 'Security review', 'Data migration'])[1 + (item.number % 6)]
    END,
    CASE
        WHEN item.number = :task_count::integer THEN E'Customer-visible retry traffic is saturating checkout workers.\n\nAcceptance criteria:\n• cap retries with jitter\n• preserve idempotency\n• publish recovery metrics\n• document rollback ownership'
        WHEN item.number = :task_count::integer - 1 THEN 'Coordinate a staged release with explicit owners, rollback criteria, and a final go/no-go checkpoint.'
        WHEN item.number = :task_count::integer - 2 THEN 'This record intentionally has no assignee so ownership and filtering states are visible.'
        WHEN item.number = :task_count::integer - 3 THEN repeat('Long-form acceptance notes exercise scrolling, wrapping, and editing without increasing list-row height. ', 12)
        WHEN item.number = :task_count::integer - 4 THEN E'International content must remain searchable and readable.\nSecond line: 東京 · القاهرة · Bengaluru · São Paulo.'
        WHEN item.number = :task_count::integer - 5 THEN ''
        WHEN item.number = :task_count::integer - 6 THEN 'A single hot task models incident-room and launch-thread comment traffic while the rest of the project remains responsive.'
        WHEN item.number = :task_count::integer - 7 THEN 'This task depends on the reconnect task, which depends on the conflict task. Adding the final reverse edge must be rejected as a cycle.'
        WHEN item.number = :task_count::integer - 8 THEN 'Disconnect a client, mutate from another client, and verify ordered replay from the last applied sequence.'
        WHEN item.number = :task_count::integer - 9 THEN 'Open this task in two clients. Save from one, then submit the stale version from the other to receive a 409 conflict.'
        WHEN item.number = :task_count::integer - 10 THEN 'Move through TODO, IN_PROGRESS, BLOCKED, and DONE while confirming forbidden transitions return a stable domain error.'
        ELSE 'Deterministic fixture for cursor pagination, virtualization, filtering, optimistic mutations, and project-scoped synchronization.'
    END,
    CASE
        WHEN item.number = :task_count::integer THEN 'BLOCKED'
        WHEN item.number = :task_count::integer - 1 THEN 'DONE'
        WHEN item.number = :task_count::integer - 2 THEN 'TODO'
        WHEN item.number = :task_count::integer - 6 THEN 'IN_PROGRESS'
        WHEN item.number = :task_count::integer - 7 THEN 'BLOCKED'
        WHEN item.number = :task_count::integer - 8 THEN 'IN_PROGRESS'
        WHEN item.number = :task_count::integer - 9 THEN 'TODO'
        ELSE (ARRAY['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']::task_status[])[1 + (item.number % 4)]
    END,
    CASE
        WHEN item.number = :task_count::integer THEN 'URGENT'
        WHEN item.number = :task_count::integer - 1 THEN 'HIGH'
        WHEN item.number = :task_count::integer - 2 THEN 'LOW'
        WHEN item.number = :task_count::integer - 6 THEN 'HIGH'
        ELSE (ARRAY['LOW', 'MEDIUM', 'HIGH', 'URGENT']::task_priority[])[1 + ((item.number / 4) % 4)]
    END,
    jsonb_build_object(
        'area', (ARRAY['api', 'web', 'sync', 'quality', 'security', 'data'])[1 + (item.number % 6)],
        'estimate', 1 + (item.number % 13),
        'customerImpact', item.number % 19 = 0,
        'scenario', CASE WHEN item.number > :task_count::integer - 11 THEN 'named-edge-case' ELSE 'bulk-distribution' END,
        'releaseTrain', '2026.08'
    ),
    0,
    CASE WHEN item.number = :task_count::integer - 9 THEN 7 ELSE 1 + (item.number % 5) END,
    (ARRAY[
        '00000000-0000-7000-8000-000000000001'::uuid,
        '00000000-0000-7000-8000-000000000002'::uuid,
        '00000000-0000-7000-8000-000000000003'::uuid,
        '00000000-0000-7000-8000-000000000004'::uuid,
        '00000000-0000-7000-8000-000000000005'::uuid,
        '00000000-0000-7000-8000-000000000006'::uuid,
        '00000000-0000-7000-8000-000000000007'::uuid,
        '00000000-0000-7000-8000-000000000008'::uuid
    ])[1 + (item.number % 8)],
    '2026-01-01T00:00:00Z'::timestamptz + make_interval(secs => item.number),
    CASE
        WHEN item.number > :task_count::integer - 11
            THEN '2026-08-27T12:00:00Z'::timestamptz + make_interval(secs => item.number - (:task_count::integer - 10))
        ELSE '2026-08-01T00:00:00Z'::timestamptz + make_interval(secs => item.number)
    END
FROM generate_series(1, :task_count::integer) AS item(number);

-- Unassigned, single-assignee, and multi-assignee distributions.
INSERT INTO task_assignees (project_id, task_id, user_id)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    (ARRAY[
        '00000000-0000-7000-8000-000000000001'::uuid,
        '00000000-0000-7000-8000-000000000002'::uuid,
        '00000000-0000-7000-8000-000000000003'::uuid,
        '00000000-0000-7000-8000-000000000004'::uuid,
        '00000000-0000-7000-8000-000000000005'::uuid,
        '00000000-0000-7000-8000-000000000006'::uuid,
        '00000000-0000-7000-8000-000000000007'::uuid,
        '00000000-0000-7000-8000-000000000008'::uuid
    ])[1 + (item.number % 8)]
FROM generate_series(1, :task_count::integer) AS item(number)
WHERE item.number % 11 <> 0
  AND item.number <> :task_count::integer - 2;

INSERT INTO task_assignees (project_id, task_id, user_id)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    (ARRAY[
        '00000000-0000-7000-8000-000000000001'::uuid,
        '00000000-0000-7000-8000-000000000002'::uuid,
        '00000000-0000-7000-8000-000000000003'::uuid,
        '00000000-0000-7000-8000-000000000004'::uuid,
        '00000000-0000-7000-8000-000000000005'::uuid,
        '00000000-0000-7000-8000-000000000006'::uuid,
        '00000000-0000-7000-8000-000000000007'::uuid,
        '00000000-0000-7000-8000-000000000008'::uuid
    ])[1 + ((item.number + 3) % 8)]
FROM generate_series(1, :task_count::integer) AS item(number)
WHERE item.number % 17 = 0 OR item.number = :task_count::integer
ON CONFLICT (task_id, user_id) DO NOTHING;

INSERT INTO task_assignees (project_id, task_id, user_id)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || :task_count::integer::text)::uuid,
    '00000000-0000-7000-8000-000000000006'::uuid
WHERE :task_count::integer >= 1
ON CONFLICT (task_id, user_id) DO NOTHING;

-- No-tag, one-tag, and multi-tag distributions.
INSERT INTO task_tags (project_id, task_id, tag)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    CASE
        WHEN item.number = :task_count::integer THEN 'incident'
        WHEN item.number = :task_count::integer - 1 THEN 'release'
        WHEN item.number = :task_count::integer - 6 THEN 'hot-thread'
        ELSE (ARRAY['backend', 'frontend', 'realtime', 'testing', 'security', 'migration'])[1 + (item.number % 6)]
    END
FROM generate_series(1, :task_count::integer) AS item(number)
WHERE item.number % 9 <> 0
  AND item.number <> :task_count::integer - 5;

INSERT INTO task_tags (project_id, task_id, tag)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    (ARRAY['customer-impact', 'needs-review', 'performance', 'accessibility'])[1 + (item.number % 4)]
FROM generate_series(1, :task_count::integer) AS item(number)
WHERE item.number % 13 = 0 OR item.number > :task_count::integer - 5
ON CONFLICT (task_id, tag) DO NOTHING;

-- Sparse chains keep most tasks independent while still creating thousands of
-- graph edges for joins and cycle checks.
INSERT INTO task_dependencies (
    project_id, task_id, depends_on_task_id, created_by, created_at
)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    md5('scale-task-' || (item.number - 1)::text)::uuid,
    '00000000-0000-7000-8000-000000000001'::uuid,
    '2026-08-10T00:00:00Z'::timestamptz + make_interval(secs => item.number)
FROM generate_series(2, :task_count::integer) AS item(number)
WHERE item.number % 5 = 0;

-- Named graph cases: fan-in, diamond, and a three-node path whose reverse edge
-- would create a cycle. These tasks are all near the top of the default list.
INSERT INTO task_dependencies (
    project_id, task_id, depends_on_task_id, created_by, created_at
)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || edge.task_number::text)::uuid,
    md5('scale-task-' || edge.dependency_number::text)::uuid,
    '00000000-0000-7000-8000-000000000001'::uuid,
    '2026-08-26T00:00:00Z'::timestamptz + make_interval(secs => edge.ordinal)
FROM (
    VALUES
        (1, :task_count::integer,     :task_count::integer - 1),
        (2, :task_count::integer,     :task_count::integer - 2),
        (3, :task_count::integer - 3, :task_count::integer - 4),
        (4, :task_count::integer - 3, :task_count::integer - 5),
        (5, :task_count::integer - 4, :task_count::integer - 6),
        (6, :task_count::integer - 5, :task_count::integer - 6),
        (7, :task_count::integer - 7, :task_count::integer - 8),
        (8, :task_count::integer - 8, :task_count::integer - 9)
) AS edge(ordinal, task_number, dependency_number)
WHERE edge.task_number >= 1 AND edge.dependency_number >= 1
ON CONFLICT (task_id, depends_on_task_id) DO NOTHING;

-- Comment scenarios include a 2,500-comment hot thread, normal distributed
-- threads, multiple authors, multiline text, unicode, mentions, code snippets,
-- and long-but-valid content. The total remains configurable.
INSERT INTO comments (
    id, project_id, task_id, author_id, body, version, created_at
)
SELECT
    md5('scale-comment-' || item.number::text)::uuid,
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || (
        CASE
            WHEN item.number <= LEAST(:comment_count::integer, 2500)
                THEN GREATEST(1, :task_count::integer - 6)
            WHEN item.number <= LEAST(:comment_count::integer, 2520)
                THEN :task_count::integer
            WHEN item.number <= LEAST(:comment_count::integer, 2540)
                THEN GREATEST(1, :task_count::integer - 8)
            ELSE 1 + ((item.number - 2541) % (:task_count::integer - 11))
        END
    )::text)::uuid,
    (ARRAY[
        '00000000-0000-7000-8000-000000000001'::uuid,
        '00000000-0000-7000-8000-000000000002'::uuid,
        '00000000-0000-7000-8000-000000000003'::uuid,
        '00000000-0000-7000-8000-000000000004'::uuid,
        '00000000-0000-7000-8000-000000000005'::uuid,
        '00000000-0000-7000-8000-000000000006'::uuid,
        '00000000-0000-7000-8000-000000000007'::uuid,
        '00000000-0000-7000-8000-000000000008'::uuid
    ])[1 + (item.number % 8)],
    CASE item.number % 10
        WHEN 0 THEN '@Maya could you verify the latest acceptance criteria before the next deploy?'
        WHEN 1 THEN E'Reproduction steps:\n1. Disconnect client B\n2. Update from client A\n3. Reconnect B and verify ordered replay.'
        WHEN 2 THEN 'Localization check: 東京 · القاهرة · हिन्दी · café · 🚀 renders correctly.'
        WHEN 3 THEN 'Conflict test uses If-Match: "7" and expects HTTP 409 with the current server entity.'
        WHEN 4 THEN repeat('Detailed incident context remains readable and within the 10,000-character validation limit. ', 8)
        WHEN 5 THEN 'Decision: keep PostgreSQL as the authority; use notifications only as wake-up hints.'
        WHEN 6 THEN 'Blocked until the dependency owner confirms the migration window.'
        WHEN 7 THEN 'The virtualized list stayed responsive while this thread was receiving updates.'
        WHEN 8 THEN '✅ Reviewed on desktop and mobile. Keyboard focus and empty states look correct.'
        ELSE 'Scenario comment ' || lpad(item.number::text, 6, '0') || ' for deterministic cursor pagination.'
    END,
    1,
    '2026-08-20T00:00:00Z'::timestamptz + make_interval(secs => item.number)
FROM generate_series(1, :comment_count::integer) AS item(number);

UPDATE tasks AS task
SET comment_count = COALESCE(counts.total, 0)
FROM (
    SELECT seeded.id, count(comment.id)::bigint AS total
    FROM tasks AS seeded
    LEFT JOIN comments AS comment
      ON comment.project_id = seeded.project_id
     AND comment.task_id = seeded.id
     AND comment.deleted_at IS NULL
    WHERE seeded.project_id = '02000000-0000-7000-8000-000000000001'
    GROUP BY seeded.id
) AS counts
WHERE task.project_id = '02000000-0000-7000-8000-000000000001'
  AND task.id = counts.id;

-- A compact history enables replay/cursor testing without creating an event
-- row for every seeded entity.
INSERT INTO sync_events (
    project_id, sequence, event_type, aggregate_type, aggregate_id,
    aggregate_version, actor_id, request_id, payload, occurred_at
)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    event.number,
    'task.updated',
    'task',
    md5('scale-task-' || (:task_count::integer - event.number + 1)::text)::uuid,
    1,
    '00000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-event-' || event.number::text)::uuid,
    jsonb_build_object(
        'id', md5('scale-task-' || (:task_count::integer - event.number + 1)::text)::uuid,
        'projectId', '02000000-0000-7000-8000-000000000001'::uuid,
        'seeded', true,
        'sequence', event.number
    ),
    '2026-08-27T10:00:00Z'::timestamptz + make_interval(secs => event.number)
FROM generate_series(1, LEAST(:task_count::integer, 200)) AS event(number);

UPDATE project_streams
SET last_sequence = LEAST(:task_count::integer, 200)
WHERE project_id = '02000000-0000-7000-8000-000000000001';

COMMIT;

ANALYZE tasks;
ANALYZE task_assignees;
ANALYZE task_tags;
ANALYZE task_dependencies;
ANALYZE comments;
ANALYZE sync_events;
