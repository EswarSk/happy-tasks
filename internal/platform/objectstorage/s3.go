package objectstorage

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type S3 struct {
	client *s3.Client
	bucket string
}

var _ Store = (*S3)(nil)

func openS3(ctx context.Context, config Config) (*S3, error) {
	if config.Region == "" {
		config.Region = "us-east-1"
	}
	awsConfig, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.Region))
	if err != nil {
		return nil, fmt.Errorf("load S3 configuration: %w", err)
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		if endpoint := strings.TrimSpace(config.Endpoint); endpoint != "" {
			options.BaseEndpoint = aws.String(endpoint)
			options.UsePathStyle = true
		}
	})
	store := &S3{client: client, bucket: config.Bucket}
	if err := store.ensureBucket(ctx, config.CreateBucket); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *S3) ensureBucket(ctx context.Context, create bool) error {
	if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)}); err == nil {
		return nil
	} else if !create {
		return fmt.Errorf("access S3 bucket %q: %w", s.bucket, err)
	}
	if _, err := s.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}); err != nil {
		if _, headErr := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)}); headErr != nil {
			return fmt.Errorf("create S3 bucket %q: %w", s.bucket, err)
		}
	}
	return nil
}

func (s *S3) Put(ctx context.Context, key, contentType string, size int64, body io.Reader) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	})
	if err != nil {
		return fmt.Errorf("put attachment object: %w", err)
	}
	return nil
}

func (s *S3) Get(ctx context.Context, key string) (Object, error) {
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return Object{}, fmt.Errorf("get attachment object: %w", err)
	}
	return Object{Body: result.Body, Length: aws.ToInt64(result.ContentLength), LastModified: aws.ToTime(result.LastModified)}, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return fmt.Errorf("delete attachment object: %w", err)
	}
	return nil
}
