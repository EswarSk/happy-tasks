package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/app"
	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Postgres struct {
	pool *pgxpool.Pool
	dsn  string
}

func Open(ctx context.Context, dsn string) (*Postgres, error) {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	config.MaxConns = 20
	config.MinConns = 2
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	return &Postgres{pool: pool, dsn: dsn}, nil
}

func (p *Postgres) Close()                         { p.pool.Close() }
func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

const defaultOrganizationID = "00000000-0000-7000-8000-000000000100"

// showcaseProjectIDs are the fixture projects from db/seed/demo.sql and
// db/seed/scenarios.sql. Every new signup is added to them (as a member, not
// owner) alongside their own private project, so there's something populated to
// explore without handing out shared login credentials. The INSERT below no-ops
// when a project doesn't exist (e.g. an unseeded dev/CI database), so this never
// blocks registration.
var showcaseProjectIDs = []string{
	"01000000-0000-7000-8000-000000000001", // Realtime Launch
	"01000000-0000-7000-8000-000000000002", // Mobile Experience
	"02000000-0000-7000-8000-000000000001", // Scale & Scenario Lab
	"02000000-0000-7000-8000-000000000002", // Empty Sandbox
}

func (p *Postgres) CreateUser(ctx context.Context, displayName, email, passwordHash string) (domain.User, error) {
	id := uuid.Must(uuid.NewV7()).String()
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return domain.User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	user, err := scanUser(tx.QueryRow(ctx, `
		INSERT INTO users(id, display_name, email, password_hash)
		VALUES ($1, $2, $3, $4)
		RETURNING id, display_name, email, status, avatar_url, profile_updated_at, created_at, updated_at`, id, displayName, email, passwordHash))
	if err != nil {
		return domain.User{}, mapConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO organization_members(organization_id, user_id, role)
		VALUES ($1, $2, 'MEMBER')`, defaultOrganizationID, user.ID); err != nil {
		return domain.User{}, err
	}
	projectID := uuid.Must(uuid.NewV7()).String()
	if _, err := tx.Exec(ctx, `
		INSERT INTO projects(id, organization_id, name, description)
		VALUES ($1, $2, $3, 'A private workspace for your tasks.')`, projectID, defaultOrganizationID, displayName+"'s workspace"); err != nil {
		return domain.User{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO project_members(project_id, user_id, role, status, invited_by, joined_at)
		VALUES ($1, $2, 'OWNER', 'ACTIVE', $2, now())`, projectID, user.ID); err != nil {
		return domain.User{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO project_streams(project_id, last_sequence) VALUES ($1, 0)`, projectID); err != nil {
		return domain.User{}, err
	}
	for _, showcaseID := range showcaseProjectIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO project_members(project_id, user_id, role, status, invited_by, joined_at)
			SELECT $1, $2, 'MEMBER', 'ACTIVE', $2, now()
			WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1)
			ON CONFLICT (project_id, user_id) DO NOTHING`, showcaseID, user.ID); err != nil {
			return domain.User{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func (p *Postgres) GetAuthUser(ctx context.Context, email string) (domain.AuthUser, error) {
	var item domain.AuthUser
	err := p.pool.QueryRow(ctx, `
		SELECT id, display_name, email, status, avatar_url, profile_updated_at, created_at, updated_at, password_hash
		FROM users
		WHERE email = $1`, email).Scan(
		&item.User.ID, &item.User.DisplayName, &item.User.Email, &item.User.Status, &item.User.AvatarURL,
		&item.User.ProfileUpdatedAt, &item.User.CreatedAt, &item.User.UpdatedAt, &item.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AuthUser{}, domain.ErrNotFound
	}
	return item, err
}

func (p *Postgres) CreateAuthSession(ctx context.Context, userID string, tokenHash []byte, expiresAt time.Time) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO auth_sessions(token_hash, user_id, expires_at)
		VALUES ($1, $2, $3)`, tokenHash, userID, expiresAt)
	return mapConstraintError(err)
}

func (p *Postgres) GetAuthSessionUser(ctx context.Context, tokenHash []byte) (domain.User, error) {
	var item domain.User
	err := p.pool.QueryRow(ctx, `
		UPDATE auth_sessions session
		SET last_seen_at = now()
	FROM users person
	WHERE session.token_hash = $1
	  AND session.expires_at > now()
	  AND person.id = session.user_id
	  AND person.status = 'ACTIVE'
	RETURNING person.id, person.display_name, person.email, person.status, person.avatar_url,
	          person.profile_updated_at, person.created_at, person.updated_at`, tokenHash).Scan(
		&item.ID, &item.DisplayName, &item.Email, &item.Status, &item.AvatarURL,
		&item.ProfileUpdatedAt, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, domain.ErrNotFound
	}
	return item, err
}

func (p *Postgres) DeleteAuthSession(ctx context.Context, tokenHash []byte) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE token_hash = $1`, tokenHash)
	return err
}

func (p *Postgres) WithinTx(ctx context.Context, fn func(app.Store) error) error {
	tx, err := p.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(&store{q: tx}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

func (p *Postgres) ListProjects(ctx context.Context, actorID string, limit int) ([]domain.Project, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT p.id, p.organization_id, p.name, p.description, p.metadata, p.version, p.created_at, p.updated_at,
		       count(t.id) AS task_count
		FROM projects p
		JOIN project_members pm ON pm.project_id = p.id
		JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $1 AND om.status = 'ACTIVE'
		JOIN users actor ON actor.id = pm.user_id
		LEFT JOIN tasks t ON t.project_id = p.id
		WHERE pm.user_id = $1
		  AND pm.status = 'ACTIVE'
		  AND actor.status = 'ACTIVE'
		GROUP BY p.id
		ORDER BY p.updated_at DESC, p.id DESC
		LIMIT $2`, actorID, limit)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	items := make([]domain.Project, 0, limit)
	for rows.Next() {
		item, err := scanProjectWithTaskCount(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) GetProject(ctx context.Context, actorID, projectID string) (domain.Project, error) {
	return getProject(ctx, p.pool, actorID, projectID)
}

func (p *Postgres) Bootstrap(ctx context.Context, actorID, projectID string, filter app.TaskFilter) (app.Bootstrap, error) {
	var result app.Bootstrap
	tx, err := p.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, fmt.Errorf("begin bootstrap snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result.Project, err = getProject(ctx, tx, actorID, projectID)
	if err != nil {
		return result, err
	}
	result.Tasks.Items, err = listTasks(ctx, tx, projectID, filter)
	if err != nil {
		return result, err
	}
	rows, err := tx.Query(ctx, `
		SELECT u.id, u.display_name, u.email, u.status, u.avatar_url,
		       u.profile_updated_at, u.created_at, u.updated_at
		FROM project_members pm
		JOIN users u ON u.id = pm.user_id
		JOIN projects p ON p.id = pm.project_id
		JOIN organization_members om
		  ON om.organization_id = p.organization_id
		 AND om.user_id = pm.user_id
		WHERE pm.project_id = $1
		  AND pm.status = 'ACTIVE'
		  AND om.status = 'ACTIVE'
		  AND u.status = 'ACTIVE'
		ORDER BY u.display_name, u.id
		LIMIT 100`, projectID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var user domain.User
		if err := rows.Scan(&user.ID, &user.DisplayName, &user.Email, &user.Status, &user.AvatarURL,
			&user.ProfileUpdatedAt, &user.CreatedAt, &user.UpdatedAt); err != nil {
			rows.Close()
			return result, err
		}
		result.Members = append(result.Members, user)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, err
	}
	if err := tx.QueryRow(ctx, `SELECT last_sequence FROM project_streams WHERE project_id = $1`, projectID).Scan(&result.StreamCursor); err != nil {
		return result, err
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func getProject(ctx context.Context, q querier, actorID, projectID string) (domain.Project, error) {
	item, err := scanProject(q.QueryRow(ctx, `
		SELECT p.id, p.organization_id, p.name, p.description, p.metadata, p.version, p.created_at, p.updated_at
		FROM projects p
		JOIN project_members pm ON pm.project_id = p.id
		JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $2 AND om.status = 'ACTIVE'
		JOIN users actor ON actor.id = pm.user_id
		WHERE p.id = $1 AND pm.user_id = $2
		  AND pm.status = 'ACTIVE'
		  AND actor.status = 'ACTIVE'`, projectID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Project{}, domain.ErrNotFound
	}
	return item, err
}

func (p *Postgres) ListTasks(ctx context.Context, projectID string, filter app.TaskFilter) ([]domain.Task, error) {
	return listTasks(ctx, p.pool, projectID, filter)
}

func listTasks(ctx context.Context, q querier, projectID string, filter app.TaskFilter) ([]domain.Task, error) {
	var status any
	if filter.Status != nil {
		status = string(*filter.Status)
	}
	var priority any
	if filter.Priority != nil {
		priority = string(*filter.Priority)
	}
	var assigneeID any
	if filter.AssigneeID != nil {
		assigneeID = *filter.AssigneeID
	}
	var cursorTime, cursorID any
	if filter.Cursor != nil {
		cursorTime, cursorID = filter.Cursor.UpdatedAt, filter.Cursor.ID
	}
	rows, err := q.Query(ctx, taskSelect+`
		WHERE t.project_id = $1
		  AND ($2::task_status IS NULL OR t.status = $2)
		  AND ($3::task_priority IS NULL OR t.priority = $3)
		  AND ($4::text = '' OR t.title ILIKE '%' || $4 || '%'
		       OR t.description ILIKE '%' || $4 || '%'
			       OR EXISTS (
			           SELECT 1 FROM task_tags searched_tag
			           WHERE searched_tag.project_id = t.project_id
			             AND searched_tag.task_id = t.id
			             AND searched_tag.tag ILIKE '%' || $4 || '%'
			       ))
		  AND ($5::uuid IS NULL OR EXISTS (
			       SELECT 1 FROM task_assignees filtered_assignee
			       WHERE filtered_assignee.project_id = t.project_id
			         AND filtered_assignee.task_id = t.id
			         AND filtered_assignee.user_id = $5
		       ))
		  AND ($6::text = '' OR EXISTS (
			       SELECT 1 FROM task_tags filtered_tag
			       WHERE filtered_tag.project_id = t.project_id
			         AND filtered_tag.task_id = t.id
			         AND filtered_tag.tag ILIKE '%' || $6 || '%'
		       ))
		  AND ($7::timestamptz IS NULL OR (t.updated_at, t.id) < ($7, $8::uuid))
		ORDER BY t.updated_at DESC, t.id DESC
		LIMIT $9`, projectID, status, priority, filter.Search, assigneeID, filter.Tag, cursorTime, cursorID, filter.PageSize)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()
	items := make([]domain.Task, 0, filter.PageSize)
	for rows.Next() {
		item, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) GetTask(ctx context.Context, projectID, taskID string) (domain.Task, error) {
	return getTask(ctx, p.pool, projectID, taskID)
}

func (p *Postgres) GetLatestAgentRun(ctx context.Context, projectID, taskID string) (domain.AgentRun, error) {
	var run domain.AgentRun
	err := p.pool.QueryRow(ctx, `
		SELECT id, project_id, task_id, orchestrator, external_run_id, workflow_name,
		       definition_id, definition_version, status, started_at, completed_at, created_at, updated_at
		FROM agent_runs
		WHERE project_id = $1 AND task_id = $2
		ORDER BY created_at DESC, id DESC
		LIMIT 1`, projectID, taskID).Scan(
		&run.ID, &run.ProjectID, &run.TaskID, &run.Orchestrator, &run.ExternalRunID, &run.WorkflowName,
		&run.DefinitionID, &run.DefinitionVersion, &run.Status, &run.StartedAt, &run.CompletedAt, &run.CreatedAt, &run.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AgentRun{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.AgentRun{}, err
	}
	run.Nodes = make([]domain.AgentRunNode, 0)
	run.Edges = make([]domain.AgentRunEdge, 0)
	run.Events = make([]domain.AgentRunEvent, 0)

	nodeRows, err := p.pool.Query(ctx, `
		SELECT id, external_node_id, agent_name, label, node_type, status, attempt,
		       position_x, position_y, output, error, started_at, completed_at, updated_at
		FROM agent_run_nodes
		WHERE run_id = $1
		ORDER BY position_x, position_y, id`, run.ID)
	if err != nil {
		return domain.AgentRun{}, err
	}
	for nodeRows.Next() {
		var node domain.AgentRunNode
		var output []byte
		if err := nodeRows.Scan(&node.ID, &node.ExternalNodeID, &node.AgentName, &node.Label, &node.NodeType, &node.Status, &node.Attempt, &node.PositionX, &node.PositionY, &output, &node.Error, &node.StartedAt, &node.CompletedAt, &node.UpdatedAt); err != nil {
			nodeRows.Close()
			return domain.AgentRun{}, err
		}
		if err := json.Unmarshal(output, &node.Output); err != nil {
			nodeRows.Close()
			return domain.AgentRun{}, err
		}
		run.Nodes = append(run.Nodes, node)
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return domain.AgentRun{}, err
	}

	edgeRows, err := p.pool.Query(ctx, `
		SELECT source_node_id, target_node_id, label
		FROM agent_run_edges
		WHERE run_id = $1
		ORDER BY source_node_id, target_node_id`, run.ID)
	if err != nil {
		return domain.AgentRun{}, err
	}
	for edgeRows.Next() {
		var edge domain.AgentRunEdge
		if err := edgeRows.Scan(&edge.SourceNodeID, &edge.TargetNodeID, &edge.Label); err != nil {
			edgeRows.Close()
			return domain.AgentRun{}, err
		}
		run.Edges = append(run.Edges, edge)
	}
	edgeRows.Close()
	if err := edgeRows.Err(); err != nil {
		return domain.AgentRun{}, err
	}

	eventRows, err := p.pool.Query(ctx, `
		SELECT sequence, external_event_id, node_id, event_type, message, payload, occurred_at
		FROM (
			SELECT sequence, external_event_id, node_id, event_type, message, payload, occurred_at
			FROM agent_run_events
			WHERE run_id = $1
			ORDER BY sequence DESC
			LIMIT 200
		) recent
		ORDER BY sequence`, run.ID)
	if err != nil {
		return domain.AgentRun{}, err
	}
	for eventRows.Next() {
		var event domain.AgentRunEvent
		var payload []byte
		if err := eventRows.Scan(&event.Sequence, &event.ExternalEventID, &event.NodeID, &event.EventType, &event.Message, &payload, &event.OccurredAt); err != nil {
			eventRows.Close()
			return domain.AgentRun{}, err
		}
		if err := json.Unmarshal(payload, &event.Payload); err != nil {
			eventRows.Close()
			return domain.AgentRun{}, err
		}
		run.Events = append(run.Events, event)
	}
	eventRows.Close()
	return run, eventRows.Err()
}

func (p *Postgres) ScheduleAttachmentObjectCleanup(ctx context.Context, storageKey string, deleteAfter time.Time) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO attachment_object_deletions(storage_key, delete_after)
		VALUES ($1, $2)
		ON CONFLICT (storage_key) DO UPDATE
		SET delete_after = EXCLUDED.delete_after, lease_until = NULL`, storageKey, deleteAfter)
	return err
}

func (p *Postgres) ClaimAttachmentObjectCleanup(ctx context.Context, limit int) ([]string, error) {
	rows, err := p.pool.Query(ctx, `
		WITH candidates AS (
			SELECT storage_key
			FROM attachment_object_deletions
			WHERE delete_after <= now()
			  AND (lease_until IS NULL OR lease_until <= now())
			ORDER BY delete_after, storage_key
			FOR UPDATE SKIP LOCKED
			LIMIT $1
		)
		UPDATE attachment_object_deletions cleanup
		SET lease_until = now() + interval '1 minute'
		FROM candidates
		WHERE cleanup.storage_key = candidates.storage_key
		RETURNING cleanup.storage_key`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := make([]string, 0, limit)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func (p *Postgres) CompleteAttachmentObjectCleanup(ctx context.Context, storageKey string) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM attachment_object_deletions WHERE storage_key = $1`, storageKey)
	return err
}

func (p *Postgres) RetryAttachmentObjectCleanup(ctx context.Context, storageKey string) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE attachment_object_deletions
		SET delete_after = now() + interval '30 seconds', lease_until = NULL
		WHERE storage_key = $1`, storageKey)
	return err
}

func (p *Postgres) ListAttachments(ctx context.Context, projectID, taskID string) ([]domain.Attachment, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, project_id, task_id, file_name, content_type, byte_size, checksum, storage_key, uploaded_by, created_at
		FROM task_attachments
		WHERE project_id = $1 AND task_id = $2
		ORDER BY created_at DESC, id DESC`, projectID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Attachment, 0)
	for rows.Next() {
		item, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) GetAttachment(ctx context.Context, projectID, taskID, attachmentID string) (domain.Attachment, error) {
	return getAttachment(ctx, p.pool, projectID, taskID, attachmentID)
}

func (p *Postgres) ListComments(ctx context.Context, projectID, taskID, actorID string, filter app.CommentFilter) ([]domain.Comment, error) {
	var cursorTime, cursorID any
	if filter.Cursor != nil {
		cursorTime, cursorID = filter.Cursor.CreatedAt, filter.Cursor.ID
	}
	rows, err := p.pool.Query(ctx, `
		SELECT c.id, c.project_id, c.task_id, c.parent_id, c.body, c.version, c.created_at,
		       c.updated_at, c.deleted_at,
		       u.id, u.display_name, u.email, u.created_at,
		       COALESCE((
		           SELECT jsonb_agg(jsonb_build_object('type', summary.reaction_type, 'count', summary.reaction_count, 'reacted', summary.reacted) ORDER BY summary.reaction_type)
		           FROM (
		               SELECT reaction_type, count(*) AS reaction_count, bool_or(user_id = $6::uuid) AS reacted
		               FROM comment_reactions
		               WHERE project_id = c.project_id AND comment_id = c.id
		               GROUP BY reaction_type
		           ) summary
		       ), '[]'::jsonb)
		FROM comments c
		JOIN users u ON u.id = c.author_id
		WHERE c.project_id = $1 AND c.task_id = $2
		  AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3, $4::uuid))
			ORDER BY c.created_at DESC, c.id DESC
			LIMIT $5`, projectID, taskID, cursorTime, cursorID, filter.PageSize, actorID)
	if err != nil {
		return nil, fmt.Errorf("list comments: %w", err)
	}
	defer rows.Close()
	items := make([]domain.Comment, 0, filter.PageSize)
	for rows.Next() {
		item, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) ListMembers(ctx context.Context, projectID string, filter app.MemberFilter) ([]domain.Membership, error) {
	var status, role any
	if filter.Status != nil {
		status = string(*filter.Status)
	}
	if filter.Role != nil {
		role = string(*filter.Role)
	}
	var cursorName, cursorID any
	if filter.Cursor != nil {
		cursorName, cursorID = filter.Cursor.DisplayName, filter.Cursor.ID
	}
	rows, err := p.pool.Query(ctx, membershipSelect+`
		WHERE membership.project_id = $1
		  AND ($2::project_membership_status IS NULL OR membership.status = $2)
		  -- The active directory is the assignable directory. Keep historical and
		  -- lifecycle rows queryable, but never advertise a globally suspended or
		  -- deleted user as active when callers request ACTIVE memberships.
		  AND ($2::project_membership_status IS DISTINCT FROM 'ACTIVE' OR person.status = 'ACTIVE')
		  AND ($3::text IS NULL OR membership.role = $3)
		  AND ($4::text = '' OR person.display_name ILIKE '%' || $4 || '%'
		       OR person.email::text ILIKE '%' || $4 || '%')
		  AND ($5::text IS NULL OR (lower(person.display_name), membership.id) > ($5, $6::uuid))
		ORDER BY lower(person.display_name), membership.id
		LIMIT $7`, projectID, status, role, filter.Search, cursorName, cursorID, filter.PageSize)
	if err != nil {
		return nil, fmt.Errorf("list project members: %w", err)
	}
	defer rows.Close()
	items := make([]domain.Membership, 0, filter.PageSize)
	for rows.Next() {
		item, err := scanMembership(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) ListAssignmentOperations(ctx context.Context, projectID, taskID string, filter app.AssignmentFilter) ([]domain.AssignmentOperation, error) {
	var cursorTime, cursorID any
	if filter.Cursor != nil {
		cursorTime, cursorID = filter.Cursor.OccurredAt, filter.Cursor.ID
	}
	rows, err := p.pool.Query(ctx, `
		SELECT id, project_id, task_id, user_id, membership_id, operation,
		       actor_id, request_id, occurred_at
		FROM task_assignment_operations
		WHERE project_id = $1 AND task_id = $2
		  AND ($3::timestamptz IS NULL OR (occurred_at, id) < ($3, $4::uuid))
		ORDER BY occurred_at DESC, id DESC
		LIMIT $5`, projectID, taskID, cursorTime, cursorID, filter.PageSize)
	if err != nil {
		return nil, fmt.Errorf("list assignment operations: %w", err)
	}
	defer rows.Close()
	items := make([]domain.AssignmentOperation, 0, filter.PageSize)
	for rows.Next() {
		item, err := scanAssignmentOperation(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) ListNotifications(ctx context.Context, actorID, projectID string, unreadOnly bool, cursor app.NotificationCursor, limit int) ([]domain.Notification, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, project_id, user_id, task_id, comment_id, actor_id, notification_type, body, read_at, created_at
		FROM notifications
		WHERE project_id = $1
		  AND user_id = $2
		  AND ($3::bool = false OR read_at IS NULL)
		  AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $6`, projectID, actorID, unreadOnly, nullableTime(cursor.CreatedAt), nullableString(cursor.ID), limit)
	if err != nil {
		return nil, fmt.Errorf("list notifications: %w", err)
	}
	defer rows.Close()
	items := make([]domain.Notification, 0, limit)
	for rows.Next() {
		var item domain.Notification
		if err := rows.Scan(&item.ID, &item.ProjectID, &item.UserID, &item.TaskID, &item.CommentID, &item.ActorID, &item.Type, &item.Body, &item.ReadAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) GetTaskDescriptionDocument(ctx context.Context, projectID, taskID string) (domain.TaskDescriptionDocument, error) {
	var document domain.TaskDescriptionDocument
	var snapshot []byte
	err := p.pool.QueryRow(ctx, `
		SELECT initialized, snapshot
		FROM task_description_documents
		WHERE project_id = $1 AND task_id = $2`, projectID, taskID).Scan(&document.Initialized, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return document, nil
	}
	if err != nil {
		return document, err
	}
	document.ProjectID, document.TaskID = projectID, taskID
	document.Snapshot = snapshot
	rows, err := p.pool.Query(ctx, `
		SELECT update_data
		FROM task_description_updates
		WHERE project_id = $1 AND task_id = $2
		ORDER BY id`, projectID, taskID)
	if err != nil {
		return document, err
	}
	defer rows.Close()
	for rows.Next() {
		var update []byte
		if err := rows.Scan(&update); err != nil {
			return document, err
		}
		document.Updates = append(document.Updates, update)
	}
	return document, rows.Err()
}

func (p *Postgres) ListEvents(ctx context.Context, projectID string, after int64, limit int) ([]domain.Event, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT project_id, sequence, event_type, aggregate_type, aggregate_id,
		       aggregate_version, actor_id, request_id, payload, occurred_at
		FROM sync_events
		WHERE project_id = $1 AND sequence > $2
		ORDER BY sequence
		LIMIT $3`, projectID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	defer rows.Close()
	items := make([]domain.Event, 0, limit)
	for rows.Next() {
		item, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) ProjectStreamCursor(ctx context.Context, projectID string) (int64, error) {
	var cursor int64
	err := p.pool.QueryRow(ctx, `SELECT last_sequence FROM project_streams WHERE project_id = $1`, projectID).Scan(&cursor)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, domain.ErrNotFound
	}
	return cursor, err
}

// PublishOutboxBatch lets competing relay replicas claim committed events with
// SKIP LOCKED. The broker publish happens while the row is locked; a crash after
// publish but before commit can duplicate an event, which consumers already
// tolerate through project sequence numbers.
func (p *Postgres) PublishOutboxBatch(ctx context.Context, limit int, publish func(domain.Event) error) (int, error) {
	if limit < 1 {
		limit = 100
	}
	published := 0
	for published < limit {
		tx, err := p.pool.Begin(ctx)
		if err != nil {
			return published, err
		}
		event, err := scanEvent(tx.QueryRow(ctx, `
			SELECT project_id, sequence, event_type, aggregate_type, aggregate_id,
			       aggregate_version, actor_id, request_id, payload, occurred_at
			FROM sync_events
			WHERE published_at IS NULL
			  AND NOT EXISTS (
				SELECT 1
				FROM sync_events earlier
				WHERE earlier.project_id = sync_events.project_id
				  AND earlier.sequence < sync_events.sequence
				  AND earlier.published_at IS NULL
			  )
			ORDER BY occurred_at, project_id, sequence
			FOR UPDATE SKIP LOCKED
			LIMIT 1`))
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			return published, nil
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return published, err
		}
		if err := publish(event); err != nil {
			_ = tx.Rollback(ctx)
			return published, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sync_events
			SET published_at = now()
			WHERE project_id = $1 AND sequence = $2`, event.ProjectID, event.Sequence); err != nil {
			_ = tx.Rollback(ctx)
			return published, err
		}
		if err := tx.Commit(ctx); err != nil {
			return published, err
		}
		published++
	}
	return published, nil
}

// Listen consumes only wake-up hints. SSE correctness comes from ListEvents.
func (p *Postgres) Listen(ctx context.Context, notify func(projectID string)) error {
	conn, err := pgx.Connect(ctx, p.dsn)
	if err != nil {
		return fmt.Errorf("open notification connection: %w", err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, `LISTEN sync_events`); err != nil {
		return fmt.Errorf("listen sync_events: %w", err)
	}
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if n.Payload != "" {
			notify(n.Payload)
		}
	}
}

type querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type scanner interface{ Scan(...any) error }
type store struct{ q querier }

func (s *store) LockIdempotency(ctx context.Context, actorID, key string) error {
	_, err := s.q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, actorID+":"+key)
	return err
}

func (s *store) GetIdempotency(ctx context.Context, actorID, key string) (*app.SavedResponse, error) {
	var saved app.SavedResponse
	err := s.q.QueryRow(ctx, `
		SELECT request_hash, response_status, response_body
		FROM idempotency_keys
		WHERE actor_id = $1 AND idempotency_key = $2 AND expires_at > now()`, actorID, key).
		Scan(&saved.RequestHash, &saved.Status, &saved.Body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get idempotency key: %w", err)
	}
	return &saved, nil
}

func (s *store) PutIdempotency(ctx context.Context, actorID, key string, hash []byte, status int, body json.RawMessage) error {
	_, err := s.q.Exec(ctx, `
		INSERT INTO idempotency_keys(actor_id, idempotency_key, request_hash, response_status, response_body, expires_at)
		VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')`, actorID, key, hash, status, body)
	return err
}

func (s *store) ActorExists(ctx context.Context, actorID string) (bool, error) {
	var exists bool
	err := s.q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE')`, actorID).Scan(&exists)
	return exists, err
}

func (s *store) GetActiveOrganizationID(ctx context.Context, actorID string) (string, error) {
	var organizationID string
	err := s.q.QueryRow(ctx, `
		SELECT organization_id
		FROM organization_members
		WHERE user_id = $1 AND status = 'ACTIVE'
		ORDER BY created_at, organization_id
		LIMIT 1
		FOR SHARE`, actorID).Scan(&organizationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrForbidden
	}
	return organizationID, err
}

func (s *store) IsUserInProjectOrganization(ctx context.Context, projectID, userID string) (bool, error) {
	var organizationID string
	err := s.q.QueryRow(ctx, `
		SELECT om.organization_id
		FROM projects p
		JOIN organization_members om ON om.organization_id = p.organization_id
		WHERE p.id = $1 AND om.user_id = $2 AND om.status = 'ACTIVE'
		LIMIT 1
		FOR SHARE OF om`, projectID, userID).Scan(&organizationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *store) GetActiveMembership(ctx context.Context, projectID, actorID string) (domain.Membership, error) {
	item, err := scanMembership(s.q.QueryRow(ctx, membershipSelect+`
		WHERE membership.project_id = $1
		  AND membership.user_id = $2
		  AND membership.status = 'ACTIVE'
		  AND person.status = 'ACTIVE'
		FOR SHARE OF membership, person, organization_membership`, projectID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Membership{}, domain.ErrForbidden
	}
	return item, err
}

func (s *store) AreProjectMembers(ctx context.Context, projectID string, actorIDs []string) (bool, error) {
	rows, err := s.q.Query(ctx, `
		SELECT membership.user_id
		FROM project_members membership
		JOIN users person ON person.id = membership.user_id
		JOIN projects project ON project.id = membership.project_id
		JOIN organization_members organization_membership
		  ON organization_membership.organization_id = project.organization_id
		 AND organization_membership.user_id = membership.user_id
		WHERE membership.project_id = $1
		  AND membership.user_id = ANY($2::uuid[])
		  AND membership.status = 'ACTIVE'
		  AND organization_membership.status = 'ACTIVE'
		  AND person.status = 'ACTIVE'
		ORDER BY membership.user_id
		FOR SHARE OF membership, person, organization_membership`, projectID, actorIDs)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return count == len(actorIDs), nil
}

func (s *store) LockOwnerInvariant(ctx context.Context, projectID string) error {
	_, err := s.q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('membership-owner:' || $1::text, 0))`, projectID)
	return err
}

func (s *store) GetMembership(ctx context.Context, projectID, membershipID string) (domain.Membership, error) {
	item, err := scanMembership(s.q.QueryRow(ctx, membershipSelect+`
		WHERE membership.project_id = $1 AND membership.id = $2
		FOR UPDATE OF membership`, projectID, membershipID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Membership{}, domain.ErrNotFound
	}
	return item, err
}

func (s *store) CountActiveOwners(ctx context.Context, projectID string) (int, error) {
	var count int
	err := s.q.QueryRow(ctx, `
		SELECT count(*)
	FROM project_members membership
	JOIN projects project ON project.id = membership.project_id
	JOIN organization_members organization_membership
	  ON organization_membership.organization_id = project.organization_id
	 AND organization_membership.user_id = membership.user_id
	 AND organization_membership.status = 'ACTIVE'
	JOIN users person ON person.id = membership.user_id
		WHERE membership.project_id = $1
		  AND membership.status = 'ACTIVE'
		  AND membership.role = 'OWNER'
		  AND person.status = 'ACTIVE'`, projectID).Scan(&count)
	return count, err
}

func (s *store) ListMemberCandidates(ctx context.Context, projectID string, filter app.MemberFilter) ([]domain.User, error) {
	var cursorName, cursorID any
	if filter.Cursor != nil {
		cursorName, cursorID = filter.Cursor.DisplayName, filter.Cursor.ID
	}
	rows, err := s.q.Query(ctx, `
		SELECT person.id, person.display_name, person.email, person.status, person.avatar_url,
		       person.profile_updated_at, person.created_at, person.updated_at
		FROM projects project
		JOIN organization_members organization_membership
		  ON organization_membership.organization_id = project.organization_id
		 AND organization_membership.status = 'ACTIVE'
		JOIN users person ON person.id = organization_membership.user_id AND person.status = 'ACTIVE'
		LEFT JOIN project_members membership
		  ON membership.project_id = project.id AND membership.user_id = person.id
		WHERE project.id = $1
		  AND membership.user_id IS NULL
		  AND ($2::text = '' OR person.display_name ILIKE '%' || $2 || '%'
		       OR person.email::text ILIKE '%' || $2 || '%')
		  AND ($3::text IS NULL OR (lower(person.display_name), person.id) > ($3, $4::uuid))
		ORDER BY lower(person.display_name), person.id
		LIMIT $5`, projectID, filter.Search, cursorName, cursorID, filter.PageSize)
	if err != nil {
		return nil, fmt.Errorf("list project member candidates: %w", err)
	}
	defer rows.Close()
	items := make([]domain.User, 0, filter.PageSize)
	for rows.Next() {
		item, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *store) CreateMembership(ctx context.Context, projectID string, input app.CreateMembershipInput, actorID string) (domain.Membership, error) {
	var membershipID string
	err := s.q.QueryRow(ctx, `
		INSERT INTO project_members(
		  project_id, user_id, role, status, invited_by, joined_at, removed_at
		)
		VALUES (
		  $1, $2, $3, $4, $5,
		  CASE WHEN $4::project_membership_status = 'ACTIVE' THEN now() ELSE NULL END,
		  NULL
		)
		RETURNING id`, projectID, input.UserID, input.Role, input.Status, actorID).Scan(&membershipID)
	if err != nil {
		return domain.Membership{}, mapConstraintError(err)
	}
	return s.GetMembership(ctx, projectID, membershipID)
}

func (s *store) UpdateMembership(ctx context.Context, projectID, membershipID string, role domain.ProjectRole, status domain.MembershipStatus, expectedVersion int64, actorID string) (domain.Membership, error) {
	command, err := s.q.Exec(ctx, `
		UPDATE project_members SET
		  role = $3,
		  status = $4,
		  version = version + 1,
		  invited_by = CASE
		    WHEN status = 'REMOVED' AND $4::project_membership_status = 'INVITED' THEN $5
		    ELSE invited_by
		  END,
		  joined_at = CASE
		    WHEN $4::project_membership_status = 'INVITED' THEN NULL
		    WHEN $4::project_membership_status = 'ACTIVE' THEN COALESCE(joined_at, now())
		    ELSE joined_at
		  END,
		  removed_at = CASE
		    WHEN $4::project_membership_status = 'REMOVED' THEN now()
		    ELSE NULL
		  END,
		  updated_at = now()
		WHERE project_id = $1 AND id = $2 AND version = $6`, projectID, membershipID, role, status, actorID, expectedVersion)
	if err != nil {
		return domain.Membership{}, mapConstraintError(err)
	}
	if command.RowsAffected() == 0 {
		current, getErr := s.GetMembership(ctx, projectID, membershipID)
		if getErr != nil {
			return domain.Membership{}, getErr
		}
		return domain.Membership{}, domain.Validation("VERSION_CONFLICT", "The membership changed before it could be updated.", map[string]any{"current": current, "currentVersion": current.Version})
	}
	return s.GetMembership(ctx, projectID, membershipID)
}

func (s *store) CreateProject(ctx context.Context, input app.CreateProjectInput, actorID, organizationID string) (domain.Project, error) {
	metadata, err := json.Marshal(input.Metadata)
	if err != nil {
		return domain.Project{}, err
	}
	item, err := scanProject(s.q.QueryRow(ctx, `
		INSERT INTO projects(id, organization_id, name, description, metadata)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, name, description, metadata, version, created_at, updated_at`, input.ID, organizationID, input.Name, input.Description, metadata))
	if err != nil {
		return domain.Project{}, fmt.Errorf("create project: %w", err)
	}
	if _, err := s.q.Exec(ctx, `
		INSERT INTO project_members(project_id, user_id, role, status, invited_by, joined_at)
		VALUES ($1, $2, 'OWNER', 'ACTIVE', $2, now())`, item.ID, actorID); err != nil {
		return domain.Project{}, fmt.Errorf("add project owner: %w", err)
	}
	return item, nil
}

func (s *store) InitProjectStream(ctx context.Context, projectID string) error {
	_, err := s.q.Exec(ctx, `INSERT INTO project_streams(project_id, last_sequence) VALUES ($1, 0)`, projectID)
	return err
}

func (s *store) CreateTask(ctx context.Context, projectID string, input app.CreateTaskInput, actorID string) (domain.Task, error) {
	customFields, err := json.Marshal(input.CustomFields)
	if err != nil {
		return domain.Task{}, err
	}
	_, err = s.q.Exec(ctx, `
		INSERT INTO tasks(id, project_id, title, description, status, priority, custom_fields, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, input.ID, projectID, input.Title, input.Description, input.Status, input.Priority, customFields, actorID)
	if err != nil {
		return domain.Task{}, mapConstraintError(err)
	}
	if err := replaceTaskTags(ctx, s.q, projectID, input.ID, input.Tags); err != nil {
		return domain.Task{}, err
	}
	return getTask(ctx, s.q, projectID, input.ID)
}

func (s *store) CreateAttachment(ctx context.Context, input app.CreateAttachmentInput) (domain.Attachment, error) {
	item, err := scanAttachment(s.q.QueryRow(ctx, `
		INSERT INTO task_attachments(
			id, project_id, task_id, file_name, content_type, byte_size, checksum, storage_key, uploaded_by
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id, project_id, task_id, file_name, content_type, byte_size, checksum, storage_key, uploaded_by, created_at`,
		input.ID, input.ProjectID, input.TaskID, input.FileName, input.ContentType, input.ByteSize,
		input.Checksum, input.StorageKey, input.UploadedBy))
	if err != nil {
		return domain.Attachment{}, mapConstraintError(err)
	}
	if _, err := s.q.Exec(ctx, `DELETE FROM attachment_object_deletions WHERE storage_key = $1`, input.StorageKey); err != nil {
		return domain.Attachment{}, err
	}
	return item, nil
}

func (s *store) DeleteAttachment(ctx context.Context, projectID, taskID, attachmentID string) (domain.Attachment, error) {
	item, err := scanAttachment(s.q.QueryRow(ctx, `
		DELETE FROM task_attachments
		WHERE project_id = $1 AND task_id = $2 AND id = $3
		RETURNING id, project_id, task_id, file_name, content_type, byte_size, checksum, storage_key, uploaded_by, created_at`, projectID, taskID, attachmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Attachment{}, domain.ErrNotFound
	}
	return item, mapConstraintError(err)
}

func (s *store) GetTask(ctx context.Context, projectID, taskID string) (domain.Task, error) {
	return getTask(ctx, s.q, projectID, taskID)
}

func (s *store) GetTaskForUpdate(ctx context.Context, projectID, taskID string) (domain.Task, error) {
	return getTaskForUpdate(ctx, s.q, projectID, taskID)
}

func (s *store) EnsureTaskDescriptionDocument(ctx context.Context, projectID, taskID string) error {
	_, err := s.q.Exec(ctx, `
		INSERT INTO task_description_documents(project_id, task_id)
		VALUES ($1, $2)
		ON CONFLICT (project_id, task_id) DO NOTHING`, projectID, taskID)
	return err
}

func (s *store) InitializeTaskDescriptionDocument(ctx context.Context, projectID, taskID string, snapshot []byte) (bool, error) {
	command, err := s.q.Exec(ctx, `
		UPDATE task_description_documents
		SET initialized = true, snapshot = $3, updated_at = now()
		WHERE project_id = $1 AND task_id = $2 AND initialized = false`, projectID, taskID, snapshot)
	return command.RowsAffected() == 1, err
}

func (s *store) AppendTaskDescriptionUpdate(ctx context.Context, projectID, taskID, actorID string, update []byte) error {
	_, err := s.q.Exec(ctx, `
		INSERT INTO task_description_updates(project_id, task_id, actor_id, update_data)
		SELECT $1, $2, $3, $4
		FROM task_description_documents
		WHERE project_id = $1 AND task_id = $2
		FOR UPDATE`, projectID, taskID, actorID, update)
	return err
}

func (s *store) UpdateTaskDescriptionProjection(ctx context.Context, projectID, taskID, description string) error {
	_, err := s.q.Exec(ctx, `
		UPDATE tasks SET description = $3, updated_at = now()
		WHERE project_id = $1 AND id = $2`, projectID, taskID, description)
	return err
}

func (s *store) ListTaskOperationsAfter(ctx context.Context, projectID, taskID string, version int64) ([]domain.TaskOperation, error) {
	rows, err := s.q.Query(ctx, `
		SELECT id, project_id, task_id, actor_id, request_id, operation_type,
		       changed_fields, before_state, after_state, base_version,
		       resulting_version, last_action_version, state, created_at, acted_at
		FROM task_operations
		WHERE project_id = $1 AND task_id = $2 AND last_action_version > $3
		ORDER BY last_action_version, created_at, id`, projectID, taskID, version)
	if err != nil {
		return nil, fmt.Errorf("list task operations: %w", err)
	}
	defer rows.Close()
	operations := make([]domain.TaskOperation, 0)
	for rows.Next() {
		operation, scanErr := scanTaskOperation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		operations = append(operations, operation)
	}
	return operations, rows.Err()
}

func (s *store) GetLatestTaskOperation(ctx context.Context, projectID, taskID, actorID, state string) (domain.TaskOperation, error) {
	operation, err := scanTaskOperation(s.q.QueryRow(ctx, `
		SELECT id, project_id, task_id, actor_id, request_id, operation_type,
		       changed_fields, before_state, after_state, base_version,
		       resulting_version, last_action_version, state, created_at, acted_at
		FROM task_operations
		WHERE project_id = $1 AND task_id = $2 AND actor_id = $3 AND state = $4
		ORDER BY
		  CASE WHEN state = 'UNDONE' THEN acted_at END DESC NULLS LAST,
		  CASE WHEN state = 'ACTIVE' THEN resulting_version END DESC NULLS LAST,
		  created_at DESC, id DESC
		LIMIT 1`, projectID, taskID, actorID, state))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskOperation{}, domain.ErrNotFound
	}
	return operation, err
}

func (s *store) CreateTaskOperation(ctx context.Context, operation domain.TaskOperation) error {
	before, err := json.Marshal(operation.BeforeState)
	if err != nil {
		return fmt.Errorf("encode task operation before state: %w", err)
	}
	after, err := json.Marshal(operation.AfterState)
	if err != nil {
		return fmt.Errorf("encode task operation after state: %w", err)
	}
	_, err = s.q.Exec(ctx, `
		INSERT INTO task_operations(
		  id, project_id, task_id, actor_id, request_id, operation_type,
		  changed_fields, before_state, after_state, base_version,
		  resulting_version, last_action_version, state, acted_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		operation.ID, operation.ProjectID, operation.TaskID, operation.ActorID,
		operation.RequestID, operation.OperationType, operation.ChangedFields,
		before, after, operation.BaseVersion, operation.ResultingVersion,
		operation.LastActionVersion, operation.State, operation.ActedAt)
	return mapConstraintError(err)
}

func (s *store) SetTaskOperationState(ctx context.Context, operationID, state string, actionVersion int64) error {
	command, err := s.q.Exec(ctx, `
		UPDATE task_operations
		SET state = $2, last_action_version = $3, acted_at = now()
		WHERE id = $1`, operationID, state, actionVersion)
	if err != nil {
		return mapConstraintError(err)
	}
	if command.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return nil
}

func (s *store) InvalidateRedoOperations(ctx context.Context, projectID, taskID, actorID string) error {
	_, err := s.q.Exec(ctx, `
		UPDATE task_operations
		SET state = 'INVALIDATED', acted_at = now()
		WHERE project_id = $1 AND task_id = $2 AND actor_id = $3 AND state = 'UNDONE'`,
		projectID, taskID, actorID)
	return err
}

func (s *store) UpdateTask(ctx context.Context, projectID, taskID string, expectedVersion int64, input app.UpdateTaskInput) (domain.Task, error) {
	var status, priority any
	if input.Status != nil {
		status = string(*input.Status)
	}
	if input.Priority != nil {
		priority = string(*input.Priority)
	}
	var customFields any
	if input.CustomFields != nil {
		b, err := json.Marshal(*input.CustomFields)
		if err != nil {
			return domain.Task{}, err
		}
		customFields = b
	}
	command, err := s.q.Exec(ctx, `
		UPDATE tasks SET
		  title = COALESCE($4::text, title),
		  description = COALESCE($5::text, description),
		  status = COALESCE($6::task_status, status),
		  priority = COALESCE($7::task_priority, priority),
		  custom_fields = COALESCE($8::jsonb, custom_fields),
		  version = version + 1,
		  updated_at = now()
		WHERE project_id = $1 AND id = $2 AND version = $3`, projectID, taskID, expectedVersion, input.Title, input.Description, status, priority, customFields)
	if err != nil {
		return domain.Task{}, mapConstraintError(err)
	}
	if command.RowsAffected() == 0 {
		current, getErr := getTask(ctx, s.q, projectID, taskID)
		if getErr != nil {
			return domain.Task{}, getErr
		}
		return domain.Task{}, domain.Validation("VERSION_CONFLICT", "The task changed after this client loaded it.", map[string]any{"current": current, "currentVersion": current.Version})
	}
	if input.Tags != nil {
		if err := replaceTaskTags(ctx, s.q, projectID, taskID, *input.Tags); err != nil {
			return domain.Task{}, err
		}
	}
	return getTask(ctx, s.q, projectID, taskID)
}

func (s *store) DeleteTask(ctx context.Context, projectID, taskID string, expectedVersion int64) (domain.Task, error) {
	current, err := getTask(ctx, s.q, projectID, taskID)
	if err != nil {
		return domain.Task{}, err
	}
	if current.Version != expectedVersion {
		return domain.Task{}, domain.Validation("VERSION_CONFLICT", "The task changed after this client loaded it.", map[string]any{"current": current, "currentVersion": current.Version})
	}
	command, err := s.q.Exec(ctx, `DELETE FROM tasks WHERE project_id = $1 AND id = $2 AND version = $3`, projectID, taskID, expectedVersion)
	if err != nil {
		return domain.Task{}, err
	}
	if command.RowsAffected() == 0 {
		return domain.Task{}, domain.ErrNotFound
	}
	current.Version++
	return current, nil
}

func (s *store) ReplaceTaskAssignees(ctx context.Context, projectID, taskID string, desiredUserIDs []string, actorID, requestID string) ([]domain.AssignmentOperation, error) {
	rows, err := s.q.Query(ctx, `
		SELECT user_id
		FROM task_assignees
		WHERE project_id = $1 AND task_id = $2
		ORDER BY user_id
		FOR UPDATE`, projectID, taskID)
	if err != nil {
		return nil, err
	}
	current := make(map[string]struct{})
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return nil, err
		}
		current[userID] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	desired := make(map[string]struct{}, len(desiredUserIDs))
	for _, userID := range desiredUserIDs {
		desired[userID] = struct{}{}
	}
	added, removed := make([]string, 0), make([]string, 0)
	for userID := range desired {
		if _, exists := current[userID]; !exists {
			added = append(added, userID)
		}
	}
	for userID := range current {
		if _, exists := desired[userID]; !exists {
			removed = append(removed, userID)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)

	operations := make([]domain.AssignmentOperation, 0, len(added)+len(removed))
	for _, userID := range removed {
		membershipID, err := membershipIDForUser(ctx, s.q, projectID, userID, false)
		if err != nil {
			return nil, err
		}
		if _, err := s.q.Exec(ctx, `DELETE FROM task_assignees WHERE project_id = $1 AND task_id = $2 AND user_id = $3`, projectID, taskID, userID); err != nil {
			return nil, err
		}
		operation, err := insertAssignmentOperation(ctx, s.q, projectID, taskID, userID, membershipID, domain.AssignmentUnassigned, actorID, requestID)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	for _, userID := range added {
		membershipID, err := membershipIDForUser(ctx, s.q, projectID, userID, true)
		if err != nil {
			return nil, err
		}
		if _, err := s.q.Exec(ctx, `
			INSERT INTO task_assignees(project_id, task_id, user_id, assigned_at, assigned_by)
			VALUES ($1, $2, $3, now(), $4)`, projectID, taskID, userID, actorID); err != nil {
			return nil, mapConstraintError(err)
		}
		operation, err := insertAssignmentOperation(ctx, s.q, projectID, taskID, userID, membershipID, domain.AssignmentAssigned, actorID, requestID)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return operations, nil
}

func (s *store) UnassignProjectMember(ctx context.Context, projectID, userID, actorID, requestID string) ([]domain.AssignmentOperation, error) {
	membershipID, err := membershipIDForUser(ctx, s.q, projectID, userID, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.Query(ctx, `
		SELECT task_id
		FROM task_assignees
		WHERE project_id = $1 AND user_id = $2
		ORDER BY task_id
		FOR UPDATE`, projectID, userID)
	if err != nil {
		return nil, err
	}
	taskIDs := make([]string, 0)
	for rows.Next() {
		var taskID string
		if err := rows.Scan(&taskID); err != nil {
			rows.Close()
			return nil, err
		}
		taskIDs = append(taskIDs, taskID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	operations := make([]domain.AssignmentOperation, 0, len(taskIDs))
	for _, taskID := range taskIDs {
		if _, err := s.q.Exec(ctx, `DELETE FROM task_assignees WHERE project_id = $1 AND task_id = $2 AND user_id = $3`, projectID, taskID, userID); err != nil {
			return nil, err
		}
		// Assignment state is part of the task projection. Bump its version so
		// clients holding an older ETag cannot overwrite the removal silently.
		if _, err := s.q.Exec(ctx, `UPDATE tasks SET version = version + 1, updated_at = now() WHERE project_id = $1 AND id = $2`, projectID, taskID); err != nil {
			return nil, err
		}
		operation, err := insertAssignmentOperation(ctx, s.q, projectID, taskID, userID, membershipID, domain.AssignmentUnassigned, actorID, requestID)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return operations, nil
}

func (s *store) LockDependencyGraph(ctx context.Context, projectID string) error {
	_, err := s.q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('dependency:' || $1::text, 0))`, projectID)
	return err
}

func (s *store) DependencyExists(ctx context.Context, projectID, taskID, dependencyID string) (bool, error) {
	var exists bool
	err := s.q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_dependencies WHERE project_id = $1 AND task_id = $2 AND depends_on_task_id = $3)`, projectID, taskID, dependencyID).Scan(&exists)
	return exists, err
}

func (s *store) DependencyWouldCycle(ctx context.Context, projectID, taskID, dependencyID string) (bool, error) {
	var cycles bool
	err := s.q.QueryRow(ctx, `
		WITH RECURSIVE reachable(id, depth) AS (
		  SELECT $2::uuid, 0
		  UNION
		  SELECT td.depends_on_task_id, r.depth + 1
		  FROM reachable r
		  JOIN task_dependencies td ON td.project_id = $1 AND td.task_id = r.id
		  WHERE r.depth < 1000
		)
		SELECT EXISTS(SELECT 1 FROM reachable WHERE id = $3::uuid)`, projectID, dependencyID, taskID).Scan(&cycles)
	return cycles, err
}

func (s *store) AddDependency(ctx context.Context, projectID, taskID, dependencyID, actorID string) error {
	_, err := s.q.Exec(ctx, `INSERT INTO task_dependencies(project_id, task_id, depends_on_task_id, created_by) VALUES ($1, $2, $3, $4)`, projectID, taskID, dependencyID, actorID)
	return mapConstraintError(err)
}

func (s *store) RemoveDependency(ctx context.Context, projectID, taskID, dependencyID string) (bool, error) {
	command, err := s.q.Exec(ctx, `DELETE FROM task_dependencies WHERE project_id = $1 AND task_id = $2 AND depends_on_task_id = $3`, projectID, taskID, dependencyID)
	return command.RowsAffected() == 1, err
}

func (s *store) CommentParentExists(ctx context.Context, projectID, taskID, parentID string) (bool, error) {
	var exists bool
	err := s.q.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM comments
			WHERE project_id = $1 AND task_id = $2 AND id = $3 AND deleted_at IS NULL
		)`, projectID, taskID, parentID).Scan(&exists)
	return exists, err
}

func (s *store) CommentExists(ctx context.Context, projectID, taskID, commentID string) (bool, error) {
	var exists bool
	err := s.q.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM comments
			WHERE project_id = $1 AND task_id = $2 AND id = $3 AND deleted_at IS NULL
		)`, projectID, taskID, commentID).Scan(&exists)
	return exists, err
}

func (s *store) SetCommentReaction(ctx context.Context, projectID, taskID, commentID, reactionType, actorID string) (domain.CommentReaction, error) {
	_, err := s.q.Exec(ctx, `
		INSERT INTO comment_reactions(project_id, comment_id, user_id, reaction_type)
		VALUES ($1, $3, $5, $4)
		ON CONFLICT (project_id, comment_id, user_id)
		DO UPDATE SET reaction_type = EXCLUDED.reaction_type`, projectID, taskID, commentID, reactionType, actorID)
	if err != nil {
		return domain.CommentReaction{}, mapConstraintError(err)
	}
	return s.commentReaction(ctx, projectID, taskID, commentID, reactionType, true)
}

func (s *store) RemoveCommentReaction(ctx context.Context, projectID, taskID, commentID, actorID string) (domain.CommentReaction, error) {
	var reactionType string
	err := s.q.QueryRow(ctx, `SELECT reaction_type FROM comment_reactions WHERE project_id = $1 AND comment_id = $2 AND user_id = $3`, projectID, commentID, actorID).Scan(&reactionType)
	if errors.Is(err, pgx.ErrNoRows) {
		reactionType = "LIKE"
	} else if err != nil {
		return domain.CommentReaction{}, err
	}
	if _, err := s.q.Exec(ctx, `DELETE FROM comment_reactions WHERE project_id = $1 AND comment_id = $2 AND user_id = $3`, projectID, commentID, actorID); err != nil {
		return domain.CommentReaction{}, err
	}
	return s.commentReaction(ctx, projectID, taskID, commentID, reactionType, false)
}

func (s *store) commentReaction(ctx context.Context, projectID, taskID, commentID, reactionType string, reacted bool) (domain.CommentReaction, error) {
	var count int64
	if reactionType != "" {
		if err := s.q.QueryRow(ctx, `SELECT count(*) FROM comment_reactions WHERE project_id = $1 AND comment_id = $2 AND reaction_type = $3`, projectID, commentID, reactionType).Scan(&count); err != nil {
			return domain.CommentReaction{}, err
		}
	}
	return domain.CommentReaction{ProjectID: projectID, TaskID: taskID, CommentID: commentID, ReactionType: reactionType, Count: count, Reacted: reacted}, nil
}

func (s *store) CreateMentionNotifications(ctx context.Context, projectID, taskID, commentID, actorID, body string) ([]domain.Notification, error) {
	rows, err := s.q.Query(ctx, `
		WITH mention_tokens AS (
			SELECT DISTINCT lower(mention_match[1]) AS handle
			FROM regexp_matches($5, '@([A-Za-z0-9][A-Za-z0-9._-]*)', 'g') AS mention_match
		), targets AS (
			SELECT pm.user_id
			FROM project_members pm
			JOIN users u ON u.id = pm.user_id
			JOIN mention_tokens token ON token.handle = lower(split_part(u.email::text, '@', 1))
				OR token.handle = lower(split_part(u.display_name, ' ', 1))
				OR token.handle = lower(regexp_replace(u.display_name, '[^A-Za-z0-9]', '', 'g'))
			WHERE pm.project_id = $1
			  AND pm.status = 'ACTIVE'
			  AND u.status = 'ACTIVE'
			  AND pm.user_id <> $4
		)
		INSERT INTO notifications (id, project_id, user_id, task_id, comment_id, actor_id, notification_type, body)
		SELECT gen_random_uuid(), $1, targets.user_id, $2, $3, $4, 'MENTION', 'You were mentioned in a comment.'
		FROM targets
		ON CONFLICT (project_id, comment_id, user_id, notification_type) DO NOTHING
		RETURNING id, project_id, user_id, task_id, comment_id, actor_id, notification_type, body, read_at, created_at`, projectID, taskID, commentID, actorID, body)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Notification, 0)
	for rows.Next() {
		var item domain.Notification
		if err := rows.Scan(&item.ID, &item.ProjectID, &item.UserID, &item.TaskID, &item.CommentID, &item.ActorID, &item.Type, &item.Body, &item.ReadAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *store) CreateTaskUpdateNotifications(ctx context.Context, projectID, taskID, actorID, requestID string, recipientIDs []string) error {
	_, err := s.q.Exec(ctx, `
		INSERT INTO notifications (id, project_id, user_id, task_id, actor_id, notification_type, body, request_id)
		SELECT gen_random_uuid(), $1, membership.user_id, $2, $3, 'TASK_UPDATED', task.title || ' was updated.', $4
		FROM project_members membership
		JOIN users person ON person.id = membership.user_id
		JOIN projects project ON project.id = membership.project_id
		JOIN organization_members organization_membership
		  ON organization_membership.organization_id = project.organization_id
		 AND organization_membership.user_id = membership.user_id
		JOIN tasks task ON task.project_id = membership.project_id AND task.id = $2
		WHERE membership.project_id = $1
		  AND membership.user_id = ANY($5::uuid[])
		  AND membership.user_id <> $3
		  AND membership.status = 'ACTIVE'
		  AND organization_membership.status = 'ACTIVE'
		  AND person.status = 'ACTIVE'
		ON CONFLICT (project_id, user_id, notification_type, request_id)
		WHERE notification_type = 'TASK_UPDATED'
		DO NOTHING`, projectID, taskID, actorID, requestID, recipientIDs)
	return err
}

func (s *store) MarkNotificationRead(ctx context.Context, projectID, actorID, notificationID string) (domain.Notification, error) {
	var item domain.Notification
	err := s.q.QueryRow(ctx, `
		UPDATE notifications
		SET read_at = COALESCE(read_at, now())
		WHERE project_id = $1 AND user_id = $2 AND id = $3
		RETURNING id, project_id, user_id, task_id, comment_id, actor_id, notification_type, body, read_at, created_at`, projectID, actorID, notificationID).
		Scan(&item.ID, &item.ProjectID, &item.UserID, &item.TaskID, &item.CommentID, &item.ActorID, &item.Type, &item.Body, &item.ReadAt, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Notification{}, domain.ErrNotFound
	}
	return item, err
}

func (s *store) CreateComment(ctx context.Context, projectID, taskID string, input app.CreateCommentInput, actorID string) (domain.Comment, error) {
	var comment domain.Comment
	comment.Author.ID = actorID
	err := s.q.QueryRow(ctx, `
		INSERT INTO comments(id, project_id, task_id, parent_id, author_id, body)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, project_id, task_id, parent_id, body, version, created_at, updated_at, deleted_at`, input.ID, projectID, taskID, input.ParentID, actorID, input.Body).
		Scan(&comment.ID, &comment.ProjectID, &comment.TaskID, &comment.ParentID, &comment.Body, &comment.Version, &comment.CreatedAt, &comment.UpdatedAt, &comment.DeletedAt)
	if err != nil {
		return domain.Comment{}, mapConstraintError(err)
	}
	if _, err := s.q.Exec(ctx, `UPDATE tasks SET comment_count = comment_count + 1 WHERE project_id = $1 AND id = $2`, projectID, taskID); err != nil {
		return domain.Comment{}, fmt.Errorf("increment comment count: %w", err)
	}
	err = s.q.QueryRow(ctx, `SELECT display_name, email, created_at FROM users WHERE id = $1`, actorID).
		Scan(&comment.Author.DisplayName, &comment.Author.Email, &comment.Author.CreatedAt)
	return comment, err
}

func (s *store) AppendEvent(ctx context.Context, draft app.EventDraft) (domain.Event, error) {
	payload, err := json.Marshal(draft.Payload)
	if err != nil {
		return domain.Event{}, fmt.Errorf("encode sync event: %w", err)
	}
	if len(payload) > 64*1024 {
		return domain.Event{}, domain.Validation("EVENT_PAYLOAD_TOO_LARGE", "The synchronization event exceeds 64 KB.", nil)
	}
	var sequence int64
	err = s.q.QueryRow(ctx, `UPDATE project_streams SET last_sequence = last_sequence + 1 WHERE project_id = $1 RETURNING last_sequence`, draft.ProjectID).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Event{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Event{}, fmt.Errorf("allocate event sequence: %w", err)
	}
	event := domain.Event{ProjectID: draft.ProjectID, Sequence: sequence, Type: draft.Type, AggregateType: draft.AggregateType, AggregateID: draft.AggregateID, AggregateVersion: draft.AggregateVersion, ActorID: draft.ActorID, RequestID: draft.RequestID, Payload: payload}
	err = s.q.QueryRow(ctx, `
		INSERT INTO sync_events(project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_version, actor_id, request_id, payload)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING occurred_at`, event.ProjectID, event.Sequence, event.Type, event.AggregateType, event.AggregateID, event.AggregateVersion, nullableString(event.ActorID), event.RequestID, event.Payload).
		Scan(&event.OccurredAt)
	if err != nil {
		return domain.Event{}, fmt.Errorf("append sync event: %w", err)
	}
	if _, err := s.q.Exec(ctx, `SELECT pg_notify('sync_events', $1)`, draft.ProjectID); err != nil {
		return domain.Event{}, fmt.Errorf("notify sync event: %w", err)
	}
	return event, nil
}

const membershipSelect = `
	SELECT membership.id, membership.project_id,
	       person.id, person.display_name, person.email, person.status, person.avatar_url,
	       person.profile_updated_at, person.created_at, person.updated_at,
	       membership.role, membership.status, membership.version, membership.invited_by,
      membership.joined_at, membership.removed_at,
      membership.created_at, membership.updated_at
	FROM project_members membership
	JOIN projects project ON project.id = membership.project_id
	JOIN organization_members organization_membership
	  ON organization_membership.organization_id = project.organization_id
	 AND organization_membership.user_id = membership.user_id
	 AND organization_membership.status = 'ACTIVE'
	JOIN users person ON person.id = membership.user_id `

const taskSelect = `
	SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
	       t.custom_fields, t.comment_count, t.version, t.created_by, t.created_at, t.updated_at,
	       COALESCE((
	           SELECT jsonb_agg(ta.user_id ORDER BY ta.user_id)
	           FROM task_assignees ta
		   JOIN project_members active_membership
		     ON active_membership.project_id = ta.project_id
		    AND active_membership.user_id = ta.user_id
		    AND active_membership.status = 'ACTIVE'
		   JOIN projects assignment_project
		     ON assignment_project.id = ta.project_id
		   JOIN organization_members assignment_organization
		     ON assignment_organization.organization_id = assignment_project.organization_id
		    AND assignment_organization.user_id = ta.user_id
		    AND assignment_organization.status = 'ACTIVE'
		   JOIN users active_person
	             ON active_person.id = ta.user_id
	            AND active_person.status = 'ACTIVE'
	           WHERE ta.project_id=t.project_id AND ta.task_id=t.id
	       ), '[]'::jsonb),
	       COALESCE((SELECT jsonb_agg(tt.tag ORDER BY tt.tag) FROM task_tags tt WHERE tt.project_id=t.project_id AND tt.task_id=t.id), '[]'::jsonb),
	       COALESCE((SELECT jsonb_agg(td.depends_on_task_id ORDER BY td.depends_on_task_id) FROM task_dependencies td WHERE td.project_id=t.project_id AND td.task_id=t.id), '[]'::jsonb)
	FROM tasks t `

func getTask(ctx context.Context, q querier, projectID, taskID string) (domain.Task, error) {
	item, err := scanTask(q.QueryRow(ctx, taskSelect+` WHERE t.project_id = $1 AND t.id = $2`, projectID, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Task{}, domain.ErrNotFound
	}
	return item, err
}

func getTaskForUpdate(ctx context.Context, q querier, projectID, taskID string) (domain.Task, error) {
	item, err := scanTask(q.QueryRow(ctx, taskSelect+` WHERE t.project_id = $1 AND t.id = $2 FOR UPDATE OF t`, projectID, taskID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Task{}, domain.ErrNotFound
	}
	return item, err
}

func getAttachment(ctx context.Context, q querier, projectID, taskID, attachmentID string) (domain.Attachment, error) {
	item, err := scanAttachment(q.QueryRow(ctx, `
		SELECT id, project_id, task_id, file_name, content_type, byte_size, checksum, storage_key, uploaded_by, created_at
		FROM task_attachments
		WHERE project_id = $1 AND task_id = $2 AND id = $3`, projectID, taskID, attachmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Attachment{}, domain.ErrNotFound
	}
	return item, err
}

func scanUser(row scanner) (domain.User, error) {
	var item domain.User
	err := row.Scan(&item.ID, &item.DisplayName, &item.Email, &item.Status, &item.AvatarURL,
		&item.ProfileUpdatedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func scanProject(row scanner) (domain.Project, error) {
	var item domain.Project
	var metadata []byte
	err := row.Scan(&item.ID, &item.OrganizationID, &item.Name, &item.Description, &metadata, &item.Version, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(metadata, &item.Metadata); err != nil {
		return item, err
	}
	return item, nil
}

func scanProjectWithTaskCount(row scanner) (domain.Project, error) {
	var item domain.Project
	var metadata []byte
	err := row.Scan(&item.ID, &item.OrganizationID, &item.Name, &item.Description, &metadata, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.TaskCount)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(metadata, &item.Metadata); err != nil {
		return item, err
	}
	return item, nil
}

func scanAttachment(row scanner) (domain.Attachment, error) {
	var item domain.Attachment
	err := row.Scan(&item.ID, &item.ProjectID, &item.TaskID, &item.FileName, &item.ContentType,
		&item.ByteSize, &item.Checksum, &item.StorageKey, &item.UploadedBy, &item.CreatedAt)
	return item, err
}

func scanTask(row scanner) (domain.Task, error) {
	var item domain.Task
	var customFields, assignees, tags, dependencies []byte
	err := row.Scan(&item.ID, &item.ProjectID, &item.Title, &item.Description, &item.Status, &item.Priority,
		&customFields, &item.CommentCount, &item.Version, &item.CreatedBy, &item.CreatedAt, &item.UpdatedAt,
		&assignees, &tags, &dependencies)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(customFields, &item.CustomFields); err != nil {
		return item, err
	}
	if err := json.Unmarshal(assignees, &item.AssigneeIDs); err != nil {
		return item, err
	}
	if err := json.Unmarshal(tags, &item.Tags); err != nil {
		return item, err
	}
	if err := json.Unmarshal(dependencies, &item.DependencyIDs); err != nil {
		return item, err
	}
	return item, nil
}

func scanComment(row scanner) (domain.Comment, error) {
	var item domain.Comment
	var reactions []byte
	err := row.Scan(&item.ID, &item.ProjectID, &item.TaskID, &item.ParentID, &item.Body, &item.Version, &item.CreatedAt,
		&item.UpdatedAt, &item.DeletedAt, &item.Author.ID, &item.Author.DisplayName, &item.Author.Email, &item.Author.CreatedAt, &reactions)
	if err == nil && len(reactions) > 0 {
		err = json.Unmarshal(reactions, &item.Reactions)
	}
	return item, err
}

func scanMembership(row scanner) (domain.Membership, error) {
	var item domain.Membership
	err := row.Scan(
		&item.ID, &item.ProjectID,
		&item.User.ID, &item.User.DisplayName, &item.User.Email, &item.User.Status, &item.User.AvatarURL,
		&item.User.ProfileUpdatedAt, &item.User.CreatedAt, &item.User.UpdatedAt,
		&item.Role, &item.Status, &item.Version, &item.InvitedBy,
		&item.JoinedAt, &item.RemovedAt, &item.CreatedAt, &item.UpdatedAt,
	)
	return item, err
}

func scanAssignmentOperation(row scanner) (domain.AssignmentOperation, error) {
	var item domain.AssignmentOperation
	err := row.Scan(&item.ID, &item.ProjectID, &item.TaskID, &item.UserID, &item.MembershipID,
		&item.Operation, &item.ActorID, &item.RequestID, &item.OccurredAt)
	return item, err
}

func scanTaskOperation(row scanner) (domain.TaskOperation, error) {
	var item domain.TaskOperation
	var before, after []byte
	err := row.Scan(&item.ID, &item.ProjectID, &item.TaskID, &item.ActorID, &item.RequestID,
		&item.OperationType, &item.ChangedFields, &before, &after, &item.BaseVersion,
		&item.ResultingVersion, &item.LastActionVersion, &item.State, &item.CreatedAt, &item.ActedAt)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(before, &item.BeforeState); err != nil {
		return item, err
	}
	if err := json.Unmarshal(after, &item.AfterState); err != nil {
		return item, err
	}
	return item, nil
}

func scanEvent(row scanner) (domain.Event, error) {
	var item domain.Event
	var actorID *string
	err := row.Scan(&item.ProjectID, &item.Sequence, &item.Type, &item.AggregateType, &item.AggregateID,
		&item.AggregateVersion, &actorID, &item.RequestID, &item.Payload, &item.OccurredAt)
	if actorID != nil {
		item.ActorID = *actorID
	}
	return item, err
}

func replaceTaskTags(ctx context.Context, q querier, projectID, taskID string, tags []string) error {
	if _, err := q.Exec(ctx, `DELETE FROM task_tags WHERE project_id = $1 AND task_id = $2`, projectID, taskID); err != nil {
		return err
	}
	for _, tag := range tags {
		if _, err := q.Exec(ctx, `INSERT INTO task_tags(project_id, task_id, tag) VALUES ($1,$2,$3)`, projectID, taskID, tag); err != nil {
			return mapConstraintError(err)
		}
	}
	return nil
}

func membershipIDForUser(ctx context.Context, q querier, projectID, userID string, requireActive bool) (string, error) {
	var membershipID string
	err := q.QueryRow(ctx, `
		SELECT membership.id
		FROM project_members membership
		JOIN users person ON person.id = membership.user_id
		WHERE membership.project_id = $1
		  AND membership.user_id = $2
		  AND (NOT $3 OR (membership.status = 'ACTIVE' AND person.status = 'ACTIVE'))`, projectID, userID, requireActive).Scan(&membershipID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.Validation("ASSIGNEE_NOT_PROJECT_MEMBER", "Every assignee must have an active project membership.", nil)
	}
	return membershipID, err
}

func insertAssignmentOperation(ctx context.Context, q querier, projectID, taskID, userID, membershipID string, operation domain.AssignmentOperationType, actorID, requestID string) (domain.AssignmentOperation, error) {
	item := domain.AssignmentOperation{
		ID: uuid.Must(uuid.NewV7()).String(), ProjectID: projectID, TaskID: taskID,
		UserID: userID, MembershipID: membershipID, Operation: operation,
		ActorID: actorID, RequestID: requestID,
	}
	err := q.QueryRow(ctx, `
		INSERT INTO task_assignment_operations(
		  id, project_id, task_id, user_id, membership_id,
		  operation, actor_id, request_id
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING occurred_at`, item.ID, item.ProjectID, item.TaskID, item.UserID,
		item.MembershipID, item.Operation, item.ActorID, item.RequestID).Scan(&item.OccurredAt)
	if err != nil {
		return domain.AssignmentOperation{}, mapConstraintError(err)
	}
	return item, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func mapConstraintError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return domain.Validation("ALREADY_EXISTS", "The resource already exists.", map[string]any{"constraint": pgErr.ConstraintName})
		case "23503", "23514", "22P02":
			return domain.Validation("CONSTRAINT_VIOLATION", "The request violates a data constraint.", map[string]any{"constraint": pgErr.ConstraintName})
		}
	}
	return err
}
