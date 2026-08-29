package domain

import (
	"encoding/json"
	"time"
)

type Status string

const (
	StatusTodo       Status = "TODO"
	StatusInProgress Status = "IN_PROGRESS"
	StatusBlocked    Status = "BLOCKED"
	StatusDone       Status = "DONE"
)

type Priority string

const (
	PriorityLow    Priority = "LOW"
	PriorityMedium Priority = "MEDIUM"
	PriorityHigh   Priority = "HIGH"
	PriorityUrgent Priority = "URGENT"
)

type UserStatus string

const (
	UserActive    UserStatus = "ACTIVE"
	UserSuspended UserStatus = "SUSPENDED"
	UserDeleted   UserStatus = "DELETED"
)

type MembershipStatus string

const (
	MembershipActive    MembershipStatus = "ACTIVE"
	MembershipInvited   MembershipStatus = "INVITED"
	MembershipSuspended MembershipStatus = "SUSPENDED"
	MembershipRemoved   MembershipStatus = "REMOVED"
)

type ProjectRole string

const (
	RoleOwner  ProjectRole = "OWNER"
	RoleAdmin  ProjectRole = "ADMIN"
	RoleMember ProjectRole = "MEMBER"
	RoleViewer ProjectRole = "VIEWER"
)

type AssignmentOperationType string

const (
	AssignmentAssigned   AssignmentOperationType = "ASSIGNED"
	AssignmentUnassigned AssignmentOperationType = "UNASSIGNED"
)

type User struct {
	ID               string     `json:"id"`
	DisplayName      string     `json:"displayName"`
	Email            string     `json:"email"`
	Status           UserStatus `json:"status,omitempty"`
	AvatarURL        *string    `json:"avatarUrl,omitempty"`
	ProfileUpdatedAt *time.Time `json:"profileUpdatedAt,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        *time.Time `json:"updatedAt,omitempty"`
}

type AuthUser struct {
	User         User
	PasswordHash string
}

type Membership struct {
	ID        string           `json:"id"`
	ProjectID string           `json:"projectId"`
	User      User             `json:"user"`
	Role      ProjectRole      `json:"role"`
	Status    MembershipStatus `json:"status"`
	Version   int64            `json:"version"`
	InvitedBy *string          `json:"invitedBy,omitempty"`
	JoinedAt  *time.Time       `json:"joinedAt,omitempty"`
	RemovedAt *time.Time       `json:"removedAt,omitempty"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
}

type AssignmentOperation struct {
	ID           string                  `json:"id"`
	ProjectID    string                  `json:"projectId"`
	TaskID       string                  `json:"taskId"`
	UserID       string                  `json:"userId"`
	MembershipID string                  `json:"membershipId"`
	Operation    AssignmentOperationType `json:"operation"`
	ActorID      string                  `json:"actorId"`
	RequestID    string                  `json:"requestId"`
	OccurredAt   time.Time               `json:"occurredAt"`
}

type Project struct {
	ID             string         `json:"id"`
	OrganizationID string         `json:"organizationId"`
	Name           string         `json:"name"`
	Description    string         `json:"description"`
	Metadata       map[string]any `json:"metadata"`
	TaskCount      int64          `json:"taskCount"`
	Version        int64          `json:"version"`
	CreatedAt      time.Time      `json:"createdAt"`
	UpdatedAt      time.Time      `json:"updatedAt"`
}

type Attachment struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"projectId"`
	TaskID      string    `json:"taskId"`
	FileName    string    `json:"fileName"`
	ContentType string    `json:"contentType"`
	ByteSize    int64     `json:"byteSize"`
	Checksum    string    `json:"checksum"`
	UploadedBy  string    `json:"uploadedBy"`
	CreatedAt   time.Time `json:"createdAt"`
	StorageKey  string    `json:"-"`
}

type Task struct {
	ID            string         `json:"id"`
	ProjectID     string         `json:"projectId"`
	Title         string         `json:"title"`
	Description   string         `json:"description"`
	Status        Status         `json:"status"`
	Priority      Priority       `json:"priority"`
	CustomFields  map[string]any `json:"customFields"`
	AssigneeIDs   []string       `json:"assigneeIds"`
	Tags          []string       `json:"tags"`
	DependencyIDs []string       `json:"dependencyIds"`
	CommentCount  int64          `json:"commentCount"`
	Version       int64          `json:"version"`
	CreatedBy     string         `json:"createdBy"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}

// TaskOperation records a reversible metadata edit. BeforeState and AfterState
// contain only the fields changed by this operation, which lets the service
// safely merge independent edits made from a stale client version.
type TaskOperation struct {
	ID                string         `json:"id"`
	ProjectID         string         `json:"projectId"`
	TaskID            string         `json:"taskId"`
	ActorID           string         `json:"actorId"`
	RequestID         string         `json:"requestId"`
	OperationType     string         `json:"operationType"`
	ChangedFields     []string       `json:"changedFields"`
	BeforeState       map[string]any `json:"beforeState"`
	AfterState        map[string]any `json:"afterState"`
	BaseVersion       int64          `json:"baseVersion"`
	ResultingVersion  int64          `json:"resultingVersion"`
	LastActionVersion int64          `json:"lastActionVersion"`
	State             string         `json:"state"`
	CreatedAt         time.Time      `json:"createdAt"`
	ActedAt           *time.Time     `json:"actedAt,omitempty"`
}

type TaskDescriptionDocument struct {
	ProjectID   string
	TaskID      string
	Initialized bool
	Snapshot    []byte
	Updates     [][]byte
}

type Comment struct {
	ID        string            `json:"id"`
	ProjectID string            `json:"projectId"`
	TaskID    string            `json:"taskId"`
	ParentID  *string           `json:"parentId,omitempty"`
	Author    User              `json:"author"`
	Body      string            `json:"body"`
	Version   int64             `json:"version"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt *time.Time        `json:"updatedAt,omitempty"`
	DeletedAt *time.Time        `json:"deletedAt,omitempty"`
	Reactions []CommentReaction `json:"reactions,omitempty"`
}

type CommentReaction struct {
	ProjectID    string `json:"projectId"`
	TaskID       string `json:"taskId"`
	CommentID    string `json:"commentId"`
	ReactionType string `json:"type"`
	Count        int64  `json:"count"`
	Reacted      bool   `json:"reacted"`
}

type ActivityItem struct {
	ID            string    `json:"id"`
	ProjectID     string    `json:"projectId"`
	Sequence      int64     `json:"sequence"`
	EventType     string    `json:"eventType"`
	AggregateType string    `json:"aggregateType"`
	AggregateID   string    `json:"aggregateId"`
	ActorID       string    `json:"actorId,omitempty"`
	Description   string    `json:"description"`
	OccurredAt    time.Time `json:"occurredAt"`
}

type Notification struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"projectId"`
	UserID    string     `json:"userId"`
	TaskID    string     `json:"taskId"`
	CommentID string     `json:"commentId"`
	ActorID   string     `json:"actorId"`
	Type      string     `json:"type"`
	Body      string     `json:"body"`
	ReadAt    *time.Time `json:"readAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

type Event struct {
	ProjectID        string          `json:"projectId"`
	Sequence         int64           `json:"sequence"`
	Type             string          `json:"type"`
	AggregateType    string          `json:"aggregateType"`
	AggregateID      string          `json:"aggregateId"`
	AggregateVersion *int64          `json:"aggregateVersion,omitempty"`
	ActorID          string          `json:"actorId,omitempty"`
	RequestID        string          `json:"requestId"`
	Payload          json.RawMessage `json:"payload"`
	OccurredAt       time.Time       `json:"occurredAt"`
}

type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
}
