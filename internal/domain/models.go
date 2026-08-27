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

type User struct {
	ID          string    `json:"id"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Project struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Metadata    map[string]any `json:"metadata"`
	TaskCount   int64          `json:"taskCount"`
	Version     int64          `json:"version"`
	CreatedAt   time.Time      `json:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
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

type Comment struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"projectId"`
	TaskID    string     `json:"taskId"`
	Author    User       `json:"author"`
	Body      string     `json:"body"`
	Version   int64      `json:"version"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
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
