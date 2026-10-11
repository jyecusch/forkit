// Package telemetry sets up tracing and logging for the backend and accepts
// spans exported by the frontend, so one trace covers a whole round trip.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"

	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	"go.opentelemetry.io/otel/trace"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
	"gopkg.in/natefinch/lumberjack.v2"
)

// Config chooses where telemetry goes.
type Config struct {
	// Dir holds the rotating trace and log files.
	Dir string
	// OTLPEndpoint, when set, sends traces to an OTLP/HTTP collector instead
	// of the local trace file.
	OTLPEndpoint   string
	ServiceVersion string
}

// Telemetry owns the tracer provider and the destination spans are sent to.
type Telemetry struct {
	provider *sdktrace.TracerProvider
	client   otlptrace.Client
	logFile  io.Closer
	Logger   *slog.Logger
}

// Start configures tracing and logging. Call Shutdown to flush on exit.
func Start(ctx context.Context, cfg Config) (*Telemetry, error) {
	if err := os.MkdirAll(cfg.Dir, 0o755); err != nil {
		return nil, err
	}
	client := newClient(cfg)
	exporter, err := otlptrace.New(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("starting trace exporter: %w", err)
	}
	res := resource.NewSchemaless(
		semconv.ServiceName("forkit"),
		semconv.ServiceVersion(cfg.ServiceVersion),
	)
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	logFile := rotatingFile(filepath.Join(cfg.Dir, "forkit.log"))
	logger := slog.New(traceHandler{slog.NewJSONHandler(io.MultiWriter(os.Stderr, logFile), nil)})

	return &Telemetry{provider: provider, client: client, logFile: logFile, Logger: logger}, nil
}

func newClient(cfg Config) otlptrace.Client {
	if cfg.OTLPEndpoint != "" {
		return otlptracehttp.NewClient(otlptracehttp.WithEndpointURL(cfg.OTLPEndpoint))
	}
	return &fileClient{w: rotatingFile(filepath.Join(cfg.Dir, "traces.jsonl"))}
}

func rotatingFile(path string) *lumberjack.Logger {
	return &lumberjack.Logger{Filename: path, MaxSize: 20, MaxBackups: 3}
}

// Tracer returns a named tracer from the backend's provider.
func (t *Telemetry) Tracer(name string) trace.Tracer {
	return t.provider.Tracer(name)
}

// Ingest forwards spans the frontend encoded as an OTLP protobuf TracesData
// message to the same destination as backend spans.
func (t *Telemetry) Ingest(ctx context.Context, payload []byte) error {
	var data tracepb.TracesData
	if err := proto.Unmarshal(payload, &data); err != nil {
		return fmt.Errorf("decoding frontend spans: %w", err)
	}
	return t.client.UploadTraces(ctx, data.ResourceSpans)
}

// Shutdown flushes pending spans and closes files.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	return errors.Join(t.provider.Shutdown(ctx), t.logFile.Close())
}

var propagator = propagation.TraceContext{}

// ContextWithTraceparent continues the trace described by a W3C traceparent
// header value. An empty or malformed value leaves ctx unchanged.
func ContextWithTraceparent(ctx context.Context, traceparent string) context.Context {
	return propagator.Extract(ctx, propagation.MapCarrier{"traceparent": traceparent})
}

// Traceparent formats the span in ctx as a W3C traceparent header value, or
// returns "" when ctx has no span.
func Traceparent(ctx context.Context) string {
	carrier := propagation.MapCarrier{}
	propagator.Inject(ctx, carrier)
	return carrier["traceparent"]
}

// traceHandler adds the current trace and span IDs to every log record so
// logs can be correlated with traces.
type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, record slog.Record) error {
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		record.AddAttrs(
			slog.String("trace_id", span.TraceID().String()),
			slog.String("span_id", span.SpanID().String()),
		)
	}
	return h.Handler.Handle(ctx, record)
}

func (h traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(attrs)}
}

func (h traceHandler) WithGroup(name string) slog.Handler {
	return traceHandler{h.Handler.WithGroup(name)}
}
