-- +goose Up
CREATE TYPE task_status AS ENUM (
    'TODO',
    'IN_PROGRESS',
    'BLOCKED',
    'DONE'
);

CREATE TYPE task_priority AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'URGENT'
);

-- +goose Down
DROP TYPE IF EXISTS task_priority;
DROP TYPE IF EXISTS task_status;
