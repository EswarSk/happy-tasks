package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/app"
	"github.com/eswaravegi/happy-task-management/internal/messaging"
	"github.com/eswaravegi/happy-task-management/internal/platform/database"
	"github.com/eswaravegi/happy-task-management/internal/platform/objectstorage"
	"github.com/eswaravegi/happy-task-management/internal/syncstream"
	"github.com/eswaravegi/happy-task-management/internal/transport/httpapi"
)

const fallbackActorID = "00000000-0000-7000-8000-000000000001"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	databaseURL := env("DATABASE_URL", "postgres://taskapp:taskapp@localhost:5432/taskapp?sslmode=disable")
	db, err := database.Open(context.Background(), databaseURL)
	if err != nil {
		logger.Error("database configuration failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	attachments, err := objectstorage.Open(context.Background(), objectstorage.Config{
		Bucket:       env("S3_BUCKET", "happy-task-attachments"),
		Region:       env("AWS_REGION", "us-east-1"),
		Endpoint:     strings.TrimSpace(os.Getenv("S3_ENDPOINT")),
		CreateBucket: envBool("S3_CREATE_BUCKET", false),
	})
	if err != nil {
		logger.Error("object storage configuration failed", "error", err)
		os.Exit(1)
	}

	hub := syncstream.NewHub()
	var realtime *messaging.Redis
	if redisURL := strings.TrimSpace(os.Getenv("REDIS_URL")); redisURL != "" {
		realtime, err = messaging.OpenRedis(context.Background(), redisURL)
		if err != nil {
			logger.Error("redis configuration failed", "error", err)
			os.Exit(1)
		}
		defer realtime.Close()
	}
	var documentProducer *messaging.Producer
	if brokers := messaging.Brokers(os.Getenv("REDPANDA_BROKERS")); len(brokers) > 0 {
		documentProducer = messaging.NewProducer(brokers)
		defer documentProducer.Close()
	}
	var notifier app.Notifier = hub
	if realtime != nil {
		notifier = nil
	}
	service := app.NewService(db, notifier)
	handler := httpapi.New(
		service,
		hub,
		env("DEFAULT_ACTOR_ID", fallbackActorID),
		envBool("ALLOW_DEMO_ACTOR_OVERRIDE", false),
		splitCSV(env("CORS_ALLOWED_ORIGINS", "http://localhost:3000")),
		logger,
		httpapi.Config{
			AuthRequired:     envBool("AUTH_REQUIRED", true),
			SecureCookies:    envBool("AUTH_COOKIE_SECURE", false),
			Attachments:      attachments,
			Realtime:         realtime,
			DocumentProducer: documentProducer,
		},
	)
	server := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       75 * time.Second,
		// WriteTimeout must remain zero for long-lived SSE responses.
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go cleanupAttachmentObjects(ctx, logger, db, attachments)
	if realtime != nil {
		go subscribeRealtime(ctx, logger, realtime, hub, handler)
	} else {
		go listenForDatabaseEvents(ctx, logger, db, hub)
	}
	go func() {
		logger.Info("api listening", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		_ = server.Close()
	}
}

func cleanupAttachmentObjects(ctx context.Context, logger *slog.Logger, db *database.Postgres, attachments objectstorage.Store) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		keys, err := db.ClaimAttachmentObjectCleanup(ctx, 25)
		if err != nil && ctx.Err() == nil {
			logger.Warn("attachment cleanup claim failed", "error", err)
		}
		for _, key := range keys {
			if err := attachments.Delete(ctx, key); err != nil {
				logger.Warn("attachment object cleanup failed", "error", err, "storage_key", key)
				_ = db.RetryAttachmentObjectCleanup(ctx, key)
				continue
			}
			if err := db.CompleteAttachmentObjectCleanup(ctx, key); err != nil && ctx.Err() == nil {
				logger.Warn("attachment cleanup completion failed", "error", err, "storage_key", key)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func subscribeRealtime(ctx context.Context, logger *slog.Logger, realtime *messaging.Redis, hub *syncstream.Hub, handler *httpapi.Handler) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := realtime.Subscribe(ctx, hub.PublishEvent, handler.PublishDocumentUpdate, handler.PublishPresence)
		if ctx.Err() != nil {
			return
		}
		logger.Warn("redis realtime subscriber disconnected", "error", err, "retry_in", backoff.String())
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 10*time.Second {
			backoff *= 2
		}
	}
}

func listenForDatabaseEvents(ctx context.Context, logger *slog.Logger, db *database.Postgres, hub *syncstream.Hub) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := db.Listen(ctx, hub.Publish)
		if ctx.Err() != nil {
			return
		}
		logger.Warn("database notification listener disconnected", "error", err, "retry_in", backoff.String())
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 10*time.Second {
			backoff *= 2
		}
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
