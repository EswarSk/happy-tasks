package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	ProjectEventsTopic     = "happy-tasks-project-events"
	DocumentUpdatesTopic   = "happy-tasks-document-updates"
	projectEventsChannel   = "happy-tasks:project-events"
	documentUpdatesChannel = "happy-tasks:document-updates"
	presenceChannel        = "happy-tasks:presence"
	presenceLease          = 45 * time.Second
)

type DocumentUpdate struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	MessageID string `json:"messageId"`
	ActorID   string `json:"actorId"`
	Update    string `json:"update"`
	Text      string `json:"text,omitempty"`
}

type Presence struct {
	Type          string `json:"type"`
	SessionID     string `json:"sessionId"`
	ActorID       string `json:"actorId"`
	TaskID        string `json:"taskId,omitempty"`
	SelectionFrom int    `json:"selectionFrom,omitempty"`
	SelectionTo   int    `json:"selectionTo,omitempty"`
}

type presenceEnvelope struct {
	ProjectID string   `json:"projectId"`
	Presence  Presence `json:"presence"`
}

type Producer struct {
	projects  *kafka.Writer
	documents *kafka.Writer
}

func NewProducer(brokers []string) *Producer {
	writer := func(topic string) *kafka.Writer {
		return kafka.NewWriter(kafka.WriterConfig{
			Brokers: brokers, Topic: topic, Balancer: &kafka.Hash{},
			RequiredAcks: int(kafka.RequireAll), Async: false, BatchTimeout: 10 * time.Millisecond,
		})
	}
	return &Producer{projects: writer(ProjectEventsTopic), documents: writer(DocumentUpdatesTopic)}
}

func (p *Producer) PublishProjectEvent(ctx context.Context, event domain.Event) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return p.projects.WriteMessages(ctx, kafka.Message{Key: []byte(event.ProjectID), Value: payload})
}

func (p *Producer) PublishDocumentUpdate(ctx context.Context, update DocumentUpdate) error {
	payload, err := json.Marshal(update)
	if err != nil {
		return err
	}
	return p.documents.WriteMessages(ctx, kafka.Message{Key: []byte(update.ProjectID + ":" + update.TaskID), Value: payload})
}

func (p *Producer) Close() error {
	return errors.Join(p.projects.Close(), p.documents.Close())
}

type Redis struct {
	client *redis.Client
}

func OpenRedis(ctx context.Context, rawURL string) (*Redis, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	options.DialTimeout = 3 * time.Second
	options.ReadTimeout = 3 * time.Second
	options.WriteTimeout = 3 * time.Second
	client := redis.NewClient(options)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("connect redis: %w", err)
	}
	return &Redis{client: client}, nil
}

func (r *Redis) Close() error { return r.client.Close() }

func (r *Redis) PublishProjectEvent(ctx context.Context, payload []byte) error {
	return r.client.Publish(ctx, projectEventsChannel, payload).Err()
}

func (r *Redis) PublishDocumentUpdate(ctx context.Context, payload []byte) error {
	return r.client.Publish(ctx, documentUpdatesChannel, payload).Err()
}

func (r *Redis) Subscribe(ctx context.Context, projectEvent func(domain.Event), documentUpdate func(DocumentUpdate), presence func(string, Presence)) error {
	subscription := r.client.Subscribe(ctx, projectEventsChannel, documentUpdatesChannel, presenceChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		switch message.Channel {
		case projectEventsChannel:
			if projectEvent == nil {
				continue
			}
			var event domain.Event
			if json.Unmarshal([]byte(message.Payload), &event) == nil && event.ProjectID != "" && event.Sequence > 0 {
				projectEvent(event)
			}
		case documentUpdatesChannel:
			if documentUpdate == nil {
				continue
			}
			var update DocumentUpdate
			if json.Unmarshal([]byte(message.Payload), &update) == nil && update.ProjectID != "" && update.TaskID != "" && update.Update != "" {
				documentUpdate(update)
			}
		case presenceChannel:
			if presence == nil {
				continue
			}
			var envelope presenceEnvelope
			if json.Unmarshal([]byte(message.Payload), &envelope) == nil && envelope.ProjectID != "" && envelope.Presence.SessionID != "" {
				presence(envelope.ProjectID, envelope.Presence)
			}
		}
	}
}

func (r *Redis) PutPresence(ctx context.Context, projectID string, item Presence) error {
	item.Type = "presence"
	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	envelope, err := json.Marshal(presenceEnvelope{ProjectID: projectID, Presence: item})
	if err != nil {
		return err
	}
	dataKey, expiryKey := presenceKeys(projectID)
	expiresAt := float64(time.Now().Add(presenceLease).UnixMilli())
	pipe := r.client.TxPipeline()
	pipe.HSet(ctx, dataKey, item.SessionID, payload)
	pipe.ZAdd(ctx, expiryKey, redis.Z{Score: expiresAt, Member: item.SessionID})
	pipe.Expire(ctx, dataKey, 24*time.Hour)
	pipe.Expire(ctx, expiryKey, 24*time.Hour)
	pipe.Publish(ctx, presenceChannel, envelope)
	_, err = pipe.Exec(ctx)
	return err
}

func (r *Redis) RemovePresence(ctx context.Context, projectID string, item Presence) error {
	item.Type = "leave"
	envelope, err := json.Marshal(presenceEnvelope{ProjectID: projectID, Presence: item})
	if err != nil {
		return err
	}
	dataKey, expiryKey := presenceKeys(projectID)
	pipe := r.client.TxPipeline()
	pipe.HDel(ctx, dataKey, item.SessionID)
	pipe.ZRem(ctx, expiryKey, item.SessionID)
	pipe.Publish(ctx, presenceChannel, envelope)
	_, err = pipe.Exec(ctx)
	return err
}

func (r *Redis) ListPresence(ctx context.Context, projectID string) ([]Presence, error) {
	dataKey, expiryKey := presenceKeys(projectID)
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	expired, err := r.client.ZRangeByScore(ctx, expiryKey, &redis.ZRangeBy{Min: "-inf", Max: now}).Result()
	if err != nil {
		return nil, err
	}
	if len(expired) > 0 {
		members := make([]any, len(expired))
		for index, id := range expired {
			members[index] = id
		}
		pipe := r.client.TxPipeline()
		pipe.ZRem(ctx, expiryKey, members...)
		pipe.HDel(ctx, dataKey, expired...)
		_, _ = pipe.Exec(ctx)
	}
	ids, err := r.client.ZRangeByScore(ctx, expiryKey, &redis.ZRangeBy{Min: "(" + now, Max: "+inf"}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	values, err := r.client.HMGet(ctx, dataKey, ids...).Result()
	if err != nil {
		return nil, err
	}
	items := make([]Presence, 0, len(values))
	for _, value := range values {
		encoded, ok := value.(string)
		if !ok {
			continue
		}
		var item Presence
		if json.Unmarshal([]byte(encoded), &item) == nil {
			items = append(items, item)
		}
	}
	return items, nil
}

func presenceKeys(projectID string) (string, string) {
	prefix := "happy-tasks:presence:" + projectID
	return prefix + ":data", prefix + ":expiry"
}

func Brokers(value string) []string {
	parts := strings.Split(value, ",")
	brokers := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			brokers = append(brokers, part)
		}
	}
	return brokers
}

func RunDistributor(ctx context.Context, brokers []string, fanout *Redis, topic string) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: brokers, Topic: topic, GroupID: "happy-tasks-realtime-distributor-" + topic,
		MinBytes: 1, MaxBytes: 4 << 20, CommitInterval: 0,
	})
	defer reader.Close()
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		switch topic {
		case ProjectEventsTopic:
			err = fanout.PublishProjectEvent(ctx, message.Value)
		case DocumentUpdatesTopic:
			err = fanout.PublishDocumentUpdate(ctx, message.Value)
		default:
			err = errors.New("unsupported distributor topic")
		}
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, message); err != nil {
			return err
		}
	}
}
