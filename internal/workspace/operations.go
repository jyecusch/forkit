package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"maps"
	"slices"
	"strings"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/model"
)

// finishedOperationTTL is how long a finished operation stays visible.
const finishedOperationTTL = 5 * time.Second

// runOperation publishes an Operation for the duration of fn, so every view
// can show that the repository is busy and how it ended.
func (r *openRepo) runOperation(ctx context.Context, kind model.OperationKind, worktree model.WorktreeID, fn func(context.Context) error) error {
	op := model.Operation{
		ID:         newOperationID(),
		RepoID:     r.loc.ID,
		WorktreeID: worktree,
		Kind:       kind,
		State:      model.OperationStateRunning,
		TraceID:    trace.SpanContextFromContext(ctx).TraceID().String(),
	}
	r.setOperation(ctx, op)

	err := fn(ctx)
	op.State = model.OperationStateDone
	if err != nil {
		op.State = model.OperationStateFailed
		rpcErr := apperr.ToRPC(err)
		op.Error = &rpcErr
	}
	r.setOperation(ctx, op)
	time.AfterFunc(finishedOperationTTL, func() { r.removeOperation(context.WithoutCancel(ctx), op.ID) })
	return err
}

func (r *openRepo) setOperation(ctx context.Context, op model.Operation) {
	r.mu.Lock()
	r.operations[op.ID] = op
	r.mu.Unlock()
	r.publishOperations(ctx)
}

func (r *openRepo) removeOperation(ctx context.Context, id string) {
	r.mu.Lock()
	delete(r.operations, id)
	r.mu.Unlock()
	r.publishOperations(ctx)
}

// publishOperations publishes under mu, so it cannot race close, which drops
// the scope under mu after cancelling the lifetime.
func (r *openRepo) publishOperations(ctx context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lifetime.Err() != nil {
		return
	}
	ops := slices.SortedFunc(maps.Values(r.operations), func(a, b model.Operation) int { return strings.Compare(a.ID, b.ID) })
	if err := r.ws.channels.Operations.Publish(ctx, string(r.loc.ID), ops); err != nil {
		r.ws.logger.ErrorContext(ctx, "publishing operations failed", "error", err)
	}
}

func newOperationID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
