package synchub_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/synchub"
)

type recordingEmitter struct{ deltas []model.SyncDelta }

func (r *recordingEmitter) Emit(_ string, payload any) {
	r.deltas = append(r.deltas, payload.(model.SyncDelta))
}

type item struct {
	ID    string `json:"id"`
	Value int    `json:"value"`
}

func newChannel() (synchub.Channel[item], *synchub.Hub, *recordingEmitter) {
	emitter := &recordingEmitter{}
	hub := synchub.New(emitter, noop.NewTracerProvider().Tracer(""))
	return synchub.NewChannel(hub, "items", func(i item) string { return i.ID }), hub, emitter
}

func TestPublishEmitsOnlyChanges(t *testing.T) {
	ctx := context.Background()
	items, _, emitter := newChannel()

	_ = items.Publish(ctx, "s", []item{{"a", 1}, {"b", 1}})
	_ = items.Publish(ctx, "s", []item{{"a", 1}, {"b", 2}, {"c", 1}})
	_ = items.Publish(ctx, "s", []item{{"a", 1}, {"b", 2}, {"c", 1}})
	_ = items.Publish(ctx, "s", []item{{"b", 2}})

	var got [][]string
	for _, delta := range emitter.deltas {
		var ops []string
		for _, op := range delta.Ops {
			ops = append(ops, string(op.Type)+":"+op.Key)
		}
		got = append(got, ops)
	}
	want := [][]string{{"insert:a", "insert:b"}, {"update:b", "insert:c"}, {"delete:a", "delete:c"}}
	if !slices.EqualFunc(got, want, slices.Equal) {
		t.Fatalf("got deltas %v, want %v", got, want)
	}
}

func TestDeltasChainFromSnapshotSeq(t *testing.T) {
	ctx := context.Background()
	items, hub, emitter := newChannel()

	_ = items.Publish(ctx, "s", []item{{"a", 1}})
	snapshot := hub.Subscribe("items", "s")
	_ = items.Publish(ctx, "s", []item{{"a", 2}})

	next := emitter.deltas[len(emitter.deltas)-1]
	if next.PrevSeq != snapshot.Seq {
		t.Fatalf("delta prevSeq %d does not follow snapshot seq %d", next.PrevSeq, snapshot.Seq)
	}
	var entity item
	if err := json.Unmarshal(snapshot.Entities[0].(json.RawMessage), &entity); err != nil || entity.Value != 1 {
		t.Fatalf("snapshot entity = %+v, %v", entity, err)
	}
}

func TestScopesAreIndependent(t *testing.T) {
	ctx := context.Background()
	items, hub, _ := newChannel()

	_ = items.Publish(ctx, "one", []item{{"a", 1}})
	items.Drop(ctx, "two")

	if got := len(hub.Subscribe("items", "one").Entities); got != 1 {
		t.Fatalf("scope one has %d entities, want 1", got)
	}
}
