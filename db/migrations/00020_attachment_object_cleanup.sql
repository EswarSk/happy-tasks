-- +goose Up
CREATE TABLE attachment_object_deletions (
    storage_key text PRIMARY KEY CHECK (length(storage_key) BETWEEN 1 AND 200),
    delete_after timestamptz NOT NULL,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachment_object_deletions_ready_idx
    ON attachment_object_deletions (delete_after, lease_until);

-- +goose StatementBegin
CREATE FUNCTION queue_attachment_object_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO attachment_object_deletions(storage_key, delete_after)
    VALUES (OLD.storage_key, now())
    ON CONFLICT (storage_key) DO UPDATE
        SET delete_after = LEAST(attachment_object_deletions.delete_after, EXCLUDED.delete_after),
            lease_until = NULL;
    RETURN OLD;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER task_attachments_queue_object_deletion
    BEFORE DELETE ON task_attachments
    FOR EACH ROW EXECUTE FUNCTION queue_attachment_object_deletion();

-- +goose Down
DROP TRIGGER IF EXISTS task_attachments_queue_object_deletion ON task_attachments;
DROP FUNCTION IF EXISTS queue_attachment_object_deletion();
DROP INDEX IF EXISTS attachment_object_deletions_ready_idx;
DROP TABLE IF EXISTS attachment_object_deletions;
