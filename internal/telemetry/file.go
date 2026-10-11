package telemetry

import (
	"context"
	"io"
	"sync"

	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// fileClient writes each exported batch as one line of OTLP JSON.
type fileClient struct {
	mu sync.Mutex
	w  io.WriteCloser
}

func (c *fileClient) Start(context.Context) error { return nil }

func (c *fileClient) Stop(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.w.Close()
}

func (c *fileClient) UploadTraces(_ context.Context, spans []*tracepb.ResourceSpans) error {
	line, err := protojson.Marshal(&coltracepb.ExportTraceServiceRequest{ResourceSpans: spans})
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.w.Write(append(line, '\n'))
	return err
}
