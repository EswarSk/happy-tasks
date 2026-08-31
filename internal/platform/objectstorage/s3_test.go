package objectstorage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestOpenRequiresBucket(t *testing.T) {
	if _, err := Open(context.Background(), Config{}); err == nil {
		t.Fatal("expected error for empty bucket")
	}
}

func TestS3ObjectLifecycle(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	var mu sync.Mutex
	objects := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/attachments" && r.Method == http.MethodHead {
			return
		}
		if r.URL.Path != "/attachments/project/task/file" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			objects[r.URL.Path], _ = io.ReadAll(r.Body)
		case http.MethodGet:
			body, ok := objects[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Length", "5")
			_, _ = w.Write(body)
		case http.MethodDelete:
			delete(objects, r.URL.Path)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	store, err := Open(context.Background(), Config{Bucket: "attachments", Region: "us-east-1", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), "project/task/file", "text/plain", 5, bytes.NewReader([]byte("hello"))); err != nil {
		t.Fatal(err)
	}
	object, err := store.Get(context.Background(), "project/task/file")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(object.Body)
	_ = object.Body.Close()
	if err != nil || string(body) != "hello" || object.Length != 5 {
		t.Fatalf("download = %q, length = %d, error = %v", body, object.Length, err)
	}
	if err := store.Delete(context.Background(), "project/task/file"); err != nil {
		t.Fatal(err)
	}
}
