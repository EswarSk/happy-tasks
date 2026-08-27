package app

import (
	"context"
	"encoding/json"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/domain"
)

type MutationMeta struct {
	ActorID        string
	RequestID      string
	IdempotencyKey string
	RequestHash    []byte
}

type SavedResponse struct {
	RequestHash []byte
	Status      int
	Body        json.RawMessage
}

type EventDraft struct {
	ProjectID        string
	Type             string
	AggregateType    string
	AggregateID      string
	AggregateVersion *int64
	ActorID          string
	RequestID        string
	Payload          any
}

type TaskCursor struct {
	UpdatedAt time.Time
	ID        string
}

type CommentCursor struct {
	CreatedAt time.Time
	ID        string
}

type TaskFilter struct {
	Status   *domain.Status
	Priority *domain.Priority
	Search   string
	Cursor   *TaskCursor
	PageSize int
}

type CommentFilter struct {
	Cursor   *CommentCursor
	PageSize int
}

type Bootstrap struct {
	Project      domain.Project           `json:"project"`
	Members      []domain.User            `json:"members"`
	Tasks        domain.Page[domain.Task] `json:"tasks"`
	StreamCursor int64                    `json:"streamCursor"`
}

type CreateProjectInput struct {
	ID          string
	Name        string
	Description string
	Metadata    map[string]any
}

type CreateTaskInput struct {
	ID           string
	Title        string
	Description  string
	Status       domain.Status
	Priority     domain.Priority
	CustomFields map[string]any
	AssigneeIDs  []string
	Tags         []string
}

type UpdateTaskInput struct {
	Title        *string
	Description  *string
	Status       *domain.Status
	Priority     *domain.Priority
	CustomFields *map[string]any
	AssigneeIDs  *[]string
	Tags         *[]string
}

type CreateCommentInput struct {
	ID   string
	Body string
}

// Store is transaction scoped. The PostgreSQL implementation is the only
// package that knows SQL; application services own orchestration and policy.
type Store interface {
	LockIdempotency(context.Context, string, string) error
	GetIdempotency(context.Context, string, string) (*SavedResponse, error)
	PutIdempotency(context.Context, string, string, []byte, int, json.RawMessage) error

	ActorExists(context.Context, string) (bool, error)
	IsProjectMember(context.Context, string, string) (bool, error)
	AreProjectMembers(context.Context, string, []string) (bool, error)

	CreateProject(context.Context, CreateProjectInput, string) (domain.Project, error)
	InitProjectStream(context.Context, string) error

	CreateTask(context.Context, string, CreateTaskInput, string) (domain.Task, error)
	GetTask(context.Context, string, string) (domain.Task, error)
	UpdateTask(context.Context, string, string, int64, UpdateTaskInput) (domain.Task, error)
	DeleteTask(context.Context, string, string, int64) (domain.Task, error)

	LockDependencyGraph(context.Context, string) error
	DependencyExists(context.Context, string, string, string) (bool, error)
	DependencyWouldCycle(context.Context, string, string, string) (bool, error)
	AddDependency(context.Context, string, string, string, string) error
	RemoveDependency(context.Context, string, string, string) (bool, error)

	CreateComment(context.Context, string, string, CreateCommentInput, string) (domain.Comment, error)
	AppendEvent(context.Context, EventDraft) (domain.Event, error)
}

type Database interface {
	WithinTx(context.Context, func(Store) error) error
	ListProjects(context.Context, string, int) ([]domain.Project, error)
	GetProject(context.Context, string, string) (domain.Project, error)
	Bootstrap(context.Context, string, string, TaskFilter) (Bootstrap, error)
	ListTasks(context.Context, string, TaskFilter) ([]domain.Task, error)
	GetTask(context.Context, string, string) (domain.Task, error)
	ListComments(context.Context, string, string, CommentFilter) ([]domain.Comment, error)
	ListEvents(context.Context, string, int64, int) ([]domain.Event, error)
	ProjectStreamCursor(context.Context, string) (int64, error)
	Ping(context.Context) error
	Close()
}

type Notifier interface {
	Publish(projectID string)
}
