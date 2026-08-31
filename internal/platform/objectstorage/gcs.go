package objectstorage

import (
	"context"
	"errors"
	"fmt"
	"io"

	"cloud.google.com/go/storage"
)

// GCS stores attachments in Google Cloud Storage using Application Default
// Credentials — the Cloud Run service's own identity in production, so there are
// no keys to create, store, or rotate.
type GCS struct {
	client *storage.Client
	bucket string
}

var _ Store = (*GCS)(nil)

func openGCS(ctx context.Context, config Config) (*GCS, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("open GCS client: %w", err)
	}
	store := &GCS{client: client, bucket: config.Bucket}
	if err := store.ensureBucket(ctx, config.CreateBucket); err != nil {
		return nil, err
	}
	return store, nil
}

func (g *GCS) ensureBucket(ctx context.Context, create bool) error {
	if _, err := g.client.Bucket(g.bucket).Attrs(ctx); err == nil {
		return nil
	} else if !errors.Is(err, storage.ErrBucketNotExist) {
		return fmt.Errorf("access GCS bucket %q: %w", g.bucket, err)
	} else if !create {
		return fmt.Errorf("access GCS bucket %q: %w", g.bucket, err)
	}
	return fmt.Errorf("GCS bucket %q does not exist: bucket auto-create is not supported for GCS, pre-create it (deploy.sh does this)", g.bucket)
}

func (g *GCS) Put(ctx context.Context, key, contentType string, _ int64, body io.Reader) error {
	writer := g.client.Bucket(g.bucket).Object(key).NewWriter(ctx)
	writer.ContentType = contentType
	if _, err := io.Copy(writer, body); err != nil {
		_ = writer.Close()
		return fmt.Errorf("put attachment object: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("put attachment object: %w", err)
	}
	return nil
}

func (g *GCS) Get(ctx context.Context, key string) (Object, error) {
	reader, err := g.client.Bucket(g.bucket).Object(key).NewReader(ctx)
	if err != nil {
		return Object{}, fmt.Errorf("get attachment object: %w", err)
	}
	return Object{Body: reader, Length: reader.Size(), LastModified: reader.Attrs.LastModified}, nil
}

func (g *GCS) Delete(ctx context.Context, key string) error {
	if err := g.client.Bucket(g.bucket).Object(key).Delete(ctx); err != nil {
		return fmt.Errorf("delete attachment object: %w", err)
	}
	return nil
}
