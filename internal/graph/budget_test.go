package graph_test

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/graph"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
)

// firstRowsEmitter signals when a graph view with rows is first published
// and remembers the latest one.
type firstRowsEmitter struct {
	shown  chan struct{}
	latest json.RawMessage
}

func (e *firstRowsEmitter) Emit(_ string, payload any) {
	delta := payload.(model.SyncDelta)
	if len(delta.Ops) == 0 {
		return
	}
	e.latest = delta.Ops[0].Value.(json.RawMessage)
	if e.shown != nil {
		close(e.shown)
		e.shown = nil
	}
}

// TestLargeRepoBudgets checks the performance budgets against the repository
// in FORKIT_BENCH_REPO, such as a Linux kernel clone or one made with
// tools/synthrepo.
func TestLargeRepoBudgets(t *testing.T) {
	path := os.Getenv("FORKIT_BENCH_REPO")
	if path == "" {
		t.Skip("set FORKIT_BENCH_REPO to a large repository")
	}
	ctx := context.Background()
	tracer := noop.NewTracerProvider().Tracer("")
	git, err := gitexec.New(ctx, "", tracer)
	if err != nil {
		t.Fatal(err)
	}
	loc, err := repo.Locate(ctx, git, path)
	if err != nil {
		t.Fatal(err)
	}
	remotes, _ := repo.ListRemotes(ctx, git, loc)
	refs, err := repo.ListRefs(ctx, git, loc, remotes)
	if err != nil {
		t.Fatal(err)
	}

	emitter := &firstRowsEmitter{shown: make(chan struct{})}
	shown := emitter.shown
	channel := synchub.NewChannel(synchub.New(emitter, tracer), "graphViews", func(v model.GraphView) string { return string(v.ID) })
	view := graph.NewView(ctx, loc.ID, git.Repo(loc.CommonDir, loc.WorkDir), channel, tracer)
	defer view.Close()
	options := graph.Options{Order: model.GraphOrderTopo, IncludeRemotes: true, IncludeTags: true}

	start := time.Now()
	done := make(chan error)
	go func() { done <- view.Refresh(ctx, refs, nil, options) }()
	<-shown
	if _, err := view.Window(ctx, 0, 500, ""); err != nil {
		t.Fatal(err)
	}
	report(t, "first window", time.Since(start), 300*time.Millisecond)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	report(t, "full history", time.Since(start), 0)
	var shape model.GraphView
	_ = json.Unmarshal(emitter.latest, &shape)
	t.Logf("rows: %d, lanes: %d, refs: %d", shape.TotalRows, shape.LaneCount, len(refs))

	runtime.GC()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	t.Logf("heap in use: %d MB (budget 150 MB)", mem.HeapInuse>>20)

	deep := time.Now()
	if _, err := view.Window(ctx, shape.TotalRows*3/4, 500, ""); err != nil {
		t.Fatal(err)
	}
	report(t, "deep window", time.Since(deep), 50*time.Millisecond)

	var branch model.RefID
	for _, ref := range refs {
		if ref.Kind == model.RefKindLocalBranch {
			branch = ref.ID
			break
		}
	}
	emphasis := time.Now()
	if _, err := view.Window(ctx, 0, 500, branch); err != nil {
		t.Fatal(err)
	}
	report(t, "emphasis switch", time.Since(emphasis), 50*time.Millisecond)
}

func report(t *testing.T, what string, took, budget time.Duration) {
	t.Helper()
	if budget > 0 && took > budget {
		t.Errorf("%s took %v, budget %v", what, took, budget)
		return
	}
	t.Logf("%s: %v", what, took)
}
