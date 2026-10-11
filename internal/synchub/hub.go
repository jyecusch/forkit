// Package synchub keeps the backend's view of each synced collection and
// pushes sequenced deltas to the frontend whenever it changes.
//
// Producers publish the complete current state of a channel scope; the hub
// diffs it against what it last sent, so producers never track changes
// themselves. A client takes a snapshot with Subscribe and then applies
// deltas whose prevSeq matches the last seq it saw, resubscribing on a gap.
package synchub

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/telemetry"
)

// Emitter delivers an event to the frontend.
type Emitter interface {
	Emit(event string, payload any)
}

// Hub stores the last published state of every channel scope.
type Hub struct {
	emitter Emitter
	tracer  trace.Tracer

	mu     sync.Mutex
	scopes map[scopeKey]*scopeState
}

type scopeKey struct{ channel, scope string }

type scopeState struct {
	seq      int
	entities map[string]json.RawMessage
}

func New(emitter Emitter, tracer trace.Tracer) *Hub {
	return &Hub{emitter: emitter, tracer: tracer, scopes: map[scopeKey]*scopeState{}}
}

// EventName is the event a channel scope's deltas are emitted on.
func EventName(channel, scope string) string {
	return fmt.Sprintf("sync:%s:%s", channel, scope)
}

// Subscribe returns the current entities of a channel scope, ordered by key,
// and the seq the next delta will follow.
func (h *Hub) Subscribe(channel, scope string) model.SyncSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.scopes[scopeKey{channel, scope}]
	if state == nil {
		return model.SyncSnapshot{}
	}
	keys := make([]string, 0, len(state.entities))
	for key := range state.entities {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	entities := make([]any, len(keys))
	for i, key := range keys {
		entities[i] = state.entities[key]
	}
	return model.SyncSnapshot{Seq: state.seq, Entities: entities}
}

func (h *Hub) replace(ctx context.Context, channel, scope string, next map[string]json.RawMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := scopeKey{channel, scope}
	state := h.scopes[key]
	if state == nil {
		state = &scopeState{entities: map[string]json.RawMessage{}}
		h.scopes[key] = state
	}
	ops := diff(state.entities, next)
	if len(ops) == 0 {
		return
	}

	ctx, span := h.tracer.Start(ctx, "sync.emit", trace.WithAttributes(
		attribute.String("sync.channel", channel),
		attribute.String("sync.scope", scope),
		attribute.Int("sync.ops", len(ops)),
	))
	defer span.End()

	delta := model.SyncDelta{Seq: state.seq + 1, PrevSeq: state.seq, Traceparent: telemetry.Traceparent(ctx), Ops: ops}
	state.seq = delta.Seq
	state.entities = next
	if state.entities == nil {
		state.entities = map[string]json.RawMessage{}
	}
	h.emitter.Emit(EventName(channel, scope), delta)
}

func diff(prev, next map[string]json.RawMessage) []model.SyncOp {
	var ops []model.SyncOp
	for key, value := range next {
		old, existed := prev[key]
		switch {
		case !existed:
			ops = append(ops, model.SyncOp{Type: model.SyncOpTypeInsert, Key: key, Value: value})
		case !bytes.Equal(old, value):
			ops = append(ops, model.SyncOp{Type: model.SyncOpTypeUpdate, Key: key, Value: value})
		}
	}
	for key := range prev {
		if _, kept := next[key]; !kept {
			ops = append(ops, model.SyncOp{Type: model.SyncOpTypeDelete, Key: key})
		}
	}
	slices.SortFunc(ops, func(a, b model.SyncOp) int { return cmp.Compare(a.Key, b.Key) })
	return ops
}

// Channel publishes one entity type. Each scope of a channel (usually a repo
// or worktree ID) is synced independently.
type Channel[T any] struct {
	hub  *Hub
	name string
	key  func(T) string
}

// NewChannel registers a channel whose entities are identified by key.
func NewChannel[T any](hub *Hub, name string, key func(T) string) Channel[T] {
	return Channel[T]{hub: hub, name: name, key: key}
}

// Name identifies the channel in subscriptions and event names.
func (c Channel[T]) Name() string { return c.name }

// Publish replaces the scope's entities with items and emits whatever changed.
func (c Channel[T]) Publish(ctx context.Context, scope string, items []T) error {
	next := make(map[string]json.RawMessage, len(items))
	for _, item := range items {
		encoded, err := json.Marshal(item)
		if err != nil {
			return fmt.Errorf("encoding %s entity: %w", c.name, err)
		}
		next[c.key(item)] = encoded
	}
	c.hub.replace(ctx, c.name, scope, next)
	return nil
}

// Drop deletes all of the scope's entities.
func (c Channel[T]) Drop(ctx context.Context, scope string) {
	c.hub.replace(ctx, c.name, scope, nil)
}
