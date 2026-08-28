-- +goose Up
CREATE TABLE comment_reactions (
    project_id uuid NOT NULL,
    comment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    reaction_type text NOT NULL CHECK (reaction_type IN ('LIKE', 'CELEBRATE', 'INSIGHTFUL')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, comment_id, user_id),
    FOREIGN KEY (project_id, comment_id)
        REFERENCES comments(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, user_id)
        REFERENCES project_members(project_id, user_id)
);

CREATE INDEX comment_reactions_summary_idx
    ON comment_reactions (project_id, comment_id, reaction_type);

-- +goose Down
DROP TABLE IF EXISTS comment_reactions;
