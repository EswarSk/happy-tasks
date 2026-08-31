package objectstorage

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

type Config struct {
	Bucket       string
	Region       string
	Endpoint     string
	CreateBucket bool
}

type Object struct {
	Body         io.ReadCloser
	Length       int64
	LastModified time.Time
}

// Store is the task attachment object storage backend.
type Store interface {
	Put(ctx context.Context, key, contentType string, size int64, body io.Reader) error
	Get(ctx context.Context, key string) (Object, error)
	Delete(ctx context.Context, key string) error
}

// Open picks the backend from AWS_ACCESS_KEY_ID: set it (as MinIO locally and real
// AWS S3 in production both do) to get the S3 client, including any S3-compatible
// endpoint via config.Endpoint. Leave it unset to get Google Cloud Storage, using
// Application Default Credentials — the Cloud Run service's own identity in prod, no
// key management needed.
func Open(ctx context.Context, config Config) (Store, error) {
	config.Bucket = strings.TrimSpace(config.Bucket)
	if config.Bucket == "" {
		return nil, fmt.Errorf("S3_BUCKET is required")
	}
	if strings.TrimSpace(os.Getenv("AWS_ACCESS_KEY_ID")) != "" {
		return openS3(ctx, config)
	}
	return openGCS(ctx, config)
}
