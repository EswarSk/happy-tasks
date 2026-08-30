package messaging

import (
	"reflect"
	"testing"
	"time"
)

func TestBrokersDropsEmptyAddresses(t *testing.T) {
	want := []string{"redpanda-1:9092", "redpanda-2:9092"}
	if got := Brokers(" redpanda-1:9092, ,redpanda-2:9092 "); !reflect.DeepEqual(got, want) {
		t.Fatalf("Brokers() = %#v, want %#v", got, want)
	}
}

func TestProducerUsesRealtimeBatchWindow(t *testing.T) {
	producer := NewProducer([]string{"redpanda:9092"})
	if producer.documents.BatchTimeout != 10*time.Millisecond {
		t.Fatalf("document batch timeout = %s, want 10ms", producer.documents.BatchTimeout)
	}
}
