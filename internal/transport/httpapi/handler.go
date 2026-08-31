package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/app"
	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/eswaravegi/happy-task-management/internal/messaging"
	"github.com/eswaravegi/happy-task-management/internal/platform/objectstorage"
	"github.com/eswaravegi/happy-task-management/internal/syncstream"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
)

const maxRequestBody = 1 << 20
const maxAttachmentBytes = 25 << 20

type Handler struct {
	router             http.Handler
	service            *app.Service
	hub                *syncstream.Hub
	descriptionHub     *descriptionHub
	presenceHub        *presenceHub
	defaultActorID     string
	allowActorOverride bool
	allowedOrigins     map[string]struct{}
	logger             *slog.Logger
	rateLimiter        *rateLimiter
	authRequired       bool
	secureCookies      bool
	attachments        objectstorage.Store
	realtime           *messaging.Redis
	documentProducer   *messaging.Producer
}

type Config struct {
	AuthRequired     bool
	SecureCookies    bool
	Attachments      objectstorage.Store
	Realtime         *messaging.Redis
	DocumentProducer *messaging.Producer
	// RateLimits overrides defaultRatePolicies() by category; nil or a
	// partial map is fine, see cmd/api/main.go's RATE_LIMIT_* env vars.
	RateLimits map[string]RatePolicy
}

type authUserKey struct{}

func New(service *app.Service, hub *syncstream.Hub, defaultActorID string, allowActorOverride bool, allowedOrigins []string, logger *slog.Logger, config Config) *Handler {
	originSet := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		originSet[strings.TrimSuffix(origin, "/")] = struct{}{}
	}
	h := &Handler{service: service, hub: hub, descriptionHub: newDescriptionHub(), presenceHub: newPresenceHub(), defaultActorID: defaultActorID, allowActorOverride: allowActorOverride, allowedOrigins: originSet, logger: logger, rateLimiter: newRateLimiter(config.RateLimits), authRequired: config.AuthRequired, secureCookies: config.SecureCookies, attachments: config.Attachments, realtime: config.Realtime, documentProducer: config.DocumentProducer}
	router := chi.NewRouter()
	router.Use(middleware.Recoverer)
	router.Use(middleware.RealIP)
	router.Use(h.requestID)
	router.Use(h.accessLog)
	router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Content-Type", "If-Match", "Idempotency-Key", "Last-Event-ID", "X-Actor-ID", "X-Request-ID"},
		ExposedHeaders:   []string{"ETag", "X-Request-ID", "X-Stream-Cursor"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	router.Get("/health/live", h.live)
	router.Get("/health/ready", h.ready)
	router.Route("/v1", func(r chi.Router) {
		r.Use(h.rateLimit)
		r.Use(h.authenticate)
		r.Post("/auth/register", h.register)
		r.Post("/auth/login", h.login)
		r.Post("/auth/logout", h.logout)
		r.Get("/auth/me", h.authMe)
		r.Get("/projects", h.listProjects)
		r.Post("/projects", h.createProject)
		r.Route("/projects/{projectId}", func(r chi.Router) {
			r.Get("/", h.getProject)
			r.Get("/bootstrap", h.bootstrap)
			r.Get("/events", h.events)
			r.Get("/collaboration/live", h.collaborationWebSocket)
			r.Get("/activity", h.activity)
			r.Get("/notifications", h.notifications)
			r.Post("/notifications/{notificationId}/read", h.markNotificationRead)
			r.Get("/members", h.listMembers)
			r.Get("/members/candidates", h.listMemberCandidates)
			r.Post("/members", h.createMembership)
			r.Patch("/members/{membershipId}", h.updateMembership)
			r.Delete("/members/{membershipId}", h.removeMembership)
			r.Get("/tasks", h.listTasks)
			r.Post("/tasks", h.createTask)
			r.Route("/tasks/{taskId}", func(r chi.Router) {
				r.Get("/", h.getTask)
				r.Get("/agent-runs/latest", h.getLatestAgentRun)
				r.Patch("/", h.updateTask)
				r.Delete("/", h.deleteTask)
				r.Post("/undo", h.undoTask)
				r.Post("/redo", h.redoTask)
				r.Get("/description/live", h.descriptionWebSocket)
				r.Post("/dependencies", h.addDependency)
				r.Delete("/dependencies/{dependencyTaskId}", h.removeDependency)
				r.Get("/comments", h.listComments)
				r.Post("/comments", h.createComment)
				r.Put("/comments/{commentId}/reaction", h.setCommentReaction)
				r.Delete("/comments/{commentId}/reaction", h.removeCommentReaction)
				r.Get("/assignment-history", h.listAssignmentHistory)
				r.Get("/attachments", h.listAttachments)
				r.Post("/attachments", h.uploadAttachment)
				r.Get("/attachments/{attachmentId}", h.downloadAttachment)
				r.Delete("/attachments/{attachmentId}", h.deleteAttachment)
			})
		})
	})
	h.router = router
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.router.ServeHTTP(w, r) }

func (h *Handler) PublishDocumentUpdate(update messaging.DocumentUpdate) {
	h.descriptionHub.broadcast(update.ProjectID+":"+update.TaskID, nil, descriptionFrame{Type: "update", Update: update.Update, Text: update.Text, ActorID: update.ActorID})
}

func (h *Handler) PublishPresence(projectID string, item messaging.Presence) {
	h.presenceHub.broadcastSession(projectID, item.SessionID, presenceFrame{Type: item.Type, SessionID: item.SessionID, ActorID: item.ActorID, TaskID: item.TaskID, SelectionFrom: item.SelectionFrom, SelectionTo: item.SelectionTo})
}

type createProjectRequest struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Metadata    map[string]any `json:"metadata"`
}

type createTaskRequest struct {
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	Status       domain.Status   `json:"status"`
	Priority     domain.Priority `json:"priority"`
	CustomFields map[string]any  `json:"customFields"`
	AssigneeIDs  []string        `json:"assigneeIds"`
	Tags         []string        `json:"tags"`
}

type updateTaskRequest struct {
	Title        *string          `json:"title"`
	Description  *string          `json:"description"`
	Status       *domain.Status   `json:"status"`
	Priority     *domain.Priority `json:"priority"`
	CustomFields *map[string]any  `json:"customFields"`
	AssigneeIDs  *[]string        `json:"assigneeIds"`
	Tags         *[]string        `json:"tags"`
}

type createMembershipRequest struct {
	UserID string                  `json:"userId"`
	Role   domain.ProjectRole      `json:"role"`
	Status domain.MembershipStatus `json:"status"`
}

type updateMembershipRequest struct {
	Role   *domain.ProjectRole      `json:"role"`
	Status *domain.MembershipStatus `json:"status"`
}

func (r updateTaskRequest) empty() bool {
	return r.Title == nil && r.Description == nil && r.Status == nil && r.Priority == nil && r.CustomFields == nil && r.AssigneeIDs == nil && r.Tags == nil
}

func (h *Handler) live(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := h.service.Ping(ctx); err != nil {
		h.writeError(w, r, &domain.Error{Code: "DATABASE_UNAVAILABLE", Message: "The database is not ready.", Cause: err})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

type credentialsRequest struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Password    string `json:"password"`
}

func (h *Handler) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/v1/auth/") {
			next.ServeHTTP(w, r)
			return
		}
		if cookie, err := r.Cookie("happy_tasks_session"); err == nil && cookie.Value != "" {
			user, sessionErr := h.service.SessionUser(r.Context(), cookie.Value)
			if sessionErr == nil {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authUserKey{}, user)))
				return
			}
		}
		if h.authRequired {
			h.writeError(w, r, domain.Validation("UNAUTHENTICATED", "Sign in is required.", nil))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var request credentialsRequest
	if _, ok := h.decode(w, r, &request); !ok {
		return
	}
	user, token, err := h.service.Register(r.Context(), request.DisplayName, request.Email, request.Password)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.setSessionCookie(w, token)
	writeJSON(w, http.StatusCreated, map[string]any{"user": user})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var request credentialsRequest
	if _, ok := h.decode(w, r, &request); !ok {
		return
	}
	user, token, err := h.service.Login(r.Context(), request.Email, request.Password)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.setSessionCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("happy_tasks_session"); err == nil {
		if err := h.service.Logout(r.Context(), cookie.Value); err != nil {
			h.writeError(w, r, err)
			return
		}
	}
	h.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) authMe(w http.ResponseWriter, r *http.Request) {
	if user, ok := r.Context().Value(authUserKey{}).(domain.User); ok {
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
		return
	}
	if cookie, err := r.Cookie("happy_tasks_session"); err == nil {
		if user, sessionErr := h.service.SessionUser(r.Context(), cookie.Value); sessionErr == nil {
			writeJSON(w, http.StatusOK, map[string]any{"user": user})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": nil})
}

// sessionCookieSameSite is Lax for local HTTP dev (web and api are same-site
// localhost, just different ports) and None for deployments where the API is a
// separate site (e.g. two different Cloud Run services) — the browser never sends
// a Lax cookie on the cross-site fetch() the frontend uses. None requires Secure,
// which secureCookies already guarantees whenever this returns None.
func (h *Handler) sessionCookieSameSite() http.SameSite {
	if h.secureCookies {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func (h *Handler) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: "happy_tasks_session", Value: token, Path: "/", HttpOnly: true, Secure: h.secureCookies, SameSite: h.sessionCookieSameSite(), MaxAge: 30 * 24 * 60 * 60})
}

func (h *Handler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "happy_tasks_session", Path: "/", HttpOnly: true, Secure: h.secureCookies, SameSite: h.sessionCookieSameSite(), MaxAge: -1})
}

func (h *Handler) listProjects(w http.ResponseWriter, r *http.Request) {
	page, err := h.service.ListProjects(r.Context(), h.actorID(r), intQuery(r, "limit", 50))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) getProject(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	project, err := h.service.GetProject(r.Context(), h.actorID(r), projectID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(project.Version))
	writeJSON(w, http.StatusOK, project)
}

func (h *Handler) bootstrap(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	result, err := h.service.Bootstrap(r.Context(), h.actorID(r), projectID, intQuery(r, "limit", 50))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) createProject(w http.ResponseWriter, r *http.Request) {
	var request createProjectRequest
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	if request.ID == "" {
		request.ID = uuid.Must(uuid.NewV7()).String()
	}
	if !validUUID(request.ID) {
		h.validationError(w, r, "id", "must be a UUID")
		return
	}
	result, err := h.service.CreateProject(r.Context(), h.mutationMeta(r, raw), app.CreateProjectInput(request))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusCreated, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) listMembers(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	filter := app.MemberFilter{Search: strings.TrimSpace(r.URL.Query().Get("q")), PageSize: intQuery(r, "limit", 50)}
	if value := r.URL.Query().Get("status"); value != "" {
		status := domain.MembershipStatus(value)
		if !domain.ValidMembershipStatus(status) {
			h.validationError(w, r, "status", "unknown membership status")
			return
		}
		filter.Status = &status
	}
	if value := r.URL.Query().Get("role"); value != "" {
		role := domain.ProjectRole(value)
		if !domain.ValidProjectRole(role) {
			h.validationError(w, r, "role", "unknown project role")
			return
		}
		filter.Role = &role
	}
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err := app.DecodeMemberCursor(value)
		if err != nil {
			h.validationError(w, r, "cursor", "invalid cursor")
			return
		}
		filter.Cursor = cursor
	}
	page, err := h.service.ListMembers(r.Context(), h.actorID(r), projectID, filter)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) listMemberCandidates(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	filter := app.MemberFilter{Search: strings.TrimSpace(r.URL.Query().Get("q")), PageSize: intQuery(r, "limit", 50)}
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err := app.DecodeMemberCursor(value)
		if err != nil {
			h.validationError(w, r, "cursor", "invalid cursor")
			return
		}
		filter.Cursor = cursor
	}
	page, err := h.service.ListMemberCandidates(r.Context(), h.actorID(r), projectID, filter)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) createMembership(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	var request createMembershipRequest
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	if !validUUID(request.UserID) {
		h.validationError(w, r, "userId", "must be a UUID")
		return
	}
	result, err := h.service.CreateMembership(r.Context(), h.mutationMeta(r, raw), projectID, app.CreateMembershipInput{
		UserID: request.UserID, Role: request.Role, Status: request.Status,
	})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusCreated, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) updateMembership(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	membershipID, ok := pathUUID(w, r, "membershipId")
	if !ok {
		return
	}
	version, ok := h.ifMatch(w, r)
	if !ok {
		return
	}
	var request updateMembershipRequest
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	result, err := h.service.UpdateMembership(r.Context(), h.mutationMeta(r, raw), projectID, membershipID, app.UpdateMembershipInput{Role: request.Role, Status: request.Status, ExpectedVersion: version})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) removeMembership(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	membershipID, ok := pathUUID(w, r, "membershipId")
	if !ok {
		return
	}
	version, ok := h.ifMatch(w, r)
	if !ok {
		return
	}
	result, err := h.service.RemoveMembership(r.Context(), h.mutationMeta(r, nil), projectID, membershipID, version)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) listTasks(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	filter := app.TaskFilter{PageSize: intQuery(r, "limit", 50)}
	if value := r.URL.Query().Get("status"); value != "" {
		status := domain.Status(value)
		if !domain.ValidStatus(status) {
			h.validationError(w, r, "status", "unknown status")
			return
		}
		filter.Status = &status
	}
	if value := r.URL.Query().Get("priority"); value != "" {
		priority := domain.Priority(value)
		if !domain.ValidPriority(priority) {
			h.validationError(w, r, "priority", "unknown priority")
			return
		}
		filter.Priority = &priority
	}
	if value := r.URL.Query().Get("assignee"); value != "" {
		if _, err := uuid.Parse(value); err != nil {
			h.validationError(w, r, "assignee", "must be a UUID")
			return
		}
		filter.AssigneeID = &value
	}
	filter.Tag = strings.TrimSpace(r.URL.Query().Get("tag"))
	if len(filter.Tag) > 100 {
		h.validationError(w, r, "tag", "must not exceed 100 characters")
		return
	}
	filter.Search = strings.TrimSpace(r.URL.Query().Get("q"))
	if len(filter.Search) > 200 {
		h.validationError(w, r, "q", "must not exceed 200 characters")
		return
	}
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err := app.DecodeTaskCursor(value)
		if err != nil {
			h.validationError(w, r, "cursor", "invalid cursor")
			return
		}
		filter.Cursor = cursor
	}
	page, err := h.service.ListTasks(r.Context(), h.actorID(r), projectID, filter)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) getTask(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	task, err := h.service.GetTask(r.Context(), h.actorID(r), projectID, taskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(task.Version))
	writeJSON(w, http.StatusOK, task)
}

func (h *Handler) getLatestAgentRun(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	run, err := h.service.GetLatestAgentRun(r.Context(), h.actorID(r), projectID, taskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (h *Handler) listAttachments(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	items, err := h.service.ListAttachments(r.Context(), h.actorID(r), projectID, taskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	for index := range items {
		items[index].StorageKey = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	if err := h.service.AuthorizeAttachmentUpload(r.Context(), h.actorID(r), projectID, taskID); err != nil {
		h.writeError(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		h.writeError(w, r, domain.Validation("PAYLOAD_TOO_LARGE", "The uploaded file is too large or malformed.", nil))
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		h.writeError(w, r, domain.Validation("VALIDATION_ERROR", "A file is required.", nil))
		return
	}
	defer file.Close()

	fileName := strings.TrimSpace(strings.ReplaceAll(header.Filename, "\x00", ""))
	fileName = filepath.Base(strings.ReplaceAll(fileName, "\\", "/"))
	if fileName == "." || fileName == "" || len(fileName) > 255 {
		h.writeError(w, r, domain.Validation("VALIDATION_ERROR", "The file name is invalid.", nil))
		return
	}
	declaredType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if parsed, _, parseErr := mime.ParseMediaType(declaredType); parseErr == nil {
		declaredType = parsed
	}

	digest := sha256.New()
	head := make([]byte, 512)
	readCount, readErr := file.Read(head)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		h.writeError(w, r, readErr)
		return
	}
	if declaredType == "" && readCount > 0 {
		declaredType = http.DetectContentType(head[:readCount])
	}
	written := int64(0)
	if readCount > 0 {
		_, _ = digest.Write(head[:readCount])
		written = int64(readCount)
	}
	copyErr := error(nil)
	if written <= maxAttachmentBytes {
		var copied int64
		copied, copyErr = io.Copy(digest, io.LimitReader(file, maxAttachmentBytes+1-written))
		written += copied
	}
	if copyErr != nil {
		h.writeError(w, r, copyErr)
		return
	}
	if written < 1 || written > maxAttachmentBytes {
		h.writeError(w, r, domain.Validation("PAYLOAD_TOO_LARGE", "Each file must be between 1 byte and 25 MB.", nil))
		return
	}
	if !allowedAttachmentType(declaredType) {
		h.writeError(w, r, domain.Validation("UNSUPPORTED_FILE_TYPE", "Only common documents and images can be uploaded.", nil))
		return
	}

	attachmentID := strings.TrimSpace(r.FormValue("id"))
	if attachmentID == "" {
		attachmentID = uuid.Must(uuid.NewV7()).String()
	}
	if !validUUID(attachmentID) {
		h.validationError(w, r, "id", "must be a UUID")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		h.writeError(w, r, err)
		return
	}
	digestHex := hex.EncodeToString(digest.Sum(nil))
	storageKey := strings.Join([]string{projectID, taskID, attachmentID, uuid.Must(uuid.NewV7()).String()}, "/")
	if err := h.service.ScheduleAttachmentObjectCleanup(r.Context(), storageKey, time.Now().Add(15*time.Minute)); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := h.attachments.Put(r.Context(), storageKey, declaredType, written, file); err != nil {
		h.writeError(w, r, err)
		return
	}
	meta := h.mutationMeta(r, []byte(strings.Join([]string{attachmentID, fileName, declaredType, strconv.FormatInt(written, 10), digestHex}, "\n")))
	result, err := h.service.CreateAttachment(r.Context(), meta, app.CreateAttachmentInput{
		ID: attachmentID, ProjectID: projectID, TaskID: taskID, FileName: fileName,
		ContentType: declaredType, ByteSize: written, Checksum: digestHex, StorageKey: storageKey,
	})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	result.Value.StorageKey = ""
	writeMutation(w, http.StatusCreated, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) downloadAttachment(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	attachmentID, ok := pathUUID(w, r, "attachmentId")
	if !ok {
		return
	}
	attachment, err := h.service.GetAttachment(r.Context(), h.actorID(r), projectID, taskID, attachmentID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	object, err := h.attachments.Get(r.Context(), attachment.StorageKey)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	defer object.Body.Close()
	w.Header().Set("Content-Type", attachment.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeHeaderFilename(attachment.FileName)))
	if object.Length >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(object.Length, 10))
	}
	if !object.LastModified.IsZero() {
		w.Header().Set("Last-Modified", object.LastModified.UTC().Format(http.TimeFormat))
	}
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, object.Body); err != nil {
		h.logger.Warn("attachment download interrupted", "error", err, "storage_key", attachment.StorageKey)
	}
}

func (h *Handler) deleteAttachment(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	attachmentID, ok := pathUUID(w, r, "attachmentId")
	if !ok {
		return
	}
	result, err := h.service.DeleteAttachment(r.Context(), h.mutationMeta(r, nil), projectID, taskID, attachmentID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	result.Value.StorageKey = ""
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func allowedAttachmentType(value string) bool {
	switch value {
	case "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"text/plain", "text/markdown", "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func safeHeaderFilename(value string) string {
	value = filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == '"' || r == '\\' {
			return '-'
		}
		return r
	}, value)
	if value == "" {
		return "download"
	}
	return value
}

func (h *Handler) createTask(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	var request createTaskRequest
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	if request.ID == "" {
		request.ID = uuid.Must(uuid.NewV7()).String()
	}
	if !validUUID(request.ID) {
		h.validationError(w, r, "id", "must be a UUID")
		return
	}
	if !allUUIDs(request.AssigneeIDs) {
		h.validationError(w, r, "assigneeIds", "must contain UUIDs")
		return
	}
	result, err := h.service.CreateTask(r.Context(), h.mutationMeta(r, raw), projectID, app.CreateTaskInput(request))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusCreated, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) updateTask(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	expected, ok := h.ifMatch(w, r)
	if !ok {
		return
	}
	var request updateTaskRequest
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	if request.empty() {
		h.validationError(w, r, "body", "at least one field is required")
		return
	}
	if request.AssigneeIDs != nil && !allUUIDs(*request.AssigneeIDs) {
		h.validationError(w, r, "assigneeIds", "must contain UUIDs")
		return
	}
	input := app.UpdateTaskInput{Title: request.Title, Description: request.Description, Status: request.Status, Priority: request.Priority, CustomFields: request.CustomFields, AssigneeIDs: request.AssigneeIDs, Tags: request.Tags}
	result, err := h.service.UpdateTask(r.Context(), h.mutationMeta(r, raw), projectID, taskID, expected, input)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) deleteTask(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	expected, ok := h.ifMatch(w, r)
	if !ok {
		return
	}
	result, err := h.service.DeleteTask(r.Context(), h.mutationMeta(r, nil), projectID, taskID, expected)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) undoTask(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	result, err := h.service.UndoTask(r.Context(), h.mutationMeta(r, nil), projectID, taskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) redoTask(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	result, err := h.service.RedoTask(r.Context(), h.mutationMeta(r, nil), projectID, taskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) addDependency(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	var request struct {
		DependsOnTaskID string `json:"dependsOnTaskId"`
	}
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	if !validUUID(request.DependsOnTaskID) {
		h.validationError(w, r, "dependsOnTaskId", "must be a UUID")
		return
	}
	result, err := h.service.AddDependency(r.Context(), h.mutationMeta(r, raw), projectID, taskID, request.DependsOnTaskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeMutation(w, http.StatusCreated, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) removeDependency(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	dependencyID, ok := pathUUID(w, r, "dependencyTaskId")
	if !ok {
		return
	}
	result, err := h.service.RemoveDependency(r.Context(), h.mutationMeta(r, nil), projectID, taskID, dependencyID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) listComments(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	filter := app.CommentFilter{PageSize: intQuery(r, "limit", 50)}
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err := app.DecodeCommentCursor(value)
		if err != nil {
			h.validationError(w, r, "cursor", "invalid cursor")
			return
		}
		filter.Cursor = cursor
	}
	page, err := h.service.ListComments(r.Context(), h.actorID(r), projectID, taskID, filter)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) createComment(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	var request struct {
		ID       string  `json:"id"`
		ParentID *string `json:"parentId"`
		Body     string  `json:"body"`
	}
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	if request.ID == "" {
		request.ID = uuid.Must(uuid.NewV7()).String()
	}
	if !validUUID(request.ID) {
		h.validationError(w, r, "id", "must be a UUID")
		return
	}
	if request.ParentID != nil && !validUUID(*request.ParentID) {
		h.validationError(w, r, "parentId", "must be a UUID")
		return
	}
	result, err := h.service.CreateComment(r.Context(), h.mutationMeta(r, raw), projectID, taskID, app.CreateCommentInput{ID: request.ID, ParentID: request.ParentID, Body: request.Body})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(result.Value.Version))
	writeMutation(w, http.StatusCreated, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) setCommentReaction(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	commentID, ok := pathUUID(w, r, "commentId")
	if !ok {
		return
	}
	var request struct {
		ReactionType string `json:"type"`
	}
	raw, ok := h.decode(w, r, &request)
	if !ok {
		return
	}
	result, err := h.service.SetCommentReaction(r.Context(), h.mutationMeta(r, raw), projectID, taskID, commentID, strings.ToUpper(strings.TrimSpace(request.ReactionType)))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) removeCommentReaction(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	commentID, ok := pathUUID(w, r, "commentId")
	if !ok {
		return
	}
	result, err := h.service.RemoveCommentReaction(r.Context(), h.mutationMeta(r, nil), projectID, taskID, commentID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) listAssignmentHistory(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	filter := app.AssignmentFilter{PageSize: intQuery(r, "limit", 50)}
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err := app.DecodeAssignmentCursor(value)
		if err != nil {
			h.validationError(w, r, "cursor", "invalid cursor")
			return
		}
		filter.Cursor = cursor
	}
	page, err := h.service.ListAssignmentHistory(r.Context(), h.actorID(r), projectID, taskID, filter)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) activity(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	after, err := eventCursor(r)
	if err != nil {
		h.validationError(w, r, "after", "must be a non-negative integer")
		return
	}
	page, err := h.service.ListActivity(r.Context(), h.actorID(r), projectID, after, intQuery(r, "limit", 50))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) notifications(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	after, err := notificationCursor(r)
	if err != nil {
		h.validationError(w, r, "cursor", "invalid cursor")
		return
	}
	unreadOnly := true
	if value := r.URL.Query().Get("unread"); value != "" {
		unreadOnly, err = strconv.ParseBool(value)
		if err != nil {
			h.validationError(w, r, "unread", "must be true or false")
			return
		}
	}
	page, err := h.service.ListNotifications(r.Context(), h.actorID(r), projectID, unreadOnly, after, intQuery(r, "limit", 50))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) markNotificationRead(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	notificationID, ok := pathUUID(w, r, "notificationId")
	if !ok {
		return
	}
	result, err := h.service.MarkNotificationRead(r.Context(), h.mutationMeta(r, nil), projectID, notificationID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeMutation(w, http.StatusOK, result.StreamCursor, result.Replayed, result.Value)
}

func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	after, err := eventCursor(r)
	if err != nil {
		h.validationError(w, r, "after", "must be a non-negative integer")
		return
	}
	if _, err := h.service.StreamCursor(r.Context(), h.actorID(r), projectID); err != nil {
		h.writeError(w, r, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		h.writeError(w, r, errors.New("streaming is unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	// A reverse proxy in front of this service (e.g. Cloud Run's) can hold the
	// response until real body bytes exist, even after Flush() — an empty
	// replay (the common case: client already caught up) previously left the
	// connection silent until the 15s heartbeat below produced the first real
	// bytes, so every reconnect with nothing new to replay paid up to a full
	// heartbeat interval before the client saw anything. Writing an SSE
	// comment (ignored by clients per spec) immediately guarantees real bytes
	// leave on connect regardless of replay content or proxy buffering.
	if _, err := io.WriteString(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()
	notices, unsubscribe := h.hub.Subscribe(projectID)
	defer unsubscribe()

	heartbeat := time.NewTicker(15 * time.Second)
	poll := time.NewTicker(2 * time.Second)
	defer heartbeat.Stop()
	defer poll.Stop()
	replay := func() error {
		for {
			events, err := h.service.ReplayEvents(r.Context(), projectID, after, 200)
			if err != nil {
				return err
			}
			for _, event := range events {
				if err := writeSSE(w, event); err != nil {
					return err
				}
				after = event.Sequence
			}
			if len(events) < 200 {
				break
			}
		}
		flusher.Flush()
		return nil
	}
	if replay() != nil {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case notice := <-notices:
			if notice.Event != nil && notice.Event.Sequence == after+1 {
				if writeSSE(w, *notice.Event) != nil {
					return
				}
				after = notice.Event.Sequence
				flusher.Flush()
				continue
			}
			if notice.Event != nil && notice.Event.Sequence <= after {
				continue
			}
			if replay() != nil {
				return
			}
		case <-poll.C:
			if replay() != nil {
				return
			}
		case <-heartbeat.C:
			// Membership is leased, not captured forever. Revocation closes the
			// stream within one heartbeat even across API instances.
			if _, err := h.service.StreamCursor(r.Context(), h.actorID(r), projectID); err != nil {
				return
			}
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSE(w io.Writer, event domain.Event) error {
	b, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.Sequence, event.Type, b)
	return err
}

func eventCursor(r *http.Request) (int64, error) {
	value := r.URL.Query().Get("after")
	if value == "" {
		value = r.Header.Get("Last-Event-ID")
	}
	if value == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 {
		return 0, errors.New("invalid event cursor")
	}
	return n, nil
}

func notificationCursor(r *http.Request) (*app.NotificationCursor, error) {
	value := r.URL.Query().Get("cursor")
	if value == "" {
		return nil, nil
	}
	return app.DecodeNotificationCursor(value)
}

func (h *Handler) decode(w http.ResponseWriter, r *http.Request, destination any) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		h.writeError(w, r, domain.Validation("INVALID_JSON", "The request body could not be read.", nil))
		return nil, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		h.writeError(w, r, domain.Validation("INVALID_JSON", "The request body is invalid JSON or contains unknown fields.", nil))
		return nil, false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		h.writeError(w, r, domain.Validation("INVALID_JSON", "The request body must contain one JSON value.", nil))
		return nil, false
	}
	return raw, true
}

func (h *Handler) mutationMeta(r *http.Request, raw []byte) app.MutationMeta {
	hashInput := strings.Join([]string{r.Method, r.URL.Path, r.Header.Get("If-Match"), string(raw)}, "\n")
	digest := sha256.Sum256([]byte(hashInput))
	return app.MutationMeta{ActorID: h.actorID(r), RequestID: requestID(r.Context()), IdempotencyKey: r.Header.Get("Idempotency-Key"), RequestHash: digest[:]}
}

func (h *Handler) actorID(r *http.Request) string {
	if value := r.Header.Get("X-Actor-ID"); h.allowActorOverride && validUUID(value) {
		return value
	}
	if user, ok := r.Context().Value(authUserKey{}).(domain.User); ok {
		return user.ID
	}
	return h.defaultActorID
}

func (h *Handler) ifMatch(w http.ResponseWriter, r *http.Request) (int64, bool) {
	value := strings.TrimSpace(r.Header.Get("If-Match"))
	value = strings.TrimPrefix(value, "W/")
	value = strings.Trim(value, `"`)
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version < 1 {
		h.writeError(w, r, domain.Validation("PRECONDITION_REQUIRED", "If-Match must contain the current entity version.", nil))
		return 0, false
	}
	return version, true
}

func (h *Handler) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value := r.Header.Get("X-Request-ID")
		if !validUUID(value) {
			value = uuid.Must(uuid.NewV7()).String()
		}
		w.Header().Set("X-Request-ID", value)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, value)))
	})
}

func (h *Handler) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		h.logger.Info("http request", "request_id", requestID(r.Context()), "method", r.Method, "path", r.URL.Path, "status", ww.Status(), "duration_ms", time.Since(start).Milliseconds())
	})
}

type requestIDKey struct{}

func requestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	return value
}

func (h *Handler) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.rateLimiter != nil && !h.rateLimiter.allow(rateLimitKey(r, h.allowActorOverride), rateLimitCategory(r), time.Now()) {
			w.Header().Set("Retry-After", "1")
			h.writeError(w, r, domain.Validation("RATE_LIMITED", "Too many requests; retry shortly.", nil))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) validationError(w http.ResponseWriter, r *http.Request, field, message string) {
	h.writeError(w, r, domain.Validation("VALIDATION_ERROR", "One or more request fields are invalid.", map[string]any{"field": field, "message": message}))
}

func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	code, message := "INTERNAL_ERROR", "An unexpected error occurred."
	var domainErr *domain.Error
	if errors.As(err, &domainErr) {
		code, message = domainErr.Code, domainErr.Message
		switch code {
		case "NOT_FOUND":
			status = http.StatusNotFound
		case "FORBIDDEN", "INSUFFICIENT_ROLE":
			status = http.StatusForbidden
		case "VERSION_CONFLICT", "OPERATION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "ALREADY_EXISTS", "FINAL_ACTIVE_OWNER":
			status = http.StatusConflict
		case "PRECONDITION_REQUIRED":
			status = http.StatusPreconditionRequired
		case "DATABASE_UNAVAILABLE":
			status = http.StatusServiceUnavailable
		case "UNAUTHENTICATED", "INVALID_CREDENTIALS":
			status = http.StatusUnauthorized
		case "PAYLOAD_TOO_LARGE":
			status = http.StatusRequestEntityTooLarge
		case "RATE_LIMITED":
			status = http.StatusTooManyRequests
		case "VALIDATION_ERROR", "INVALID_JSON", "IDEMPOTENCY_KEY_REQUIRED":
			status = http.StatusBadRequest
		default:
			status = http.StatusUnprocessableEntity
		}
	}
	if status >= 500 {
		h.logger.Error("request failed", "request_id", requestID(r.Context()), "error", err)
	}
	response := map[string]any{"error": map[string]any{"code": code, "message": message, "requestId": requestID(r.Context())}}
	if domainErr != nil && len(domainErr.Details) > 0 {
		response["error"].(map[string]any)["details"] = domainErr.Details
	}
	writeJSON(w, status, response)
}

func pathUUID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	value := chi.URLParam(r, name)
	if !validUUID(value) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "VALIDATION_ERROR", "message": name + " must be a UUID", "requestId": requestID(r.Context())}})
		return "", false
	}
	return value, true
}

func taskPath(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return "", "", false
	}
	taskID, ok := pathUUID(w, r, "taskId")
	return projectID, taskID, ok
}

func validUUID(value string) bool { _, err := uuid.Parse(value); return err == nil }
func allUUIDs(values []string) bool {
	for _, value := range values {
		if !validUUID(value) {
			return false
		}
	}
	return true
}
func etag(version int64) string { return fmt.Sprintf(`"%d"`, version) }

func intQuery(r *http.Request, key string, fallback int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	return value
}

func writeMutation(w http.ResponseWriter, status int, cursor int64, replayed bool, value any) {
	if cursor > 0 {
		w.Header().Set("X-Stream-Cursor", strconv.FormatInt(cursor, 10))
	}
	if replayed {
		w.Header().Set("Idempotency-Replayed", "true")
	}
	writeJSON(w, status, value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
