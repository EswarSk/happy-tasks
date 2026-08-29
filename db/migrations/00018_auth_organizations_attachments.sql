-- +goose Up
ALTER TABLE users
    ADD COLUMN password_hash text;

CREATE TABLE organizations (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_members_user_active_idx
    ON organization_members (user_id, organization_id)
    WHERE status = 'ACTIVE';

ALTER TABLE projects ADD COLUMN organization_id uuid;

INSERT INTO organizations (id, name)
VALUES ('00000000-0000-7000-8000-000000000100', 'Happy Tasks')
ON CONFLICT (id) DO NOTHING;

UPDATE projects
SET organization_id = '00000000-0000-7000-8000-000000000100'
WHERE organization_id IS NULL;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT '00000000-0000-7000-8000-000000000100', u.id,
       CASE WHEN u.id = '00000000-0000-7000-8000-000000000001' THEN 'OWNER' ELSE 'MEMBER' END
FROM users u
ON CONFLICT (organization_id, user_id) DO NOTHING;

ALTER TABLE projects
    ALTER COLUMN organization_id SET NOT NULL,
    ADD CONSTRAINT projects_organization_fkey
        FOREIGN KEY (organization_id) REFERENCES organizations(id);

CREATE INDEX projects_organization_updated_idx
    ON projects (organization_id, updated_at DESC, id DESC);

CREATE TABLE auth_sessions (
    token_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE task_attachments (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    uploaded_by uuid NOT NULL REFERENCES users(id),
    file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
    content_type text NOT NULL CHECK (length(btrim(content_type)) BETWEEN 1 AND 150),
    byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    storage_key text NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE INDEX task_attachments_task_created_idx
    ON task_attachments (project_id, task_id, created_at DESC, id DESC);

-- +goose Down
DROP INDEX IF EXISTS task_attachments_task_created_idx;
DROP TABLE IF EXISTS task_attachments;
DROP INDEX IF EXISTS auth_sessions_expiry_idx;
DROP TABLE IF EXISTS auth_sessions;
DROP INDEX IF EXISTS projects_organization_updated_idx;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_organization_fkey;
ALTER TABLE projects DROP COLUMN IF EXISTS organization_id;
DROP INDEX IF EXISTS organization_members_user_active_idx;
DROP TABLE IF EXISTS organization_members;
DROP TABLE IF EXISTS organizations;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
