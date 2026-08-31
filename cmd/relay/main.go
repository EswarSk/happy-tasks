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

	// Each pipeline is supervised independently: a broker problem confined to one
	// topic (a missing topic, a rebalance) must not take down the other two. A
	// shared fatal error channel here previously meant one bad topic crash-looped
	// outbox publishing and event distribution along with it.
	go supervise(ctx, logger, "outbox", func() error { return publishOutbox(ctx, db, producer) })
	go supervise(ctx, logger, "project-events-distributor", func() error {
		return messaging.RunDistributor(ctx, messaging.Brokers(required("REDPANDA_BROKERS")), redis, messaging.ProjectEventsTopic)
	})
	go supervise(ctx, logger, "document-updates-distributor", func() error {
		return messaging.RunDistributor(ctx, messaging.Brokers(required("REDPANDA_BROKERS")), redis, messaging.DocumentUpdatesTopic)
	})
	<-ctx.Done()
}

// supervise restarts run with capped exponential backoff until ctx is done,
// so one pipeline's persistent failure degrades to periodic retries instead
// of exiting the process and taking the other pipelines down with it.
func supervise(ctx context.Context, logger *slog.Logger, name string, run func() error) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := run()
		if err == nil || errors.Is(err, context.Canceled) {
			return
		}
		logger.Error(name+" stopped, retrying", "error", err, "backoff", backoff.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
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
