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

type MemberCursor struct {
	DisplayName string
	ID          string
}

type AssignmentCursor struct {
	OccurredAt time.Time
	ID         string
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

type MemberFilter struct {
	Search   string
	Status   *domain.MembershipStatus
	Role     *domain.ProjectRole
	Cursor   *MemberCursor
	PageSize int
}

type AssignmentFilter struct {
	Cursor   *AssignmentCursor
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

type CreateMembershipInput struct {
	UserID string
	Role   domain.ProjectRole
	Status domain.MembershipStatus
}

type UpdateMembershipInput struct {
	Role            *domain.ProjectRole
	Status          *domain.MembershipStatus
	ExpectedVersion int64
}

// Store is transaction scoped. The PostgreSQL implementation is the only
// package that knows SQL; application services own orchestration and policy.
type Store interface {
	LockIdempotency(context.Context, string, string) error
	GetIdempotency(context.Context, string, string) (*SavedResponse, error)
	PutIdempotency(context.Context, string, string, []byte, int, json.RawMessage) error

	ActorExists(context.Context, string) (bool, error)
	GetActiveMembership(context.Context, string, string) (domain.Membership, error)
	AreProjectMembers(context.Context, string, []string) (bool, error)
	LockOwnerInvariant(context.Context, string) error
	GetMembership(context.Context, string, string) (domain.Membership, error)
	CountActiveOwners(context.Context, string) (int, error)
	CreateMembership(context.Context, string, CreateMembershipInput, string) (domain.Membership, error)
	UpdateMembership(context.Context, string, string, domain.ProjectRole, domain.MembershipStatus, int64, string) (domain.Membership, error)
	UnassignProjectMember(context.Context, string, string, string, string) ([]domain.AssignmentOperation, error)

	CreateProject(context.Context, CreateProjectInput, string) (domain.Project, error)
	InitProjectStream(context.Context, string) error

	CreateTask(context.Context, string, CreateTaskInput, string) (domain.Task, error)
	GetTask(context.Context, string, string) (domain.Task, error)
	GetTaskForUpdate(context.Context, string, string) (domain.Task, error)
	UpdateTask(context.Context, string, string, int64, UpdateTaskInput) (domain.Task, error)
	DeleteTask(context.Context, string, string, int64) (domain.Task, error)
	ReplaceTaskAssignees(context.Context, string, string, []string, string, string) ([]domain.AssignmentOperation, error)
	ListTaskOperationsAfter(context.Context, string, string, int64) ([]domain.TaskOperation, error)
	GetLatestTaskOperation(context.Context, string, string, string, string) (domain.TaskOperation, error)
	CreateTaskOperation(context.Context, domain.TaskOperation) error
	SetTaskOperationState(context.Context, string, string, int64) error
	InvalidateRedoOperations(context.Context, string, string, string) error
	EnsureTaskDescriptionDocument(context.Context, string, string) error
	InitializeTaskDescriptionDocument(context.Context, string, string, []byte) (bool, error)
	AppendTaskDescriptionUpdate(context.Context, string, string, string, []byte) error
	UpdateTaskDescriptionProjection(context.Context, string, string, string) error

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
	ListMembers(context.Context, string, MemberFilter) ([]domain.Membership, error)
	ListAssignmentOperations(context.Context, string, string, AssignmentFilter) ([]domain.AssignmentOperation, error)
	GetTaskDescriptionDocument(context.Context, string, string) (domain.TaskDescriptionDocument, error)
	ListEvents(context.Context, string, int64, int) ([]domain.Event, error)
	ProjectStreamCursor(context.Context, string) (int64, error)
	Ping(context.Context) error
	Close()
}

type Notifier interface {
	Publish(projectID string)
}
