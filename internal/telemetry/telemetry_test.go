package telemetry_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/jyecusch/forkit/internal/telemetry"
)

func TestIngestedAndBackendSpansShareTheTraceFile(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	tel, err := telemetry.Start(ctx, telemetry.Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}

	payload, err := proto.Marshal(&tracepb.TracesData{ResourceSpans: []*tracepb.ResourceSpans{{
		ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{{Name: "frontend.click"}}}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := tel.Ingest(ctx, payload); err != nil {
		t.Fatal(err)
	}
	_, span := tel.Tracer("test").Start(ctx, "backend.work")
	span.End()
	if err := tel.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	traces, err := os.ReadFile(filepath.Join(dir, "traces.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"frontend.click", "backend.work"} {
		if !strings.Contains(string(traces), name) {
			t.Errorf("trace file is missing %s:\n%s", name, traces)
		}
	}
}

func TestTraceparentRoundTrip(t *testing.T) {
	const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	ctx := telemetry.ContextWithTraceparent(context.Background(), traceparent)
	if got := telemetry.Traceparent(ctx); got != traceparent {
		t.Fatalf("got %q, want %q", got, traceparent)
	}
}
