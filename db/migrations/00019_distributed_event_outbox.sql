-- +goose Up
ALTER TABLE sync_events
    ADD COLUMN published_at timestamptz;

-- Existing events predate the distributed relay and have already reached the
-- clients they were created for. Do not replay the complete local history when
-- the relay is first enabled.
UPDATE sync_events
SET published_at = occurred_at;

CREATE INDEX sync_events_outbox_pending_idx
    ON sync_events (project_id, sequence)
    WHERE published_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS sync_events_outbox_pending_idx;
ALTER TABLE sync_events DROP COLUMN IF EXISTS published_at;
