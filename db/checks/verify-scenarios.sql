\set ON_ERROR_STOP on

\if :{?task_count}
\else
    \set task_count 10000
\endif

\if :{?comment_count}
\else
    \set comment_count 12000
\endif

CREATE TEMP TABLE scenario_expectations (
    task_count integer NOT NULL,
    comment_count integer NOT NULL
);

INSERT INTO scenario_expectations VALUES (:task_count, :comment_count);

DO $$
DECLARE
    expected_tasks integer;
    expected_comments integer;
    actual integer;
BEGIN
    SELECT task_count, comment_count
    INTO expected_tasks, expected_comments
    FROM scenario_expectations;

    SELECT count(*) INTO actual
    FROM tasks
    WHERE project_id = '02000000-0000-7000-8000-000000000001';
    IF actual <> expected_tasks THEN
        RAISE EXCEPTION 'scenario task count %, expected %', actual, expected_tasks;
    END IF;

    SELECT count(*) INTO actual
    FROM comments
    WHERE project_id = '02000000-0000-7000-8000-000000000001';
    IF actual <> expected_comments THEN
        RAISE EXCEPTION 'scenario comment count %, expected %', actual, expected_comments;
    END IF;

    SELECT count(*) INTO actual
    FROM tasks
    WHERE project_id = '02000000-0000-7000-8000-000000000002';
    IF actual <> 0 THEN
        RAISE EXCEPTION 'empty sandbox unexpectedly has % tasks', actual;
    END IF;

    SELECT count(DISTINCT status) INTO actual
    FROM tasks
    WHERE project_id = '02000000-0000-7000-8000-000000000001';
    IF actual <> 4 THEN
        RAISE EXCEPTION 'expected all four task statuses, found %', actual;
    END IF;

    SELECT count(DISTINCT priority) INTO actual
    FROM tasks
    WHERE project_id = '02000000-0000-7000-8000-000000000001';
    IF actual <> 4 THEN
        RAISE EXCEPTION 'expected all four priorities, found %', actual;
    END IF;

    SELECT count(*) INTO actual
    FROM (
        SELECT DISTINCT status, priority
        FROM tasks
        WHERE project_id = '02000000-0000-7000-8000-000000000001'
    ) AS combinations;
    IF actual <> 16 THEN
        RAISE EXCEPTION 'expected all 16 status/priority combinations, found %', actual;
    END IF;

    SELECT count(*) INTO actual
    FROM tasks AS task
    WHERE task.project_id = '02000000-0000-7000-8000-000000000001'
      AND NOT EXISTS (SELECT 1 FROM task_assignees WHERE task_id = task.id);
    IF actual = 0 THEN
        RAISE EXCEPTION 'expected unassigned tasks';
    END IF;

    SELECT count(*) INTO actual
    FROM (
        SELECT task_id FROM task_assignees
        WHERE project_id = '02000000-0000-7000-8000-000000000001'
        GROUP BY task_id HAVING count(*) > 1
    ) AS multi_assigned;
    IF actual = 0 THEN
        RAISE EXCEPTION 'expected multi-assignee tasks';
    END IF;

    SELECT count(*) INTO actual
    FROM task_dependencies
    WHERE project_id = '02000000-0000-7000-8000-000000000001';
    IF actual < 8 THEN
        RAISE EXCEPTION 'expected dependency scenarios, found only % edges', actual;
    END IF;

    -- Protect the named dependency scenarios, not just the aggregate edge count.
    -- The final two edges form [Dependencies] -> [Offline] -> [Conflict], so the
    -- reverse [Conflict] -> [Dependencies] mutation must be rejected as a cycle.
    SELECT count(*) INTO actual
    FROM task_dependencies
    WHERE project_id = '02000000-0000-7000-8000-000000000001'
      AND (task_id, depends_on_task_id) IN (
          (md5('scale-task-' || (expected_tasks - 7)::text)::uuid, md5('scale-task-' || (expected_tasks - 8)::text)::uuid),
          (md5('scale-task-' || (expected_tasks - 8)::text)::uuid, md5('scale-task-' || (expected_tasks - 9)::text)::uuid)
      );
    IF actual <> 2 THEN
        RAISE EXCEPTION 'named cycle-rejection path is incomplete; found % of 2 edges', actual;
    END IF;

    SELECT count(*) INTO actual
    FROM task_dependencies
    WHERE project_id = '02000000-0000-7000-8000-000000000001'
      AND (task_id, depends_on_task_id) IN (
          (md5('scale-task-' || expected_tasks::text)::uuid, md5('scale-task-' || (expected_tasks - 1)::text)::uuid),
          (md5('scale-task-' || expected_tasks::text)::uuid, md5('scale-task-' || (expected_tasks - 2)::text)::uuid),
          (md5('scale-task-' || (expected_tasks - 3)::text)::uuid, md5('scale-task-' || (expected_tasks - 4)::text)::uuid),
          (md5('scale-task-' || (expected_tasks - 3)::text)::uuid, md5('scale-task-' || (expected_tasks - 5)::text)::uuid),
          (md5('scale-task-' || (expected_tasks - 4)::text)::uuid, md5('scale-task-' || (expected_tasks - 6)::text)::uuid),
          (md5('scale-task-' || (expected_tasks - 5)::text)::uuid, md5('scale-task-' || (expected_tasks - 6)::text)::uuid)
      );
    IF actual <> 6 THEN
        RAISE EXCEPTION 'named fan-in/diamond graph is incomplete; found % of 6 edges', actual;
    END IF;

    SELECT count(*) INTO actual
    FROM comments
    WHERE project_id = '02000000-0000-7000-8000-000000000001'
      AND task_id = md5('scale-task-' || (expected_tasks - 6)::text)::uuid;
    IF actual <> LEAST(expected_comments, 2500) THEN
        RAISE EXCEPTION 'hot thread has % comments, expected %', actual, LEAST(expected_comments, 2500);
    END IF;

    IF expected_comments >= 2540 THEN
        SELECT count(*) INTO actual
        FROM tasks
        WHERE project_id = '02000000-0000-7000-8000-000000000001'
          AND id IN (
              md5('scale-task-' || expected_tasks::text)::uuid,
              md5('scale-task-' || (expected_tasks - 8)::text)::uuid
          )
          AND comment_count = 20;
        IF actual <> 2 THEN
            RAISE EXCEPTION 'expected both named operational tasks to have 20 comments; found %', actual;
        END IF;
    END IF;

    IF expected_comments > 2540 THEN
        SELECT count(*) INTO actual
        FROM tasks
        WHERE project_id = '02000000-0000-7000-8000-000000000001'
          AND id NOT IN (
              md5('scale-task-' || (expected_tasks - 6)::text)::uuid,
              md5('scale-task-' || expected_tasks::text)::uuid,
              md5('scale-task-' || (expected_tasks - 8)::text)::uuid
          )
          AND comment_count > 0;
        IF actual <> LEAST(expected_comments - 2540, expected_tasks - 11) THEN
            RAISE EXCEPTION 'distributed comment threads %, expected %', actual, LEAST(expected_comments - 2540, expected_tasks - 11);
        END IF;
    END IF;

    SELECT count(*) INTO actual
    FROM tasks AS task
    WHERE task.project_id = '02000000-0000-7000-8000-000000000001'
      AND task.comment_count <> (
          SELECT count(*) FROM comments
          WHERE project_id = task.project_id AND task_id = task.id AND deleted_at IS NULL
      );
    IF actual <> 0 THEN
        RAISE EXCEPTION '% tasks have incorrect denormalized comment counts', actual;
    END IF;

    SELECT count(*) INTO actual
    FROM sync_events
    WHERE project_id = '02000000-0000-7000-8000-000000000001';
    IF actual <> LEAST(expected_tasks, 200) THEN
        RAISE EXCEPTION 'scenario event count %, expected %', actual, LEAST(expected_tasks, 200);
    END IF;
END
$$;

SELECT
    (SELECT count(*) FROM tasks WHERE project_id = '02000000-0000-7000-8000-000000000001') AS tasks,
    (SELECT count(*) FROM comments WHERE project_id = '02000000-0000-7000-8000-000000000001') AS comments,
    (SELECT count(*) FROM task_dependencies WHERE project_id = '02000000-0000-7000-8000-000000000001') AS dependencies,
    (SELECT count(*) FROM tasks AS task WHERE task.project_id = '02000000-0000-7000-8000-000000000001' AND NOT EXISTS (SELECT 1 FROM task_assignees WHERE task_id = task.id)) AS unassigned_tasks,
    (SELECT count(*) FROM (SELECT task_id FROM task_assignees WHERE project_id = '02000000-0000-7000-8000-000000000001' GROUP BY task_id HAVING count(*) > 1) AS grouped) AS multi_assignee_tasks,
    (SELECT max(comment_count) FROM tasks WHERE project_id = '02000000-0000-7000-8000-000000000001') AS hottest_thread,
    (SELECT count(*) FROM sync_events WHERE project_id = '02000000-0000-7000-8000-000000000001') AS replay_events;

SELECT status, priority, count(*) AS tasks
FROM tasks
WHERE project_id = '02000000-0000-7000-8000-000000000001'
GROUP BY status, priority
ORDER BY status, priority;
