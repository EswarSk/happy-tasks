-- +goose Up
ALTER TABLE notifications
    DROP CONSTRAINT notifications_notification_type_check,
    ALTER COLUMN comment_id DROP NOT NULL,
    ADD COLUMN request_id uuid,
    ADD CONSTRAINT notifications_notification_type_check
        CHECK (notification_type IN ('MENTION', 'TASK_UPDATED')),
    ADD CONSTRAINT notifications_reference_check CHECK (
        (notification_type = 'MENTION' AND comment_id IS NOT NULL)
        OR (notification_type = 'TASK_UPDATED' AND comment_id IS NULL AND request_id IS NOT NULL)
    );

CREATE UNIQUE INDEX notifications_task_update_request_idx
    ON notifications (project_id, user_id, notification_type, request_id)
    WHERE notification_type = 'TASK_UPDATED';

-- +goose Down
DELETE FROM notifications WHERE notification_type = 'TASK_UPDATED';
DROP INDEX IF EXISTS notifications_task_update_request_idx;
ALTER TABLE notifications
    DROP CONSTRAINT notifications_reference_check,
    DROP CONSTRAINT notifications_notification_type_check,
    DROP COLUMN request_id,
    ALTER COLUMN comment_id SET NOT NULL,
    ADD CONSTRAINT notifications_notification_type_check
        CHECK (notification_type = 'MENTION');
