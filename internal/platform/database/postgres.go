package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/app"
	"github.com/eswaravegi/happy-task-management/internal/domain"
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
		SELECT p.id, p.name, p.description, p.metadata, p.version, p.created_at, p.updated_at,
		       count(t.id) AS task_count
		FROM projects p
		JOIN project_members pm ON pm.project_id = p.id
		LEFT JOIN tasks t ON t.project_id = p.id
		WHERE pm.user_id = $1
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
		SELECT u.id, u.display_name, u.email, u.created_at
		FROM project_members pm JOIN users u ON u.id = pm.user_id
		WHERE pm.project_id = $1 ORDER BY u.display_name, u.id`, projectID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var user domain.User
		if err := rows.Scan(&user.ID, &user.DisplayName, &user.Email, &user.CreatedAt); err != nil {
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
		SELECT p.id, p.name, p.description, p.metadata, p.version, p.created_at, p.updated_at
		FROM projects p
		JOIN project_members pm ON pm.project_id = p.id
		WHERE p.id = $1 AND pm.user_id = $2`, projectID, actorID))
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
		  AND ($5::timestamptz IS NULL OR (t.updated_at, t.id) < ($5, $6::uuid))
		ORDER BY t.updated_at DESC, t.id DESC
		LIMIT $7`, projectID, status, priority, filter.Search, cursorTime, cursorID, filter.PageSize)
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

func (p *Postgres) ListComments(ctx context.Context, projectID, taskID string, filter app.CommentFilter) ([]domain.Comment, error) {
	var cursorTime, cursorID any
	if filter.Cursor != nil {
		cursorTime, cursorID = filter.Cursor.CreatedAt, filter.Cursor.ID
	}
	rows, err := p.pool.Query(ctx, `
		SELECT c.id, c.project_id, c.task_id, c.body, c.version, c.created_at,
		       c.updated_at, c.deleted_at,
		       u.id, u.display_name, u.email, u.created_at
		FROM comments c
		JOIN users u ON u.id = c.author_id
		WHERE c.project_id = $1 AND c.task_id = $2
		  AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3, $4::uuid))
		ORDER BY c.created_at DESC, c.id DESC
		LIMIT $5`, projectID, taskID, cursorTime, cursorID, filter.PageSize)
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
	err := s.q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, actorID).Scan(&exists)
	return exists, err
}

func (s *store) IsProjectMember(ctx context.Context, projectID, actorID string) (bool, error) {
	var exists bool
	err := s.q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2)`, projectID, actorID).Scan(&exists)
	return exists, err
}

func (s *store) AreProjectMembers(ctx context.Context, projectID string, actorIDs []string) (bool, error) {
	var count int
	err := s.q.QueryRow(ctx, `SELECT count(DISTINCT user_id) FROM project_members WHERE project_id = $1 AND user_id = ANY($2::uuid[])`, projectID, actorIDs).Scan(&count)
	return count == len(actorIDs), err
}

func (s *store) CreateProject(ctx context.Context, input app.CreateProjectInput, actorID string) (domain.Project, error) {
	metadata, err := json.Marshal(input.Metadata)
	if err != nil {
		return domain.Project{}, err
	}
	item, err := scanProject(s.q.QueryRow(ctx, `
		INSERT INTO projects(id, name, description, metadata)
		VALUES ($1, $2, $3, $4)
		RETURNING id, name, description, metadata, version, created_at, updated_at`, input.ID, input.Name, input.Description, metadata))
	if err != nil {
		return domain.Project{}, fmt.Errorf("create project: %w", err)
	}
	if _, err := s.q.Exec(ctx, `INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'OWNER')`, item.ID, actorID); err != nil {
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
	if err := replaceTaskAssignees(ctx, s.q, projectID, input.ID, input.AssigneeIDs); err != nil {
		return domain.Task{}, err
	}
	if err := replaceTaskTags(ctx, s.q, projectID, input.ID, input.Tags); err != nil {
		return domain.Task{}, err
	}
	return getTask(ctx, s.q, projectID, input.ID)
}

func (s *store) GetTask(ctx context.Context, projectID, taskID string) (domain.Task, error) {
	return getTask(ctx, s.q, projectID, taskID)
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
	if input.AssigneeIDs != nil {
		if err := replaceTaskAssignees(ctx, s.q, projectID, taskID, *input.AssigneeIDs); err != nil {
			return domain.Task{}, err
		}
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

func (s *store) CreateComment(ctx context.Context, projectID, taskID string, input app.CreateCommentInput, actorID string) (domain.Comment, error) {
	var comment domain.Comment
	comment.Author.ID = actorID
	err := s.q.QueryRow(ctx, `
		INSERT INTO comments(id, project_id, task_id, author_id, body)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, project_id, task_id, body, version, created_at, updated_at, deleted_at`, input.ID, projectID, taskID, actorID, input.Body).
		Scan(&comment.ID, &comment.ProjectID, &comment.TaskID, &comment.Body, &comment.Version, &comment.CreatedAt, &comment.UpdatedAt, &comment.DeletedAt)
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

const taskSelect = `
	SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
	       t.custom_fields, t.comment_count, t.version, t.created_by, t.created_at, t.updated_at,
	       COALESCE((SELECT jsonb_agg(ta.user_id ORDER BY ta.user_id) FROM task_assignees ta WHERE ta.project_id=t.project_id AND ta.task_id=t.id), '[]'::jsonb),
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

func scanProject(row scanner) (domain.Project, error) {
	var item domain.Project
	var metadata []byte
	err := row.Scan(&item.ID, &item.Name, &item.Description, &metadata, &item.Version, &item.CreatedAt, &item.UpdatedAt)
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
	err := row.Scan(&item.ID, &item.Name, &item.Description, &metadata, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.TaskCount)
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(metadata, &item.Metadata); err != nil {
		return item, err
	}
	return item, nil
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
	err := row.Scan(&item.ID, &item.ProjectID, &item.TaskID, &item.Body, &item.Version, &item.CreatedAt,
		&item.UpdatedAt, &item.DeletedAt, &item.Author.ID, &item.Author.DisplayName, &item.Author.Email, &item.Author.CreatedAt)
	return item, err
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

func replaceTaskAssignees(ctx context.Context, q querier, projectID, taskID string, actorIDs []string) error {
	if _, err := q.Exec(ctx, `DELETE FROM task_assignees WHERE project_id = $1 AND task_id = $2`, projectID, taskID); err != nil {
		return err
	}
	for _, actorID := range actorIDs {
		if _, err := q.Exec(ctx, `INSERT INTO task_assignees(project_id, task_id, user_id) VALUES ($1,$2,$3)`, projectID, taskID, actorID); err != nil {
			return mapConstraintError(err)
		}
	}
	return nil
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

func nullableString(value string) any {
	if value == "" {
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
