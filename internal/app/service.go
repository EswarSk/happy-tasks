package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type Service struct {
	db       Database
	notifier Notifier
}

func NewService(db Database, notifier Notifier) *Service {
	return &Service{db: db, notifier: notifier}
}

const sessionLifetime = 30 * 24 * time.Hour

func (s *Service) Register(ctx context.Context, displayName, email, password string) (domain.User, string, error) {
	displayName = strings.TrimSpace(displayName)
	email, err := normalizeEmail(email)
	if err != nil || displayName == "" || len(displayName) > 120 || len(password) < 8 || len(password) > 128 {
		return domain.User{}, "", domain.Validation("VALIDATION_ERROR", "Use a valid name, email, and password of 8 to 128 characters.", nil)
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return domain.User{}, "", fmt.Errorf("hash password: %w", err)
	}
	user, err := s.db.CreateUser(ctx, displayName, email, string(passwordHash))
	if err != nil {
		return domain.User{}, "", err
	}
	token, err := newSessionToken()
	if err != nil {
		return domain.User{}, "", err
	}
	if err := s.db.CreateAuthSession(ctx, user.ID, hashSessionToken(token), time.Now().Add(sessionLifetime)); err != nil {
		return domain.User{}, "", err
	}
	return user, token, nil
}

func (s *Service) Login(ctx context.Context, email, password string) (domain.User, string, error) {
	email, err := normalizeEmail(email)
	if err != nil {
		return domain.User{}, "", invalidCredentials()
	}
	authUser, err := s.db.GetAuthUser(ctx, email)
	if err != nil || authUser.User.Status != domain.UserActive || authUser.PasswordHash == "" || bcrypt.CompareHashAndPassword([]byte(authUser.PasswordHash), []byte(password)) != nil {
		return domain.User{}, "", invalidCredentials()
	}
	token, err := newSessionToken()
	if err != nil {
		return domain.User{}, "", err
	}
	if err := s.db.CreateAuthSession(ctx, authUser.User.ID, hashSessionToken(token), time.Now().Add(sessionLifetime)); err != nil {
		return domain.User{}, "", err
	}
	return authUser.User, token, nil
}

func (s *Service) SessionUser(ctx context.Context, token string) (domain.User, error) {
	if token == "" {
		return domain.User{}, domain.Validation("UNAUTHENTICATED", "Sign in is required.", nil)
	}
	user, err := s.db.GetAuthSessionUser(ctx, hashSessionToken(token))
	if err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.db.DeleteAuthSession(ctx, hashSessionToken(token))
}

func normalizeEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 320 {
		return "", fmt.Errorf("invalid email")
	}
	return email, nil
}

func newSessionToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func hashSessionToken(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return digest[:]
}

func invalidCredentials() error {
	return domain.Validation("INVALID_CREDENTIALS", "The email or password is incorrect.", nil)
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
		var event domain.Event
		if value.event.ProjectID != "" {
			event, err = store.AppendEvent(ctx, value.event)
			if err != nil {
				return err
			}
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
		organizationID, err := store.GetActiveOrganizationID(ctx, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Project]{}, err
		}
		project, err := store.CreateProject(ctx, input, meta.ActorID, organizationID)
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

func (s *Service) CanMutateProject(ctx context.Context, actorID, projectID string) (bool, error) {
	allowed := false
	err := s.db.WithinTx(ctx, func(store Store) error {
		membership, err := store.GetActiveMembership(ctx, projectID, actorID)
		if err != nil {
			return err
		}
		allowed = domain.CanMutateProject(membership.Role)
		return nil
	})
	return allowed, err
}

func (s *Service) ListAttachments(ctx context.Context, actorID, projectID, taskID string) ([]domain.Attachment, error) {
	if _, err := s.GetTask(ctx, actorID, projectID, taskID); err != nil {
		return nil, err
	}
	return s.db.ListAttachments(ctx, projectID, taskID)
}

func (s *Service) GetAttachment(ctx context.Context, actorID, projectID, taskID, attachmentID string) (domain.Attachment, error) {
	if _, err := s.GetTask(ctx, actorID, projectID, taskID); err != nil {
		return domain.Attachment{}, err
	}
	return s.db.GetAttachment(ctx, projectID, taskID, attachmentID)
}

func (s *Service) AuthorizeAttachmentUpload(ctx context.Context, actorID, projectID, taskID string) error {
	return s.db.WithinTx(ctx, func(store Store) error {
		if err := requireMember(ctx, store, projectID, actorID); err != nil {
			return err
		}
		_, err := store.GetTask(ctx, projectID, taskID)
		return err
	})
}

func (s *Service) ScheduleAttachmentObjectCleanup(ctx context.Context, storageKey string, deleteAfter time.Time) error {
	return s.db.ScheduleAttachmentObjectCleanup(ctx, storageKey, deleteAfter)
}

func (s *Service) CreateAttachment(ctx context.Context, meta MutationMeta, input CreateAttachmentInput) (Mutation[domain.Attachment], error) {
	if input.ByteSize < 1 || input.ByteSize > 25<<20 || len(input.FileName) == 0 || len(input.FileName) > 255 || len(input.ContentType) == 0 || len(input.Checksum) != 64 || len(input.StorageKey) == 0 {
		return Mutation[domain.Attachment]{}, domain.Validation("VALIDATION_ERROR", "The attachment metadata is invalid.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Attachment], error) {
		if err := requireMember(ctx, store, input.ProjectID, meta.ActorID); err != nil {
			return mutationValue[domain.Attachment]{}, err
		}
		if _, err := store.GetTask(ctx, input.ProjectID, input.TaskID); err != nil {
			return mutationValue[domain.Attachment]{}, err
		}
		input.UploadedBy = meta.ActorID
		attachment, err := store.CreateAttachment(ctx, input)
		if err != nil {
			return mutationValue[domain.Attachment]{}, err
		}
		return mutationValue[domain.Attachment]{
			value:  attachment,
			status: http.StatusCreated,
			event:  EventDraft{ProjectID: input.ProjectID, Type: "attachment.created", AggregateType: "task", AggregateID: input.TaskID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: attachment},
		}, nil
	})
}

func (s *Service) DeleteAttachment(ctx context.Context, meta MutationMeta, projectID, taskID, attachmentID string) (Mutation[domain.Attachment], error) {
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Attachment], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Attachment]{}, err
		}
		attachment, err := store.DeleteAttachment(ctx, projectID, taskID, attachmentID)
		if err != nil {
			return mutationValue[domain.Attachment]{}, err
		}
		return mutationValue[domain.Attachment]{
			value:  attachment,
			status: http.StatusOK,
			event:  EventDraft{ProjectID: projectID, Type: "attachment.deleted", AggregateType: "task", AggregateID: taskID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: map[string]any{"id": attachment.ID, "taskId": taskID, "deleted": true}},
		}, nil
	})
}

func (s *Service) GetTaskDescriptionDocument(ctx context.Context, actorID, projectID, taskID string) (domain.TaskDescriptionDocument, error) {
	if _, err := s.GetTask(ctx, actorID, projectID, taskID); err != nil {
		return domain.TaskDescriptionDocument{}, err
	}
	document, err := s.db.GetTaskDescriptionDocument(ctx, projectID, taskID)
	if err != nil {
		return domain.TaskDescriptionDocument{}, err
	}
	if document.ProjectID == "" {
		if err := s.db.WithinTx(ctx, func(store Store) error {
			return store.EnsureTaskDescriptionDocument(ctx, projectID, taskID)
		}); err != nil {
			return domain.TaskDescriptionDocument{}, err
		}
		document.ProjectID, document.TaskID = projectID, taskID
	}
	return document, nil
}

// PersistTaskDescriptionUpdate stores one opaque Yjs update and a searchable
// plain-text projection. The projection deliberately does not increment the
// task metadata version: description edits are merged by the CRDT channel,
// while status, priority, assignment and tags retain field-level undo/redo.
func (s *Service) PersistTaskDescriptionUpdate(ctx context.Context, meta MutationMeta, projectID, taskID, text string, update []byte, initialize bool) (Mutation[domain.Task], error) {
	if len(update) == 0 || len(update) > 2<<20 {
		return Mutation[domain.Task]{}, domain.Validation("DESCRIPTION_UPDATE_TOO_LARGE", "The collaborative description update must be between 1 byte and 2 MB.", nil)
	}
	if len(text) > 48<<10 {
		return Mutation[domain.Task]{}, domain.Validation("DESCRIPTION_TOO_LARGE", "The task description must not exceed 48 KB.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Task], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if _, err := store.GetTask(ctx, projectID, taskID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if err := store.EnsureTaskDescriptionDocument(ctx, projectID, taskID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if initialize {
			initialized, err := store.InitializeTaskDescriptionDocument(ctx, projectID, taskID, update)
			if err != nil {
				return mutationValue[domain.Task]{}, err
			}
			if !initialized {
				return mutationValue[domain.Task]{}, domain.Validation("DESCRIPTION_ALREADY_INITIALIZED", "Another collaborator initialized this description. Reconnect to the shared snapshot.", nil)
			}
		} else if err := store.AppendTaskDescriptionUpdate(ctx, projectID, taskID, meta.ActorID, update); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if err := store.UpdateTaskDescriptionProjection(ctx, projectID, taskID, text); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		task, err := store.GetTask(ctx, projectID, taskID)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		return mutationValue[domain.Task]{value: task, status: http.StatusOK}, nil
	})
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
		if _, err := store.ReplaceTaskAssignees(ctx, projectID, task.ID, input.AssigneeIDs, meta.ActorID, meta.RequestID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		task, err = store.GetTask(ctx, projectID, task.ID)
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
		current, err := store.GetTaskForUpdate(ctx, projectID, taskID)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		fields := changedTaskFields(input)
		if len(fields) == 0 {
			return mutationValue[domain.Task]{}, domain.Validation("VALIDATION_ERROR", "At least one task field is required.", nil)
		}
		if expectedVersion > current.Version {
			return mutationValue[domain.Task]{}, versionConflict(current)
		}
		if expectedVersion < current.Version {
			operations, listErr := store.ListTaskOperationsAfter(ctx, projectID, taskID, expectedVersion)
			if listErr != nil {
				return mutationValue[domain.Task]{}, listErr
			}
			for _, operation := range operations {
				if fieldsOverlap(fields, operation.ChangedFields) {
					return mutationValue[domain.Task]{}, versionConflict(current)
				}
			}
		}
		next := current
		applyTaskInput(&next, input)
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
		updated, err := applyTaskUpdate(ctx, store, projectID, taskID, current.Version, input, meta)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if err := store.InvalidateRedoOperations(ctx, projectID, taskID, meta.ActorID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		operation := newTaskOperation(projectID, taskID, meta, expectedVersion, current, updated, fields)
		if err := store.CreateTaskOperation(ctx, operation); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		return mutationValue[domain.Task]{
			value:  updated,
			status: http.StatusOK,
			event:  EventDraft{ProjectID: projectID, Type: "task.updated", AggregateType: "task", AggregateID: taskID, AggregateVersion: &updated.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: map[string]any{"task": updated, "operationId": operation.ID, "changedFields": fields}},
		}, nil
	})
}

// UndoTask and RedoTask are intentionally server-authoritative. They only
// reverse the caller's latest operation when no collaborator has changed one
// of those same fields since it was recorded; unrelated fields are preserved.
func (s *Service) UndoTask(ctx context.Context, meta MutationMeta, projectID, taskID string) (Mutation[domain.Task], error) {
	return s.replayTaskOperation(ctx, meta, projectID, taskID, "ACTIVE", "UNDONE", "undo")
}

func (s *Service) RedoTask(ctx context.Context, meta MutationMeta, projectID, taskID string) (Mutation[domain.Task], error) {
	return s.replayTaskOperation(ctx, meta, projectID, taskID, "UNDONE", "ACTIVE", "redo")
}

func (s *Service) replayTaskOperation(ctx context.Context, meta MutationMeta, projectID, taskID, fromState, toState, action string) (Mutation[domain.Task], error) {
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Task], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		current, err := store.GetTaskForUpdate(ctx, projectID, taskID)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		operation, err := store.GetLatestTaskOperation(ctx, projectID, taskID, meta.ActorID, fromState)
		if err != nil {
			if err == domain.ErrNotFound {
				code := "UNDO_NOT_AVAILABLE"
				message := "There is no task edit available to undo."
				if action == "redo" {
					code, message = "REDO_NOT_AVAILABLE", "There is no task edit available to redo."
				}
				return mutationValue[domain.Task]{}, domain.Validation(code, message, nil)
			}
			return mutationValue[domain.Task]{}, err
		}
		expected := operation.AfterState
		if action == "redo" {
			expected = operation.BeforeState
		}
		if !taskStateMatches(current, expected, operation.ChangedFields) {
			return mutationValue[domain.Task]{}, domain.Validation("OPERATION_CONFLICT", "This edit cannot be replayed because another collaborator changed one of the same fields.", map[string]any{"current": current, "operationId": operation.ID})
		}
		target := operation.BeforeState
		if action == "redo" {
			target = operation.AfterState
		}
		input, err := taskInputFromState(target, operation.ChangedFields)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		updated, err := applyTaskUpdate(ctx, store, projectID, taskID, current.Version, input, meta)
		if err != nil {
			return mutationValue[domain.Task]{}, err
		}
		if err := store.SetTaskOperationState(ctx, operation.ID, toState, updated.Version); err != nil {
			return mutationValue[domain.Task]{}, err
		}
		return mutationValue[domain.Task]{
			value:  updated,
			status: http.StatusOK,
			event:  EventDraft{ProjectID: projectID, Type: "task.updated", AggregateType: "task", AggregateID: taskID, AggregateVersion: &updated.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: map[string]any{"task": updated, "operationId": operation.ID, "changedFields": operation.ChangedFields, "action": action}},
		}, nil
	})
}

func applyTaskUpdate(ctx context.Context, store Store, projectID, taskID string, expectedVersion int64, input UpdateTaskInput, meta MutationMeta) (domain.Task, error) {
	updated, err := store.UpdateTask(ctx, projectID, taskID, expectedVersion, input)
	if err != nil {
		return domain.Task{}, err
	}
	if input.AssigneeIDs != nil {
		if _, err := store.ReplaceTaskAssignees(ctx, projectID, taskID, *input.AssigneeIDs, meta.ActorID, meta.RequestID); err != nil {
			return domain.Task{}, err
		}
		updated, err = store.GetTask(ctx, projectID, taskID)
	}
	return updated, err
}

func changedTaskFields(input UpdateTaskInput) []string {
	fields := make([]string, 0, 7)
	if input.Title != nil {
		fields = append(fields, "title")
	}
	if input.Description != nil {
		fields = append(fields, "description")
	}
	if input.Status != nil {
		fields = append(fields, "status")
	}
	if input.Priority != nil {
		fields = append(fields, "priority")
	}
	if input.CustomFields != nil {
		fields = append(fields, "customFields")
	}
	if input.AssigneeIDs != nil {
		fields = append(fields, "assigneeIds")
	}
	if input.Tags != nil {
		fields = append(fields, "tags")
	}
	return fields
}

func fieldsOverlap(left, right []string) bool {
	seen := make(map[string]struct{}, len(left))
	for _, field := range left {
		seen[field] = struct{}{}
	}
	for _, field := range right {
		if _, ok := seen[field]; ok {
			return true
		}
	}
	return false
}

func applyTaskInput(task *domain.Task, input UpdateTaskInput) {
	if input.Title != nil {
		task.Title = *input.Title
	}
	if input.Description != nil {
		task.Description = *input.Description
	}
	if input.Status != nil {
		task.Status = *input.Status
	}
	if input.Priority != nil {
		task.Priority = *input.Priority
	}
	if input.CustomFields != nil {
		task.CustomFields = *input.CustomFields
	}
	if input.AssigneeIDs != nil {
		task.AssigneeIDs = append([]string(nil), (*input.AssigneeIDs)...)
		sort.Strings(task.AssigneeIDs)
	}
	if input.Tags != nil {
		task.Tags = append([]string(nil), (*input.Tags)...)
		sort.Strings(task.Tags)
	}
}

func taskState(task domain.Task, fields []string) map[string]any {
	state := make(map[string]any, len(fields))
	for _, field := range fields {
		switch field {
		case "title":
			state[field] = task.Title
		case "description":
			state[field] = task.Description
		case "status":
			state[field] = string(task.Status)
		case "priority":
			state[field] = string(task.Priority)
		case "customFields":
			state[field] = task.CustomFields
		case "assigneeIds":
			values := append([]string(nil), task.AssigneeIDs...)
			sort.Strings(values)
			state[field] = values
		case "tags":
			values := append([]string(nil), task.Tags...)
			sort.Strings(values)
			state[field] = values
		}
	}
	return state
}

func newTaskOperation(projectID, taskID string, meta MutationMeta, baseVersion int64, before, after domain.Task, fields []string) domain.TaskOperation {
	return domain.TaskOperation{ID: uuid.Must(uuid.NewV7()).String(), ProjectID: projectID, TaskID: taskID, ActorID: meta.ActorID, RequestID: meta.RequestID, OperationType: "UPDATE", ChangedFields: fields, BeforeState: taskState(before, fields), AfterState: taskState(after, fields), BaseVersion: baseVersion, ResultingVersion: after.Version, LastActionVersion: after.Version, State: "ACTIVE"}
}

func taskStateMatches(task domain.Task, expected map[string]any, fields []string) bool {
	actual := taskState(task, fields)
	for _, field := range fields {
		left, _ := json.Marshal(actual[field])
		right, _ := json.Marshal(expected[field])
		if !bytes.Equal(left, right) {
			return false
		}
	}
	return true
}

func taskInputFromState(state map[string]any, fields []string) (UpdateTaskInput, error) {
	var input UpdateTaskInput
	for _, field := range fields {
		raw, err := json.Marshal(state[field])
		if err != nil {
			return input, err
		}
		switch field {
		case "title":
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.Title = &value
		case "description":
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.Description = &value
		case "status":
			var value domain.Status
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.Status = &value
		case "priority":
			var value domain.Priority
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.Priority = &value
		case "customFields":
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.CustomFields = &value
		case "assigneeIds":
			var value []string
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.AssigneeIDs = &value
		case "tags":
			var value []string
			if err := json.Unmarshal(raw, &value); err != nil {
				return input, err
			}
			input.Tags = &value
		}
	}
	return input, nil
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
	items, err := s.db.ListComments(ctx, projectID, taskID, actorID, filter)
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

func (s *Service) SetCommentReaction(ctx context.Context, meta MutationMeta, projectID, taskID, commentID, reactionType string) (Mutation[domain.CommentReaction], error) {
	if !domain.ValidCommentReactionType(reactionType) {
		return Mutation[domain.CommentReaction]{}, domain.Validation("INVALID_REACTION_TYPE", "Unknown comment reaction type.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.CommentReaction], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.CommentReaction]{}, err
		}
		exists, err := store.CommentExists(ctx, projectID, taskID, commentID)
		if err != nil {
			return mutationValue[domain.CommentReaction]{}, err
		}
		if !exists {
			return mutationValue[domain.CommentReaction]{}, domain.ErrNotFound
		}
		reaction, err := store.SetCommentReaction(ctx, projectID, taskID, commentID, reactionType, meta.ActorID)
		if err != nil {
			return mutationValue[domain.CommentReaction]{}, err
		}
		return mutationValue[domain.CommentReaction]{value: reaction, status: http.StatusOK, event: EventDraft{ProjectID: projectID, Type: "comment.reaction.changed", AggregateType: "comment", AggregateID: commentID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: reaction}}, nil
	})
}

func (s *Service) RemoveCommentReaction(ctx context.Context, meta MutationMeta, projectID, taskID, commentID string) (Mutation[domain.CommentReaction], error) {
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.CommentReaction], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.CommentReaction]{}, err
		}
		exists, err := store.CommentExists(ctx, projectID, taskID, commentID)
		if err != nil {
			return mutationValue[domain.CommentReaction]{}, err
		}
		if !exists {
			return mutationValue[domain.CommentReaction]{}, domain.ErrNotFound
		}
		reaction, err := store.RemoveCommentReaction(ctx, projectID, taskID, commentID, meta.ActorID)
		if err != nil {
			return mutationValue[domain.CommentReaction]{}, err
		}
		return mutationValue[domain.CommentReaction]{value: reaction, status: http.StatusOK, event: EventDraft{ProjectID: projectID, Type: "comment.reaction.changed", AggregateType: "comment", AggregateID: commentID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: reaction}}, nil
	})
}

func (s *Service) CreateComment(ctx context.Context, meta MutationMeta, projectID, taskID string, input CreateCommentInput) (Mutation[domain.Comment], error) {
	if err := domain.ValidateComment(input.Body); err != nil {
		return Mutation[domain.Comment]{}, err
	}
	if input.ParentID != nil && *input.ParentID == input.ID {
		return Mutation[domain.Comment]{}, domain.Validation("COMMENT_PARENT_INVALID", "A comment cannot reply to itself.", map[string]any{"field": "parentId"})
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Comment], error) {
		if err := requireMember(ctx, store, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Comment]{}, err
		}
		if input.ParentID != nil {
			exists, err := store.CommentParentExists(ctx, projectID, taskID, *input.ParentID)
			if err != nil {
				return mutationValue[domain.Comment]{}, err
			}
			if !exists {
				return mutationValue[domain.Comment]{}, domain.Validation("COMMENT_PARENT_NOT_FOUND", "The parent comment does not exist on this task.", map[string]any{"field": "parentId"})
			}
		}
		comment, err := store.CreateComment(ctx, projectID, taskID, input, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Comment]{}, err
		}
		notifications, err := store.CreateMentionNotifications(ctx, projectID, taskID, comment.ID, meta.ActorID, comment.Body)
		if err != nil {
			return mutationValue[domain.Comment]{}, err
		}
		payload := map[string]any{"comment": comment}
		if len(notifications) > 0 {
			payload["notifications"] = notifications
		}
		return mutationValue[domain.Comment]{value: comment, status: http.StatusCreated, event: EventDraft{ProjectID: projectID, Type: "comment.created", AggregateType: "comment", AggregateID: comment.ID, AggregateVersion: &comment.Version, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: payload}}, nil
	})
}

func (s *Service) ListNotifications(ctx context.Context, actorID, projectID string, unreadOnly bool, cursor *NotificationCursor, pageSize int) (domain.Page[domain.Notification], error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return domain.Page[domain.Notification]{}, err
	}
	pageSize = normalizePageSize(pageSize)
	requested := pageSize
	pageSize++
	var position NotificationCursor
	if cursor != nil {
		position = *cursor
	}
	items, err := s.db.ListNotifications(ctx, actorID, projectID, unreadOnly, position, pageSize)
	if err != nil {
		return domain.Page[domain.Notification]{}, err
	}
	page := domain.Page[domain.Notification]{Items: items}
	if len(items) > requested {
		page.Items = items[:requested]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = EncodeNotificationCursor(last.CreatedAt, last.ID)
	}
	return page, nil
}

func (s *Service) MarkNotificationRead(ctx context.Context, meta MutationMeta, projectID, notificationID string) (Mutation[domain.Notification], error) {
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Notification], error) {
		if _, err := store.GetActiveMembership(ctx, projectID, meta.ActorID); err != nil {
			return mutationValue[domain.Notification]{}, err
		}
		notification, err := store.MarkNotificationRead(ctx, projectID, meta.ActorID, notificationID)
		if err != nil {
			return mutationValue[domain.Notification]{}, err
		}
		return mutationValue[domain.Notification]{value: notification, status: http.StatusOK, event: EventDraft{ProjectID: projectID, Type: "notification.read", AggregateType: "notification", AggregateID: notification.ID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: notification}}, nil
	})
}

func (s *Service) ListMembers(ctx context.Context, actorID, projectID string, filter MemberFilter) (domain.Page[domain.Membership], error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return domain.Page[domain.Membership]{}, err
	}
	filter.Search = strings.TrimSpace(filter.Search)
	if len(filter.Search) > 200 {
		return domain.Page[domain.Membership]{}, domain.Validation("VALIDATION_ERROR", "Member search must not exceed 200 characters.", map[string]any{"field": "q"})
	}
	filter.PageSize = normalizePageSize(filter.PageSize)
	requested := filter.PageSize
	filter.PageSize++
	items, err := s.db.ListMembers(ctx, projectID, filter)
	if err != nil {
		return domain.Page[domain.Membership]{}, err
	}
	page := domain.Page[domain.Membership]{Items: items}
	if len(items) > requested {
		page.Items = items[:requested]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = EncodeMemberCursor(strings.ToLower(last.User.DisplayName), last.ID)
	}
	return page, nil
}

func (s *Service) CreateMembership(ctx context.Context, meta MutationMeta, projectID string, input CreateMembershipInput) (Mutation[domain.Membership], error) {
	if input.Status == "" {
		input.Status = domain.MembershipInvited
	}
	if input.Status != domain.MembershipInvited && input.Status != domain.MembershipActive {
		return Mutation[domain.Membership]{}, domain.Validation("INVALID_MEMBERSHIP_STATUS", "A membership must be created as INVITED or ACTIVE.", nil)
	}
	if err := domain.ValidateMembership(input.Role, input.Status); err != nil {
		return Mutation[domain.Membership]{}, err
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Membership], error) {
		actor, err := requireMembershipManager(ctx, store, projectID, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		if !domain.CanManageMembership(actor.Role, domain.RoleMember, input.Role) {
			return mutationValue[domain.Membership]{}, insufficientRole("Only an owner can grant the OWNER role.")
		}
		if input.Role == domain.RoleOwner {
			if err := store.LockOwnerInvariant(ctx, projectID); err != nil {
				return mutationValue[domain.Membership]{}, err
			}
		}
		exists, err := store.ActorExists(ctx, input.UserID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		if !exists {
			return mutationValue[domain.Membership]{}, domain.Validation("USER_NOT_ACTIVE", "The user does not exist or is not active.", nil)
		}
		inOrganization, err := store.IsUserInProjectOrganization(ctx, projectID, input.UserID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		if !inOrganization {
			return mutationValue[domain.Membership]{}, domain.Validation("USER_NOT_IN_ORGANIZATION", "The user must belong to the project's organization before they can be added.", nil)
		}
		membership, err := store.CreateMembership(ctx, projectID, input, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		return mutationValue[domain.Membership]{
			value:  membership,
			status: http.StatusCreated,
			event:  EventDraft{ProjectID: projectID, Type: "membership.created", AggregateType: "membership", AggregateID: membership.ID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: membership},
		}, nil
	})
}

func (s *Service) UpdateMembership(ctx context.Context, meta MutationMeta, projectID, membershipID string, input UpdateMembershipInput) (Mutation[domain.Membership], error) {
	if input.ExpectedVersion < 1 {
		return Mutation[domain.Membership]{}, domain.Validation("PRECONDITION_REQUIRED", "A valid If-Match version is required.", nil)
	}
	if input.Role == nil && input.Status == nil {
		return Mutation[domain.Membership]{}, domain.Validation("VALIDATION_ERROR", "At least one of role or status is required.", nil)
	}
	return runMutation(ctx, s, meta, func(store Store) (mutationValue[domain.Membership], error) {
		actor, err := requireMembershipManager(ctx, store, projectID, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		current, err := store.GetMembership(ctx, projectID, membershipID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		nextRole, nextStatus := current.Role, current.Status
		if input.Role != nil {
			nextRole = *input.Role
		}
		if input.Status != nil {
			nextStatus = *input.Status
		}
		if err := domain.ValidateMembership(nextRole, nextStatus); err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		if !domain.CanTransitionMembership(current.Status, nextStatus) {
			return mutationValue[domain.Membership]{}, domain.Validation("INVALID_MEMBERSHIP_TRANSITION", "The requested membership lifecycle transition is not allowed.", map[string]any{"from": current.Status, "to": nextStatus})
		}
		if !domain.CanManageMembership(actor.Role, current.Role, nextRole) {
			return mutationValue[domain.Membership]{}, insufficientRole("This role cannot manage an owner or grant the OWNER role.")
		}
		if current.Role == domain.RoleOwner || nextRole == domain.RoleOwner {
			if err := store.LockOwnerInvariant(ctx, projectID); err != nil {
				return mutationValue[domain.Membership]{}, err
			}
		}
		if current.Role == domain.RoleOwner && current.Status == domain.MembershipActive && (nextRole != domain.RoleOwner || nextStatus != domain.MembershipActive) {
			owners, err := store.CountActiveOwners(ctx, projectID)
			if err != nil {
				return mutationValue[domain.Membership]{}, err
			}
			if owners <= 1 {
				return mutationValue[domain.Membership]{}, domain.Validation("FINAL_ACTIVE_OWNER", "The final active owner cannot be demoted, suspended, or removed.", nil)
			}
		}
		membership, err := store.UpdateMembership(ctx, projectID, membershipID, nextRole, nextStatus, input.ExpectedVersion, meta.ActorID)
		if err != nil {
			return mutationValue[domain.Membership]{}, err
		}
		if current.Status == domain.MembershipActive && nextStatus != domain.MembershipActive {
			if _, err := store.UnassignProjectMember(ctx, projectID, current.User.ID, meta.ActorID, meta.RequestID); err != nil {
				return mutationValue[domain.Membership]{}, err
			}
		}
		return mutationValue[domain.Membership]{
			value:  membership,
			status: http.StatusOK,
			event:  EventDraft{ProjectID: projectID, Type: "membership.updated", AggregateType: "membership", AggregateID: membership.ID, ActorID: meta.ActorID, RequestID: meta.RequestID, Payload: membership},
		}, nil
	})
}

func (s *Service) RemoveMembership(ctx context.Context, meta MutationMeta, projectID, membershipID string, expectedVersion int64) (Mutation[domain.Membership], error) {
	status := domain.MembershipRemoved
	return s.UpdateMembership(ctx, meta, projectID, membershipID, UpdateMembershipInput{Status: &status, ExpectedVersion: expectedVersion})
}

func (s *Service) ListAssignmentHistory(ctx context.Context, actorID, projectID, taskID string, filter AssignmentFilter) (domain.Page[domain.AssignmentOperation], error) {
	if _, err := s.GetTask(ctx, actorID, projectID, taskID); err != nil {
		return domain.Page[domain.AssignmentOperation]{}, err
	}
	filter.PageSize = normalizePageSize(filter.PageSize)
	requested := filter.PageSize
	filter.PageSize++
	items, err := s.db.ListAssignmentOperations(ctx, projectID, taskID, filter)
	if err != nil {
		return domain.Page[domain.AssignmentOperation]{}, err
	}
	page := domain.Page[domain.AssignmentOperation]{Items: items}
	if len(items) > requested {
		page.Items = items[:requested]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = EncodeAssignmentCursor(last.OccurredAt, last.ID)
	}
	return page, nil
}

func (s *Service) ListEvents(ctx context.Context, actorID, projectID string, after int64, limit int) ([]domain.Event, error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return nil, err
	}
	return s.ReplayEvents(ctx, projectID, after, limit)
}

func (s *Service) ListActivity(ctx context.Context, actorID, projectID string, after int64, limit int) (domain.Page[domain.ActivityItem], error) {
	if _, err := s.db.GetProject(ctx, actorID, projectID); err != nil {
		return domain.Page[domain.ActivityItem]{}, err
	}
	limit = normalizePageSize(limit)
	events, err := s.db.ListEvents(ctx, projectID, after, limit+1)
	if err != nil {
		return domain.Page[domain.ActivityItem]{}, err
	}
	page := domain.Page[domain.ActivityItem]{Items: make([]domain.ActivityItem, 0, len(events))}
	for _, event := range events {
		page.Items = append(page.Items, domain.ActivityItem{
			ID: fmt.Sprintf("%s:%d", event.ProjectID, event.Sequence), ProjectID: event.ProjectID, Sequence: event.Sequence,
			EventType: event.Type, AggregateType: event.AggregateType, AggregateID: event.AggregateID, ActorID: event.ActorID,
			Description: activityDescription(event.Type), OccurredAt: event.OccurredAt,
		})
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		page.NextCursor = strconv.FormatInt(page.Items[len(page.Items)-1].Sequence, 10)
	}
	return page, nil
}

func activityDescription(eventType string) string {
	switch eventType {
	case "project.created":
		return "created the project"
	case "task.created":
		return "created a task"
	case "task.updated":
		return "updated a task"
	case "task.deleted":
		return "deleted a task"
	case "comment.created":
		return "added a comment"
	case "comment.reaction.changed":
		return "reacted to a comment"
	case "dependency.created":
		return "added a dependency"
	case "dependency.deleted":
		return "removed a dependency"
	case "membership.created":
		return "added a project member"
	case "membership.updated":
		return "updated a project member"
	case "notification.read":
		return "read a notification"
	default:
		return strings.ReplaceAll(strings.TrimSuffix(eventType, ".changed"), ".", " ")
	}
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
	membership, err := store.GetActiveMembership(ctx, projectID, actorID)
	if err != nil {
		return err
	}
	if !domain.CanMutateProject(membership.Role) {
		return insufficientRole("VIEWER memberships cannot mutate project resources.")
	}
	return nil
}

func requireMembershipManager(ctx context.Context, store Store, projectID, actorID string) (domain.Membership, error) {
	membership, err := store.GetActiveMembership(ctx, projectID, actorID)
	if err != nil {
		return domain.Membership{}, err
	}
	if !domain.CanManageMembers(membership.Role) {
		return domain.Membership{}, insufficientRole("Only OWNER and ADMIN memberships can manage members.")
	}
	return membership, nil
}

func insufficientRole(message string) error {
	return domain.Validation("INSUFFICIENT_ROLE", message, nil)
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
