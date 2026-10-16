package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"maps"
	"slices"
	"strings"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// finishedOperationTTL is how long a finished operation stays visible.
const finishedOperationTTL = 5 * time.Second

// progressInterval is the least time between published progress updates.
const progressInterval = 100 * time.Millisecond

// runOperation publishes an Operation for the duration of fn, so every view
// can show that the repository is busy, how far it has got and how it ended.
// fn reports progress through its second argument, and its context ends
// when the operation is cancelled.
func (r *openRepo) runOperation(ctx context.Context, kind model.OperationKind, worktree model.WorktreeID, fn func(context.Context, func(gitexec.Progress)) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	op := model.Operation{
		ID:         newOperationID(),
		RepoID:     r.loc.ID,
		WorktreeID: worktree,
		Kind:       kind,
		State:      model.OperationStateRunning,
		TraceID:    trace.SpanContextFromContext(ctx).TraceID().String(),
	}
	r.mu.Lock()
	r.cancels[op.ID] = cancel
	r.mu.Unlock()
	r.setOperation(ctx, op)

	err := fn(ctx, throttled(func(progress *model.OperationProgress) {
		op.Progress = progress
		r.setOperation(ctx, op)
	}))

	r.mu.Lock()
	delete(r.cancels, op.ID)
	r.mu.Unlock()
	op.State, op.Progress = model.OperationStateDone, nil
	switch {
	case err != nil && errors.Is(ctx.Err(), context.Canceled):
		op.State, err = model.OperationStateCancelled, context.Canceled
	case err != nil:
		op.State = model.OperationStateFailed
		rpcErr := apperr.ToRPC(err)
		op.Error = &rpcErr
	}
	ctx = context.WithoutCancel(ctx)
	r.setOperation(ctx, op)
	time.AfterFunc(finishedOperationTTL, func() { r.removeOperation(ctx, op.ID) })
	return err
}

// throttled passes progress on to report at most every progressInterval,
// except the end of each phase, which is always passed on.
func throttled(report func(*model.OperationProgress)) func(gitexec.Progress) {
	var lastReport time.Time
	return func(progress gitexec.Progress) {
		if progress.Current < progress.Total && time.Since(lastReport) < progressInterval {
			return
		}
		lastReport = time.Now()
		report(&model.OperationProgress{Phase: progress.Phase, Current: progress.Current, Total: progress.Total})
	}
}

// cancelOperation ends a running operation, killing its git process. It
// reports whether the operation was still running.
func (r *openRepo) cancelOperation(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	cancel, ok := r.cancels[id]
	if ok {
		cancel()
	}
	return ok
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

// CancelOperation stops a running operation, killing its git process. An
// operation that has already finished is left alone.
func (w *Workspace) CancelOperation(repoID model.RepoID, id string) error {
	r, err := w.repo(repoID)
	if err != nil {
		return err
	}
	r.cancelOperation(id)
	return nil
}
