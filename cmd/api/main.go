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
	"github.com/eswaravegi/happy-task-management/internal/platform/database"
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

	hub := syncstream.NewHub()
	service := app.NewService(db, hub)
	handler := httpapi.New(
		service,
		hub,
		env("DEFAULT_ACTOR_ID", fallbackActorID),
		envBool("ALLOW_DEMO_ACTOR_OVERRIDE", false),
		splitCSV(env("CORS_ALLOWED_ORIGINS", "http://localhost:3000")),
		logger,
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
	go listenForDatabaseEvents(ctx, logger, db, hub)
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
