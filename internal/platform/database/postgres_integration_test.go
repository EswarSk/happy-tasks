package database

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

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
	service := app.NewService(db, syncstream.NewHub(), nil)
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
	candidateProjectID := uuid.Must(uuid.NewV7()).String()
	if _, err := service.CreateProject(ctx, testMeta("candidate-project:"+candidateProjectID), app.CreateProjectInput{ID: candidateProjectID, Name: "Membership candidate test"}); err != nil {
		t.Fatalf("create candidate project: %v", err)
	}
	candidates, err := service.ListMemberCandidates(ctx, testActor, candidateProjectID, app.MemberFilter{Search: "Noah", PageSize: 10})
	if err != nil || len(candidates.Items) != 1 || candidates.Items[0].DisplayName != "Noah Williams" {
		t.Fatalf("member candidates = %#v, error = %v", candidates.Items, err)
	}
	if _, err := service.CreateMembership(ctx, testMeta("candidate-member:"+candidateProjectID), candidateProjectID, app.CreateMembershipInput{UserID: candidates.Items[0].ID, Role: domain.RoleMember, Status: domain.MembershipActive}); err != nil {
		t.Fatalf("add candidate member: %v", err)
	}
	candidates, err = service.ListMemberCandidates(ctx, testActor, candidateProjectID, app.MemberFilter{Search: "Noah", PageSize: 10})
	if err != nil || len(candidates.Items) != 0 {
		t.Fatalf("added member remained a candidate: %#v, error = %v", candidates.Items, err)
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

	attachmentID := uuid.Must(uuid.NewV7()).String()
	storageKey := "integration/" + uuid.Must(uuid.NewV7()).String()
	if err := db.ScheduleAttachmentObjectCleanup(ctx, storageKey, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("schedule attachment cleanup: %v", err)
	}
	if _, err := service.CreateAttachment(ctx, testMeta("attachment:"+attachmentID), app.CreateAttachmentInput{
		ID: attachmentID, ProjectID: testProject, TaskID: taskA, FileName: "test.txt", ContentType: "text/plain",
		ByteSize: 4, Checksum: strings.Repeat("a", 64), StorageKey: storageKey,
	}); err != nil {
		t.Fatalf("create attachment: %v", err)
	}
	if keys, err := db.ClaimAttachmentObjectCleanup(ctx, 10); err != nil || contains(keys, storageKey) {
		t.Fatalf("committed attachment retained cleanup intent: keys=%v error=%v", keys, err)
	}
	if _, err := service.DeleteAttachment(ctx, testMeta("delete-attachment:"+attachmentID), testProject, taskA, attachmentID); err != nil {
		t.Fatalf("delete attachment: %v", err)
	}
	keys, err := db.ClaimAttachmentObjectCleanup(ctx, 10)
	if err != nil || !contains(keys, storageKey) {
		t.Fatalf("deleted attachment did not enqueue object cleanup: keys=%v error=%v", keys, err)
	}
	if err := db.CompleteAttachmentObjectCleanup(ctx, storageKey); err != nil {
		t.Fatalf("complete attachment cleanup: %v", err)
	}

	// Two fresh clients can both observe an uninitialized Yjs document. The
	// database conditional update makes initialization single-winner so the
	// second baseline cannot be merged into the document a second time.
	firstSnapshot := []byte{1, 2, 3}
	if _, err := service.PersistTaskDescriptionUpdate(ctx, testMeta("description-init:"+taskB), testProject, taskB, "First description", firstSnapshot, true); err != nil {
		t.Fatalf("initialize description: %v", err)
	}
	_, err = service.PersistTaskDescriptionUpdate(ctx, testMeta("description-race:"+taskB), testProject, taskB, "Duplicate description", []byte{4, 5, 6}, true)
	assertDomainCode(t, err, "DESCRIPTION_ALREADY_INITIALIZED")
	document, err := service.GetTaskDescriptionDocument(ctx, testActor, testProject, taskB)
	if err != nil {
		t.Fatalf("get initialized description: %v", err)
	}
	if !document.Initialized || !bytes.Equal(document.Snapshot, firstSnapshot) || len(document.Updates) != 0 {
		t.Fatalf("description initialization race changed the winner: %#v", document)
	}

	updated, err := service.UpdateTask(ctx, testMeta("update:"+taskA), testProject, taskA, 1, app.UpdateTaskInput{Status: statusPtr(domain.StatusInProgress)})
	if err != nil {
		t.Fatalf("update task: %v", err)
	}
	if updated.Value.Version != 2 {
		t.Fatalf("version = %d, want 2", updated.Value.Version)
	}
	merged, err := service.UpdateTask(ctx, testMeta("stale-disjoint:"+taskA), testProject, taskA, 1, app.UpdateTaskInput{Priority: priorityPtr(domain.PriorityHigh)})
	if err != nil {
		t.Fatalf("merge independent stale priority: %v", err)
	}
	if merged.Value.Version != 3 || merged.Value.Status != domain.StatusInProgress || merged.Value.Priority != domain.PriorityHigh {
		t.Fatalf("independent edits did not merge: %#v", merged.Value)
	}
	_, err = service.UpdateTask(ctx, testMeta("stale-overlap:"+taskA), testProject, taskA, 1, app.UpdateTaskInput{Status: statusPtr(domain.StatusDone)})
	assertDomainCode(t, err, "VERSION_CONFLICT")

	undone, err := service.UndoTask(ctx, testMeta("undo:"+taskA), testProject, taskA)
	if err != nil {
		t.Fatalf("undo task: %v", err)
	}
	if undone.Value.Status != domain.StatusInProgress || undone.Value.Priority != domain.PriorityMedium {
		t.Fatalf("undo overwrote an independent field: %#v", undone.Value)
	}
	redone, err := service.RedoTask(ctx, testMeta("redo:"+taskA), testProject, taskA)
	if err != nil {
		t.Fatalf("redo task: %v", err)
	}
	if redone.Value.Status != domain.StatusInProgress || redone.Value.Priority != domain.PriorityHigh {
		t.Fatalf("redo overwrote an independent field: %#v", redone.Value)
	}

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

	replyID := uuid.Must(uuid.NewV7()).String()
	reply, err := service.CreateComment(ctx, testMeta("reply:"+replyID), testProject, taskA, app.CreateCommentInput{ID: replyID, ParentID: &commentID, Body: "A nested reply"})
	if err != nil {
		t.Fatalf("create reply: %v", err)
	}
	if reply.Value.ParentID == nil || *reply.Value.ParentID != commentID {
		t.Fatalf("reply parent = %v, want %s", reply.Value.ParentID, commentID)
	}
	comments, err := service.ListComments(ctx, testActor, testProject, taskA, app.CommentFilter{PageSize: 10})
	if err != nil {
		t.Fatalf("list threaded comments: %v", err)
	}
	if len(comments.Items) < 2 || comments.Items[0].ID != replyID || comments.Items[0].ParentID == nil || *comments.Items[0].ParentID != commentID {
		t.Fatalf("threaded comments not returned newest-first: %#v", comments.Items)
	}

	crossTaskReplyID := uuid.Must(uuid.NewV7()).String()
	_, err = service.CreateComment(ctx, testMeta("cross-task-reply:"+crossTaskReplyID), testProject, taskB, app.CreateCommentInput{ID: crossTaskReplyID, ParentID: &commentID, Body: "Invalid cross-task reply"})
	assertDomainCode(t, err, "COMMENT_PARENT_NOT_FOUND")
}

// fakeCommentCache is an in-memory app.CommentCache used to prove the read-
// through and invalidation behavior without needing a real Redis instance:
// tampering with an entry directly and observing it get served proves reads
// are actually coming from the cache, not silently recomputed.
type fakeCommentCache struct {
	entries map[string]domain.Page[domain.Comment]
}

func newFakeCommentCache() *fakeCommentCache {
	return &fakeCommentCache{entries: map[string]domain.Page[domain.Comment]{}}
}

func fakeCommentCacheKey(projectID, taskID, actorID string) string {
	return projectID + ":" + taskID + ":" + actorID
}

func (f *fakeCommentCache) GetCommentPage(_ context.Context, projectID, taskID, actorID string) (domain.Page[domain.Comment], bool) {
	page, ok := f.entries[fakeCommentCacheKey(projectID, taskID, actorID)]
	return page, ok
}

func (f *fakeCommentCache) SetCommentPage(_ context.Context, projectID, taskID, actorID string, page domain.Page[domain.Comment]) {
	f.entries[fakeCommentCacheKey(projectID, taskID, actorID)] = page
}

func (f *fakeCommentCache) InvalidateCommentPage(_ context.Context, projectID, taskID, actorID string) {
	delete(f.entries, fakeCommentCacheKey(projectID, taskID, actorID))
}

func TestCommentCacheReadThroughAndInvalidation(t *testing.T) {
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
	cache := newFakeCommentCache()
	service := app.NewService(db, syncstream.NewHub(), cache)

	taskID := uuid.Must(uuid.NewV7()).String()
	if _, err := service.CreateTask(ctx, testMeta("cache-task:"+taskID), testProject, app.CreateTaskInput{
		ID: taskID, Title: "Comment cache test task", Status: domain.StatusTodo, Priority: domain.PriorityMedium,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	commentID := uuid.Must(uuid.NewV7()).String()
	if _, err := service.CreateComment(ctx, testMeta("cache-comment:"+commentID), testProject, taskID, app.CreateCommentInput{ID: commentID, Body: "Original body"}); err != nil {
		t.Fatalf("create comment: %v", err)
	}

	first, err := service.ListComments(ctx, testActor, testProject, taskID, app.CommentFilter{})
	if err != nil {
		t.Fatalf("list comments: %v", err)
	}
	if len(first.Items) != 1 || first.Items[0].Body != "Original body" {
		t.Fatalf("unexpected first page: %#v", first.Items)
	}
	if _, cached := cache.GetCommentPage(ctx, testProject, taskID, testActor); !cached {
		t.Fatal("first default-page-size list did not populate the cache")
	}

	poisoned := domain.Page[domain.Comment]{Items: []domain.Comment{{ID: "poisoned", Body: "Poisoned cache entry"}}}
	cache.SetCommentPage(ctx, testProject, taskID, testActor, poisoned)
	served, err := service.ListComments(ctx, testActor, testProject, taskID, app.CommentFilter{})
	if err != nil {
		t.Fatalf("list comments (poisoned): %v", err)
	}
	if len(served.Items) != 1 || served.Items[0].ID != "poisoned" {
		t.Fatalf("expected the poisoned cache entry to be served, got: %#v", served.Items)
	}

	// Creating a new comment as the same actor must invalidate their own
	// cached page so they immediately see their own new comment.
	secondCommentID := uuid.Must(uuid.NewV7()).String()
	if _, err := service.CreateComment(ctx, testMeta("cache-comment-2:"+secondCommentID), testProject, taskID, app.CreateCommentInput{ID: secondCommentID, Body: "Second body"}); err != nil {
		t.Fatalf("create second comment: %v", err)
	}
	if _, cached := cache.GetCommentPage(ctx, testProject, taskID, testActor); cached {
		t.Fatal("creating a comment did not invalidate the author's cached page")
	}
	refreshed, err := service.ListComments(ctx, testActor, testProject, taskID, app.CommentFilter{})
	if err != nil {
		t.Fatalf("list comments (refreshed): %v", err)
	}
	if len(refreshed.Items) != 2 {
		t.Fatalf("expected the fresh page to reflect both real comments, got: %#v", refreshed.Items)
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

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
