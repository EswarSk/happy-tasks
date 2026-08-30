\set ON_ERROR_STOP on

DO $$
DECLARE
    missing_tables text[];
BEGIN
    SELECT array_agg(expected.name ORDER BY expected.name)
    INTO missing_tables
    FROM (
        VALUES
            ('users'), ('projects'), ('project_members'), ('tasks'),
            ('task_assignees'), ('task_tags'), ('task_dependencies'),
            ('comments'), ('comment_reactions'), ('notifications'), ('project_streams'), ('sync_events'),
            ('idempotency_keys'), ('organizations'), ('organization_members'), ('auth_sessions'), ('task_attachments'),
            ('attachment_object_deletions')
    ) AS expected(name)
    WHERE to_regclass('public.' || expected.name) IS NULL;

    IF missing_tables IS NOT NULL THEN
        RAISE EXCEPTION 'missing expected tables: %', missing_tables;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'projects_organization_fkey'
          AND conrelid = 'projects'::regclass
    ) THEN
        RAISE EXCEPTION 'projects are missing organization isolation constraint';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = 'organization_members_user_active_idx'
    ) THEN
        RAISE EXCEPTION 'organization membership lookup index is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'task_attachments_byte_size_check'
          AND conrelid = 'task_attachments'::regclass
    ) THEN
        RAISE EXCEPTION 'attachment size constraint is missing';
    END IF;
END
$$;

DO $$
BEGIN
    BEGIN
        INSERT INTO task_dependencies (
            project_id, task_id, depends_on_task_id, created_by
        ) VALUES (
            '01000000-0000-7000-8000-000000000001',
            '10000000-0000-7000-8000-000000000002',
            '10000000-0000-7000-8000-000000000006',
            '00000000-0000-7000-8000-000000000001'
        );
        RAISE EXCEPTION 'cross-project dependency unexpectedly succeeded';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO comments (
            id, project_id, task_id, author_id, body
        ) VALUES (
            '2fffffff-0000-7000-8000-000000000001',
            '01000000-0000-7000-8000-000000000002',
            '10000000-0000-7000-8000-000000000006',
            '00000000-0000-7000-8000-000000000002',
            'This non-member comment must be rejected.'
        );
        RAISE EXCEPTION 'non-member comment unexpectedly succeeded';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO comments (
            id, project_id, task_id, parent_id, author_id, body
        ) VALUES (
            '2fffffff-0000-7000-8000-000000000002',
            '01000000-0000-7000-8000-000000000001',
            '10000000-0000-7000-8000-000000000003',
            '20000000-0000-7000-8000-000000000001',
            '00000000-0000-7000-8000-000000000001',
            'This cross-task reply must be rejected.'
        );
        RAISE EXCEPTION 'cross-task comment reply unexpectedly succeeded';
    EXCEPTION
        WHEN foreign_key_violation THEN NULL;
    END;
END
$$;

SELECT
    (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM projects) AS projects,
    (SELECT count(*) FROM tasks) AS tasks,
    (SELECT count(*) FROM comments) AS comments,
    (SELECT count(*) FROM sync_events) AS sync_events;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('tasks', 'comments', 'comment_reactions', 'sync_events')
ORDER BY tablename, indexname;

EXPLAIN (COSTS OFF)
SELECT id, task_id, author_id, body, version, created_at
FROM comments
WHERE project_id = '01000000-0000-7000-8000-000000000001'
  AND task_id = '10000000-0000-7000-8000-000000000002'
ORDER BY created_at DESC, id DESC
LIMIT 50;
