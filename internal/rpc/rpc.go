// Package rpc exposes the backend to the frontend as Wails-bound services.
// Every call continues the caller's trace and fails with an encoded
// model.RpcError, which the frontend decodes into a tagged error.
package rpc

import (
	"context"
	"encoding/json"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/avatars"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/internal/telemetry"
	"github.com/jyecusch/forkit/internal/workspace"
)

// Deps are what the services need. They exist only once the app has
// started, after the services have been bound.
type Deps struct {
	Ctx       context.Context
	Hub       *synchub.Hub
	Workspace *workspace.Workspace
	Prefs     *prefs.Store
	Session   *prefs.SessionStore
	Telemetry *telemetry.Telemetry
	Gravatar  *avatars.Gravatar
	Tracer    trace.Tracer
	// ChooseDirectory shows a native folder picker and returns "" if the
	// user cancels.
	ChooseDirectory func(title string) (string, error)
}

// Server holds the services to bind.
type Server struct {
	deps *Deps

	Sync        *Sync
	Telemetry   *Telemetry
	Repos       *Repos
	Preferences *Preferences
	Session     *Session
	Worktrees   *Worktrees
	Avatars     *Avatars
}

// NewServer creates the services. Call Start before the frontend can call
// them.
func NewServer() *Server {
	s := &Server{}
	s.Sync = &Sync{s}
	s.Telemetry = &Telemetry{s}
	s.Repos = &Repos{s}
	s.Preferences = &Preferences{s}
	s.Session = &Session{s}
	s.Worktrees = &Worktrees{s}
	s.Avatars = &Avatars{s}
	return s
}

// Start provides the dependencies the services call into.
func (s *Server) Start(deps *Deps) { s.deps = deps }

// Services lists the structs to bind with Wails.
func (s *Server) Services() []any {
	return []any{s.Sync, s.Telemetry, s.Repos, s.Preferences, s.Session, s.Worktrees, s.Avatars}
}

// callError is a model.RpcError encoded as JSON, which is how Wails passes
// an error's text to the rejected promise.
type callError struct{ model.RpcError }

func (e callError) Error() string {
	encoded, _ := json.Marshal(e.RpcError)
	return string(encoded)
}

func call[T any](s *Server, meta model.CallMeta, method string, fn func(context.Context) (T, error), attrs ...attribute.KeyValue) (T, error) {
	ctx := telemetry.ContextWithTraceparent(s.deps.Ctx, meta.Traceparent)
	ctx, span := s.deps.Tracer.Start(ctx, "rpc "+method, trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(attrs, attribute.String("rpc.method", method))...))
	defer span.End()
	result, err := fn(ctx)
	if err != nil {
		rpcErr := apperr.ToRPC(err)
		span.RecordError(err)
		span.SetStatus(codes.Error, string(rpcErr.Code))
		return result, callError{rpcErr}
	}
	return result, nil
}

func callNoResult(s *Server, meta model.CallMeta, method string, fn func(context.Context) error, attrs ...attribute.KeyValue) error {
	_, err := call(s, meta, method, func(ctx context.Context) (struct{}, error) {
		return struct{}{}, fn(ctx)
	}, attrs...)
	return err
}
