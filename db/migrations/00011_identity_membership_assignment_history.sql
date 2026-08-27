-- +goose Up
CREATE TYPE user_lifecycle_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE project_membership_status AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED');
CREATE TYPE task_assignment_operation AS ENUM ('ASSIGNED', 'UNASSIGNED');

ALTER TABLE users
    ADD COLUMN status user_lifecycle_status NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN avatar_url text,
    ADD COLUMN profile_updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN suspended_at timestamptz,
    ADD COLUMN deleted_at timestamptz,
    ADD CONSTRAINT users_lifecycle_check CHECK (
        (status = 'ACTIVE' AND suspended_at IS NULL AND deleted_at IS NULL)
        OR (status = 'SUSPENDED' AND suspended_at IS NOT NULL AND deleted_at IS NULL)
        OR (status = 'DELETED' AND deleted_at IS NOT NULL)
    );

CREATE TABLE user_identities (
    provider text NOT NULL CHECK (provider = lower(provider) AND length(provider) BETWEEN 1 AND 50),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    user_id uuid NOT NULL REFERENCES users(id),
    email citext,
    email_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider),
    CHECK (email_verified_at IS NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX user_identities_verified_email_idx
    ON user_identities (provider, email)
    WHERE email_verified_at IS NOT NULL;

ALTER TABLE project_members
    DROP CONSTRAINT project_members_role_check;

ALTER TABLE project_members
    ADD COLUMN id uuid DEFAULT gen_random_uuid(),
    ADD COLUMN status project_membership_status NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD COLUMN invited_by uuid REFERENCES users(id),
    ADD COLUMN joined_at timestamptz DEFAULT now(),
    ADD COLUMN removed_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE project_members
SET id = md5('membership:' || project_id::text || ':' || user_id::text)::uuid,
    joined_at = created_at;

ALTER TABLE project_members
    ALTER COLUMN id SET NOT NULL,
    ADD CONSTRAINT project_members_id_key UNIQUE (id),
    ADD CONSTRAINT project_members_project_id_id_user_key UNIQUE (project_id, id, user_id),
    ADD CONSTRAINT project_members_role_check CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')),
    ADD CONSTRAINT project_members_lifecycle_check CHECK (
        (status = 'ACTIVE' AND joined_at IS NOT NULL AND removed_at IS NULL)
        OR (status = 'INVITED' AND joined_at IS NULL AND removed_at IS NULL)
        OR (status = 'SUSPENDED' AND joined_at IS NOT NULL AND removed_at IS NULL)
        OR (status = 'REMOVED' AND removed_at IS NOT NULL)
    );

CREATE INDEX project_members_user_project_idx
    ON project_members (user_id, project_id);

CREATE INDEX project_members_project_active_idx
    ON project_members (project_id, role, user_id)
    WHERE status = 'ACTIVE';

ALTER TABLE task_assignees
    ADD COLUMN assigned_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN assigned_by uuid;

UPDATE task_assignees AS assignment
SET assigned_by = task.created_by,
    assigned_at = task.created_at
FROM tasks AS task
WHERE task.project_id = assignment.project_id
  AND task.id = assignment.task_id;

-- +goose StatementBegin
CREATE FUNCTION default_task_assignment_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.assigned_by IS NULL THEN
        SELECT task.created_by
        INTO NEW.assigned_by
        FROM tasks AS task
        WHERE task.project_id = NEW.project_id
          AND task.id = NEW.task_id;
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER task_assignees_default_actor
BEFORE INSERT ON task_assignees
FOR EACH ROW EXECUTE FUNCTION default_task_assignment_actor();

ALTER TABLE task_assignees
    ALTER COLUMN assigned_by SET NOT NULL,
    ADD CONSTRAINT task_assignees_assigned_by_fkey
        FOREIGN KEY (assigned_by) REFERENCES users(id);

CREATE TABLE task_assignment_operations (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    membership_id uuid NOT NULL REFERENCES project_members(id),
    operation task_assignment_operation NOT NULL,
    actor_id uuid NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, membership_id, user_id)
        REFERENCES project_members(project_id, id, user_id),
    UNIQUE (request_id, task_id, user_id, operation)
);

CREATE INDEX task_assignment_operations_task_time_idx
    ON task_assignment_operations (project_id, task_id, occurred_at DESC, id DESC);

CREATE INDEX task_assignment_operations_user_time_idx
    ON task_assignment_operations (project_id, user_id, occurred_at DESC, id DESC);

INSERT INTO task_assignment_operations (
    id, project_id, task_id, user_id, membership_id, operation,
    actor_id, request_id, occurred_at
)
SELECT
    md5('assignment-operation:' || assignment.task_id::text || ':' || assignment.user_id::text)::uuid,
    assignment.project_id,
    assignment.task_id,
    assignment.user_id,
    membership.id,
    'ASSIGNED',
    assignment.assigned_by,
    md5('assignment-request:' || assignment.task_id::text || ':' || assignment.user_id::text)::uuid,
    assignment.assigned_at
FROM task_assignees AS assignment
JOIN project_members AS membership
  ON membership.project_id = assignment.project_id
 AND membership.user_id = assignment.user_id;

-- +goose StatementBegin
CREATE FUNCTION reject_task_assignment_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'task_assignment_operations is append-only'
        USING ERRCODE = '55000';
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER task_assignment_operations_append_only
BEFORE UPDATE OR DELETE ON task_assignment_operations
FOR EACH ROW EXECUTE FUNCTION reject_task_assignment_operation_mutation();

-- +goose Down
DROP TRIGGER IF EXISTS task_assignment_operations_append_only ON task_assignment_operations;
DROP FUNCTION IF EXISTS reject_task_assignment_operation_mutation();
DROP TABLE IF EXISTS task_assignment_operations;

DROP TRIGGER IF EXISTS task_assignees_default_actor ON task_assignees;
DROP FUNCTION IF EXISTS default_task_assignment_actor();

ALTER TABLE task_assignees
    DROP CONSTRAINT IF EXISTS task_assignees_assigned_by_fkey,
    DROP COLUMN IF EXISTS assigned_by,
    DROP COLUMN IF EXISTS assigned_at;

DROP INDEX IF EXISTS project_members_project_active_idx;
DROP INDEX IF EXISTS project_members_user_project_idx;

UPDATE project_members
SET role = CASE
    WHEN role IN ('OWNER', 'ADMIN') THEN 'OWNER'
    ELSE 'MEMBER'
END;

ALTER TABLE project_members
    DROP CONSTRAINT IF EXISTS project_members_lifecycle_check,
    DROP CONSTRAINT IF EXISTS project_members_role_check,
    DROP CONSTRAINT IF EXISTS project_members_project_id_id_user_key,
    DROP CONSTRAINT IF EXISTS project_members_id_key,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS created_at,
    DROP COLUMN IF EXISTS removed_at,
    DROP COLUMN IF EXISTS joined_at,
    DROP COLUMN IF EXISTS invited_by,
    DROP COLUMN IF EXISTS version,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS id,
    ADD CONSTRAINT project_members_role_check CHECK (role IN ('OWNER', 'MEMBER'));

DROP INDEX IF EXISTS user_identities_verified_email_idx;
DROP TABLE IF EXISTS user_identities;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_lifecycle_check,
    DROP COLUMN IF EXISTS deleted_at,
    DROP COLUMN IF EXISTS suspended_at,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS profile_updated_at,
    DROP COLUMN IF EXISTS avatar_url,
    DROP COLUMN IF EXISTS status;

DROP TYPE IF EXISTS task_assignment_operation;
DROP TYPE IF EXISTS project_membership_status;
DROP TYPE IF EXISTS user_lifecycle_status;
