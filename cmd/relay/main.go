package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/eswaravegi/happy-task-management/internal/messaging"
	"github.com/eswaravegi/happy-task-management/internal/platform/database"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := database.Open(ctx, required("DATABASE_URL"))
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	redis, err := messaging.OpenRedis(ctx, required("REDIS_URL"))
	if err != nil {
		logger.Error("open redis", "error", err)
		os.Exit(1)
	}
	defer redis.Close()
	producer := messaging.NewProducer(messaging.Brokers(required("REDPANDA_BROKERS")))
	defer producer.Close()

	errorsCh := make(chan error, 3)
	go func() { errorsCh <- publishOutbox(ctx, db, producer) }()
	go func() {
		errorsCh <- messaging.RunDistributor(ctx, messaging.Brokers(required("REDPANDA_BROKERS")), redis, messaging.ProjectEventsTopic)
	}()
	go func() {
		errorsCh <- messaging.RunDistributor(ctx, messaging.Brokers(required("REDPANDA_BROKERS")), redis, messaging.DocumentUpdatesTopic)
	}()
	if err := <-errorsCh; err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("relay stopped", "error", err)
		os.Exit(1)
	}
}

func publishOutbox(ctx context.Context, db *database.Postgres, producer *messaging.Producer) error {
	for ctx.Err() == nil {
		count, err := db.PublishOutboxBatch(ctx, 100, func(event domain.Event) error {
			return producer.PublishProjectEvent(ctx, event)
		})
		if err != nil {
			return err
		}
		if count == 0 {
			timer := time.NewTimer(100 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
	return ctx.Err()
}

func required(key string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		panic(key + " is required")
	}
	return value
}
