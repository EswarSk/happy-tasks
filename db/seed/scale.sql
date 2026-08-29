\set ON_ERROR_STOP on

\if :{?task_count}
\else
    \set task_count 10000
\endif

\if :{?comment_count}
\else
    \set comment_count 1000
\endif

BEGIN;

INSERT INTO users (id, display_name, email, created_at)
VALUES
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

INSERT INTO projects (id, organization_id, name, description, metadata, version, created_at, updated_at)
VALUES (
    '02000000-0000-7000-8000-000000000001',
    '00000000-0000-7000-8000-000000000100',
    'Scale Lab',
    'Deterministic dataset for pagination and hot-comment performance checks.',
    '{"color":"amber","seed":"scale"}',
    1,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_members (project_id, user_id, role)
SELECT '02000000-0000-7000-8000-000000000001', id,
       CASE WHEN id = '00000000-0000-7000-8000-000000000001'::uuid THEN 'OWNER' ELSE 'MEMBER' END
FROM users
WHERE id BETWEEN '00000000-0000-7000-8000-000000000001'::uuid AND '00000000-0000-7000-8000-000000000008'::uuid
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO project_streams (project_id, last_sequence)
VALUES ('02000000-0000-7000-8000-000000000001', 0)
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO tasks (
    id, project_id, title, description, status, priority, custom_fields,
    comment_count, version, created_by, created_at, updated_at
)
SELECT
    md5('scale-task-' || item.number::text)::uuid,
    '02000000-0000-7000-8000-000000000001'::uuid,
    'Scale task ' || lpad(item.number::text, 5, '0'),
    'Deterministic task generated for cursor pagination and virtualization tests.',
    (ARRAY['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']::task_status[])[1 + (item.number % 4)],
    (ARRAY['LOW', 'MEDIUM', 'HIGH', 'URGENT']::task_priority[])[1 + (item.number % 4)],
    jsonb_build_object(
        'area', (ARRAY['api', 'web', 'sync', 'quality'])[1 + (item.number % 4)],
        'estimate', 1 + (item.number % 8)
    ),
    0,
    1,
    '00000000-0000-7000-8000-000000000001'::uuid,
    '2026-01-01T00:00:00Z'::timestamptz + make_interval(secs => item.number),
    '2026-01-01T00:00:00Z'::timestamptz + make_interval(secs => item.number)
FROM generate_series(1, :task_count::integer) AS item(number)
ON CONFLICT (id) DO NOTHING;

INSERT INTO task_assignees (project_id, task_id, user_id)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    '00000000-0000-7000-8000-000000000001'::uuid
FROM generate_series(1, :task_count::integer) AS item(number)
ON CONFLICT (task_id, user_id) DO NOTHING;

INSERT INTO task_tags (project_id, task_id, tag)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    (ARRAY['backend', 'frontend', 'realtime', 'testing'])[1 + (item.number % 4)]
FROM generate_series(1, :task_count::integer) AS item(number)
ON CONFLICT (task_id, tag) DO NOTHING;

INSERT INTO task_dependencies (
    project_id, task_id, depends_on_task_id, created_by, created_at
)
SELECT
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-' || item.number::text)::uuid,
    md5('scale-task-' || (item.number - 1)::text)::uuid,
    '00000000-0000-7000-8000-000000000001'::uuid,
    '2026-01-02T00:00:00Z'::timestamptz + make_interval(secs => item.number)
FROM generate_series(2, :task_count::integer) AS item(number)
ON CONFLICT (task_id, depends_on_task_id) DO NOTHING;

INSERT INTO comments (
    id, project_id, task_id, author_id, body, version, created_at
)
SELECT
    md5('scale-comment-' || item.number::text)::uuid,
    '02000000-0000-7000-8000-000000000001'::uuid,
    md5('scale-task-1')::uuid,
    '00000000-0000-7000-8000-000000000001'::uuid,
    'Scale comment ' || lpad(item.number::text, 6, '0'),
    1,
    '2026-02-01T00:00:00Z'::timestamptz + make_interval(secs => item.number)
FROM generate_series(1, :comment_count::integer) AS item(number)
ON CONFLICT (id) DO NOTHING;

UPDATE tasks
SET comment_count = (
    SELECT count(*)::bigint
    FROM comments
    WHERE project_id = '02000000-0000-7000-8000-000000000001'
      AND task_id = md5('scale-task-1')::uuid
      AND deleted_at IS NULL
)
WHERE project_id = '02000000-0000-7000-8000-000000000001'
  AND id = md5('scale-task-1')::uuid;

COMMIT;

ANALYZE tasks;
ANALYZE task_assignees;
ANALYZE task_tags;
ANALYZE task_dependencies;
ANALYZE comments;
