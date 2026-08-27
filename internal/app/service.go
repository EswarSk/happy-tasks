package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/eswaravegi/happy-task-management/internal/domain"
)

type Service struct {
	db       Database
	notifier Notifier
}

func NewService(db Database, notifier Notifier) *Service {
	return &Service{db: db, notifier: notifier}
}

type Mutation[T any] struct {
	Value        T
	StreamCursor int64
	Replayed     bool
}

type mutationValue[T any] struct {
	value  T
	event  EventDraft
	status int
}

func runMutation[T any](ctx context.Context, service *Service, meta MutationMeta, operation func(Store) (mutationValue[T], error)) (Mutation[T], error) {
	var result Mutation[T]
	if strings.TrimSpace(meta.IdempotencyKey) == "" {
		return result, domain.Validation("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required for mutations.", nil)
	}
	if len(meta.IdempotencyKey) > 200 {
		return result, domain.Validation("VALIDATION_ERROR", "Idempotency-Key must not exceed 200 characters.", map[string]any{"field": "Idempotency-Key"})
	}
	if meta.ActorID == "" || meta.RequestID == "" || len(meta.RequestHash) == 0 {
		return result, fmt.Errorf("incomplete mutation metadata")
	}

	var notifyProject string
	err := service.db.WithinTx(ctx, func(store Store) error {
		if err := store.LockIdempotency(ctx, meta.ActorID, meta.IdempotencyKey); err != nil {
			return err
		}
		saved, err := store.GetIdempotency(ctx, meta.ActorID, meta.IdempotencyKey)
		if err != nil {
			return err
		}
		if saved != nil {
			if !bytes.Equal(saved.RequestHash, meta.RequestHash) {
				return domain.Validation("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request.", nil)
			}
			if err := json.Unmarshal(saved.Body, &result.Value); err != nil {
				return fmt.Errorf("decode idempotent response: %w", err)
			}
			result.Replayed = true
			return nil
		}

		value, err := operation(store)
		if err != nil {
			return err
		}
		event, err := store.AppendEvent(ctx, value.event)
		if err != nil {
			return err
		}
		body, err := json.Marshal(value.value)
		if err != nil {
			return fmt.Errorf("encode idempotent response: %w", err)
		}
		if err := store.PutIdempotency(ctx, meta.ActorID, meta.IdempotencyKey, meta.RequestHash, value.status, body); err != nil {
			return err
		}
		result.Value = value.value
		result.StreamCursor = event.Sequence
		notifyProject = event.ProjectID
		return nil
	})
	if err != nil {
		return result, err
	}
	if notifyProject != "" && service.notifier != nil {
		service.notifier.Publish(notifyProject)
	}
	return result, nil
}

func (s *Service) ListProjects(ctx context.Context, actorID string, pageSize int) (domain.Page[domain.Project], error) {
	pageSize = normalizePageSize(pageSize)
	items, err := s.db.ListProjects(ctx, actorID, pageSize)
	return domain.Page[domain.Project]{Items: items}, err
}

func (s *Service) GetProject(ctx context.Context, actorID, projectID string) (domain.Project, error) {
	return s.db.GetProject(ctx, actorID, projectID)
}

func (s *Service) Bootstrap(ctx context.Context, actorID, projectID string, pageSize int) (Bootstrap, error) {
	pageSize = normalizePageSize(pageSize)
	bootstrap, err := s.db.Bootstrap(ctx, actorID, projectID, TaskFilter{PageSize: pageSize + 1})
	if err != nil {
		return Bootstrap{}, err
	}
	if len(bootstrap.Tasks.Items) > pageSize {
		bootstrap.Tasks.Items = bootstrap.Tasks.Items[:pageSize]
		last := bootstrap.Tasks.Items[len(bootstrap.Tasks.Items)-1]
		bootstrap.Tasks.NextCursor = EncodeTaskCursor(last.UpdatedAt, last.ID)
	}
	return bootstrap, nil
}

func (s *Service) CreateProject(ctx context.Context, meta MutationMeta, input CreateProjectInput) (Mutation[domain.Project], error) {
	if err := domain.ValidateProject(input.Name, input.Description); err != nil {
		return Mutation[domain.Project]{}, err
	}
	if input.Metadata == nil {
		input.Metadata = map[string]any{}
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Project], error) {
		exists, err := store.ActorExists(ctx, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Project]{}, err
		}
		if !exists {
			return mutationValue[domain.Project]{}, domain.ErrForbidden
		}
		project, err := store.CreateProject(ctx, input, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Project]{}, err
		}
		if err := store.InitProjectStream(ctx, project.ID); err != nil {
			return mutationValue[domain.Project]{}, err
		}
		return mutationValue[domain.Project]{
			value:  project,
			status: http.StatusCreated,
			event:  EventDraft{ProjectID: project.ID, Type: "project.created", AggregateType: "project", AggregateID: project.ID, AggregateVersion: &project.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: project},
		}, nil
	})
}

func (s *Service) ListTasks(ctx context.Context, actorID, projectID string, filter TaskFilter) (domain.Page[domain.Task], error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return domain.Page[domain.Task]{}, err
	}
	filter.PageSize = normalizePageSize(filter.PageSize)
	requested := filter.PageSize
	filter.PageSize++
	items, err := s.db.ListTasks(ctx, projectID, filter)
	if err != nil {
		return domain.Page[domain.Task]{}, err
	}
	page := domain.Page[domain.Task]{Items: items}
	if len(items) > requested {
		page.Items = items[:requested]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = EncodeTaskCursor(last.UpdatedAt, last.ID)
	}
	return page, nil
}

func (s *Service) GetTask(ctx context.Context, actorID, projectID, taskID string) (domain.Task, error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return domain.Task{}, err
	}
	return s.db.GetTask(ctx, projectID, taskID)
}

func (s *Service) CreateTask(ctx context.Context, meta MutationMeta, projectID string, input CreateTaskInput) (Mutation[domain.Task], error) {
	if input.Status == "" {
		input.Status = domain.StatusTodo
	}
	if input.Priority == "" {
		input.Priority = domain.PriorityMedium
	}
	if input.CustomFields == nil {
		input.CustomFields = map[string]any{}
	}
	if err := domain.ValidateTask(input.Title, input.Description, input.Status, input.Priority, input.Tags); err != nil {
		return Mutation[domain.Task]{}, err
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Task], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if err := requireMembers(ctx, store, projectID, input.AssigneeIDs); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		task, err := store.CreateTask(ctx, projectID, input, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		return mutationValue[domain.Task]{
			value:  task,
			status: http.StatusCreated,
			event:  EventDraft{ProjectID: projectID, Type: "task.created", AggregateType: "task", AggregateID: task.ID, AggregateVersion: &task.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: task},
		}, nil
	})
}

func (s *Service) UpdateTask(ctx context.Context, meta MutationMeta, projectID, taskID string, expectedVersion int64, input UpdateTaskInput) (Mutation[domain.Task], error) {
	if expectedVersion < 1 {
		return Mutation[domain.Task]{}, domain.Validation("PRECONDITION_REQUIRED", "A valid If-Match version is required.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Task], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		current, err := store.GetTask(ctx, projectID, taskID)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if current.Version != expectedVersion {
			return mutationValue[domain.Task]{}, versionConflict(current)
		}
		next := current
		if input.Title != nil {
			next.Title = *input.Title
		}
		if input.Description != nil {
			next.Description = *input.Description
		}
		if input.Status != nil {
			next.Status = *input.Status
		}
		if input.Priority != nil {
			next.Priority = *input.Priority
		}
		if input.CustomFields != nil {
			next.CustomFields = *input.CustomFields
		}
		if input.AssigneeIDs != nil {
			next.AssigneeIDs = *input.AssigneeIDs
		}
		if input.Tags != nil {
			next.Tags = *input.Tags
		}
		if err := domain.ValidateTask(next.Title, next.Description, next.Status, next.Priority, next.Tags); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if input.Status != nil {
			if err := domain.ValidateTransition(current.Status, next.Status); err != nil {
				return mutationValue[domain.Task]{}, err
			}
		}
		if err := requireMembers(ctx, store, projectID, next.AssigneeIDs); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		updated, err := store.UpdateTask(ctx, projectID, taskID, expectedVersion, input)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		return mutationValue[domain.Task]{
			value:  updated,
			status: http.StatusOK,
			event:  EventDraft{ProjectID: projectID, Type: "task.updated", AggregateType: "task", AggregateID: taskID, AggregateVersion: &updated.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: updated},
		}, nil
	})
}

func (s *Service) DeleteTask(ctx context.Context, meta MutationMeta, projectID, taskID string, expectedVersion int64) (Mutation[map[string]any], error) {
	if expectedVersion < 1 {
		return Mutation[map[string]any]{}, domain.Validation("PRECONDITION_REQUIRED", "A valid If-Match version is required.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[map[string]any], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		deleted, err := store.DeleteTask(ctx, projectID, taskID, expectedVersion)
		if err != nil {
			return mutationValue[map[string]any]{}, err
		}
		body := map[string]any{"id": deleted.ID, "deleted": true, "version": deleted.Version}
		return mutationValue[map[string]any]{
			value:  body,
			status: http.StatusOK,
			event:  EventDraft{ProjectID: projectID, Type: "task.deleted", AggregateType: "task", AggregateID: taskID, AggregateVersion: &deleted.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: body},
		}, nil
	})
}

func (s *Service) AddDependency(ctx context.Context, meta MutationMeta, projectID, taskID, dependencyID string) (Mutation[map[string]any], error) {
	if taskID == dependencyID {
		return Mutation[map[string]any]{}, domain.Validation("SELF_DEPENDENCY", "A task cannot depend on itself.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[map[string]any], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if err := store.LockDependencyGraph(ctx, projectID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if _, err := store.GetTask(ctx, projectID, taskID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if _, err := store.GetTask(ctx, projectID, dependencyID); err != nil {
			return mutationValue[map[string]any]{}, domain.Validation("DEPENDENCY_NOT_IN_PROJECT", "The dependency task does not exist in this project.", nil)
		}
		exists, err := store.DependencyExists(ctx, projectID, taskID, dependencyID)
		if err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if exists {
			return mutationValue[map[string]any]{}, domain.Validation("DUPLICATE_DEPENDENCY", "This dependency already exists.", nil)
		}
		cycles, err := store.DependencyWouldCycle(ctx, projectID, taskID, dependencyID)
		if err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if cycles {
			return mutationValue[map[string]any]{}, domain.Validation("DEPENDENCY_CYCLE", "Adding this dependency would create a cycle.", nil)
		}
		if err := store.AddDependency(ctx, projectID, taskID, dependencyID, meta.ActorID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		body := map[string]any{"taskId": taskID, "dependsOnTaskId": dependencyID}
		return mutationValue[map[string]any]{value: body, status: http.StatusCreated, event: EventDraft{ProjectID: projectID, Type: "dependency.created", AggregateType: "task", AggregateID: taskID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: body}}, nil
	})
}

func (s *Service) RemoveDependency(ctx context.Context, meta MutationMeta, projectID, taskID, dependencyID string) (Mutation[map[string]any], error) {
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[map[string]any], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if err := store.LockDependencyGraph(ctx, projectID); err != nil {
			return mutationValue[map[string]any]{}, err
		}
		removed, err := store.RemoveDependency(ctx, projectID, taskID, dependencyID)
		if err != nil {
			return mutationValue[map[string]any]{}, err
		}
		if !removed {
			return mutationValue[map[string]any]{}, domain.Validation("DEPENDENCY_NOT_FOUND", "The dependency was not found.", nil)
		}
		body := map[string]any{"taskId": taskID, "dependsOnTaskId": dependencyID, "deleted": true}
		return mutationValue[map[string]any]{value: body, status: http.StatusOK, event: EventDraft{ProjectID: projectID, Type: "dependency.deleted", AggregateType: "task", AggregateID: taskID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: body}}, nil
	})
}

func (s *Service) ListComments(ctx context.Context, actorID, projectID, taskID string, filter CommentFilter) (domain.Page[domain.Comment], error) {
	if _, err := s.GetTask(ctx, actorID, projectID, taskID); err != nil {
		return domain.Page[domain.Comment]{}, err
	}
	filter.PageSize = normalizePageSize(filter.PageSize)
	requested := filter.PageSize
	filter.PageSize++
	items, err := s.db.ListComments(ctx, projectID, taskID, filter)
	if err != nil {
		return domain.Page[domain.Comment]{}, err
	}
	page := domain.Page[domain.Comment]{Items: items}
	if len(items) > requested {
		page.Items = items[:requested]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = EncodeCommentCursor(last.CreatedAt, last.ID)
	}
	return page, nil
}

func (s *Service) CreateComment(ctx context.Context, meta MutationMeta, projectID, taskID string, input CreateCommentInput) (Mutation[domain.Comment], error) {
	if err := domain.ValidateComment(input.Body); err != nil {
		return Mutation[domain.Comment]{}, err
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Comment], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Comment]{}, err
		}
		comment, err := store.CreateComment(ctx, projectID, taskID, input, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Comment]{}, err
		}
		return mutationValue[domain.Comment]{value: comment, status: http.StatusCreated, event: EventDraft{ProjectID: projectID, Type: "comment.created", AggregateType: "comment", AggregateID: comment.ID, AggregateVersion: &comment.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: comment}}, nil
	})
}

func (s *Service) ListEvents(ctx context.Context, actorID, projectID string, after int64, limit int) ([]domain.Event, error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	return s.ReplayEvents(ctx, projectID, after, limit)
}

// ReplayEvents is used only after the transport has authorized the long-lived
// project stream once. Avoiding a membership query on every poll keeps each SSE
// connection to one indexed event query per wake-up.
func (s *Service) ReplayEvents(ctx context.Context, projectID string, after int64, limit int) ([]domain.Event, error) {
	if limit < 1 || limit > 500 {
		limit = 200
	}
	return s.db.ListEvents(ctx, projectID, after, limit)
}

func (s *Service) StreamCursor(ctx context.Context, actorID, projectID string) (int64, error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return 0, err
	}
	return s.db.ProjectStreamCursor(ctx, projectID)
}

func (s *Service) Ping(ctx context.Context) error { return s.db.Ping(ctx) }

func requireMember(ctx context.Context, store Store, projectID, actorID string) error {
	ok, err := store.IsProjectMember(ctx, projectID, actorID)
	if err != nil {
		return err
	}
	if !ok {
		return domain.ErrForbidden
	}
	return nil
}

func requireMembers(ctx context.Context, store Store, projectID string, actorIDs []string) error {
	if len(actorIDs) == 0 {
		return nil
	}
	ok, err := store.AreProjectMembers(ctx, projectID, actorIDs)
	if err != nil {
		return err
	}
	if !ok {
		return domain.Validation("ASSIGNEE_NOT_PROJECT_MEMBER", "Every assignee must be a project member.", nil)
	}
	return nil
}

func versionConflict(current domain.Task) error {
	return domain.Validation("VERSION_CONFLICT", "The task changed after this client loaded it.", map[string]any{"current": current, "currentVersion": current.Version})
}

func normalizePageSize(value int) int {
	if value < 1 {
		return 50
	}
	if value > 200 {
		return 200
	}
	return value
}
