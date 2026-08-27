package database

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"

	"github.com/eswaravegi/happy-task-management/internal/app"
	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/eswaravegi/happy-task-management/internal/syncstream"
	"github.com/google/uuid"
)

const (
	testActor   = "00000000-0000-7000-8000-000000000001"
	testProject = "01000000-0000-7000-8000-000000000001"
)

// This test expects the documented migrations and demo seed. It is skipped by
// ordinary unit runs and can be enabled with TEST_DATABASE_URL in CI or locally.
func TestTransactionalFlows(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := app.NewService(db, syncstream.NewHub())
	projects, err := service.ListProjects(ctx, testActor, 50)
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	var demoTaskCount int64
	for _, project := range projects.Items {
		if project.ID == testProject {
			demoTaskCount = project.TaskCount
			break
		}
	}
	if demoTaskCount < 5 {
		t.Fatalf("demo task count = %d, want at least 5", demoTaskCount)
	}
	priority := domain.PriorityHigh
	filtered, err := service.ListTasks(ctx, testActor, testProject, app.TaskFilter{
		Priority: &priority,
		Search:   "virtualized",
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("filter tasks: %v", err)
	}
	if len(filtered.Items) != 1 || filtered.Items[0].Title != "Build virtualized task list" {
		t.Fatalf("unexpected filtered tasks: %#v", filtered.Items)
	}

	taskA := uuid.Must(uuid.NewV7()).String()
	taskB := uuid.Must(uuid.NewV7()).String()
	for _, taskID := range []string{taskA, taskB} {
		_, err := service.CreateTask(ctx, testMeta("create:"+taskID), testProject, app.CreateTaskInput{
			ID: taskID, Title: "Integration task", Status: domain.StatusTodo, Priority: domain.PriorityMedium,
		})
		if err != nil {
			t.Fatalf("create task: %v", err)
		}
	}

	updated, err := service.UpdateTask(ctx, testMeta("update:"+taskA), testProject, taskA, 1, app.UpdateTaskInput{Status: statusPtr(domain.StatusInProgress)})
	if err != nil {
		t.Fatalf("update task: %v", err)
	}
	if updated.Value.Version != 2 {
		t.Fatalf("version = %d, want 2", updated.Value.Version)
	}
	_, err = service.UpdateTask(ctx, testMeta("stale:"+taskA), testProject, taskA, 1, app.UpdateTaskInput{Priority: priorityPtr(domain.PriorityHigh)})
	assertDomainCode(t, err, "VERSION_CONFLICT")

	if _, err := service.AddDependency(ctx, testMeta("edge:"+taskA), testProject, taskA, taskB); err != nil {
		t.Fatalf("add dependency: %v", err)
	}
	_, err = service.AddDependency(ctx, testMeta("cycle:"+taskB), testProject, taskB, taskA)
	assertDomainCode(t, err, "DEPENDENCY_CYCLE")

	commentID := uuid.Must(uuid.NewV7()).String()
	meta := testMeta("comment:" + commentID)
	first, err := service.CreateComment(ctx, meta, testProject, taskA, app.CreateCommentInput{ID: commentID, Body: "Idempotent comment"})
	if err != nil {
		t.Fatalf("create comment: %v", err)
	}
	second, err := service.CreateComment(ctx, meta, testProject, taskA, app.CreateCommentInput{ID: commentID, Body: "Idempotent comment"})
	if err != nil {
		t.Fatalf("replay comment: %v", err)
	}
	if !second.Replayed || first.Value.ID != second.Value.ID {
		t.Fatal("expected the second comment request to replay")
	}
}

func testMeta(key string) app.MutationMeta {
	hash := sha256.Sum256([]byte(key))
	return app.MutationMeta{ActorID: testActor, RequestID: uuid.Must(uuid.NewV7()).String(), IdempotencyKey: key, RequestHash: hash[:]}
}

func statusPtr(value domain.Status) *domain.Status       { return &value }
func priorityPtr(value domain.Priority) *domain.Priority { return &value }

func assertDomainCode(t *testing.T, err error, code string) {
	t.Helper()
	var domainErr *domain.Error
	if !errors.As(err, &domainErr) || domainErr.Code != code {
		t.Fatalf("error = %v, want domain code %s", err, code)
	}
}
