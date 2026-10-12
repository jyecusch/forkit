// Package perf checks the backend against the performance budgets on large
// repositories generated with tools/synthrepo, or any repository named by
// FORKIT_PERF_REPO. The tests are skipped when it is unset.
//
//	go run ./tools/synthrepo -profile busy-branches -out test-repos/busy
//	FORKIT_PERF_REPO=$PWD/test-repos/busy/repo go test ./internal/perf -v
package perf

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/internal/workspace"
)

const (
	firstWindowBudget = 300 * time.Millisecond
	changeBudget      = 100 * time.Millisecond
	emphasisBudget    = 50 * time.Millisecond
	memoryBudgetMB    = 150
	windowRows        = 500
)

// deltaWaiter lets a test wait for the next delta on an event that satisfies
// a condition.
type deltaWaiter struct {
	mu      sync.Mutex
	waiters []waiter
	latest  map[string]json.RawMessage
}

type waiter struct {
	event string
	match func(json.RawMessage) bool
	done  chan time.Time
}

func (d *deltaWaiter) Emit(event string, payload any) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, op := range payload.(model.SyncDelta).Ops {
		value, _ := op.Value.(json.RawMessage)
		d.latest[event] = value
		d.waiters = slices.DeleteFunc(d.waiters, func(w waiter) bool {
			if w.event == event && value != nil && w.match(value) {
				w.done <- time.Now()
				return true
			}
			return false
		})
	}
}

// expect registers interest before the action that should cause the delta.
// The returned function waits for it and reports how long after since it
// arrived.
func (d *deltaWaiter) expect(event string, match func(json.RawMessage) bool) func(t *testing.T, since time.Time) time.Duration {
	done := make(chan time.Time, 1)
	d.mu.Lock()
	d.waiters = append(d.waiters, waiter{event: event, match: match, done: done})
	d.mu.Unlock()
	return func(t *testing.T, since time.Time) time.Duration {
		t.Helper()
		select {
		case at := <-done:
			return at.Sub(since)
		case <-time.After(30 * time.Second):
			t.Fatalf("timed out waiting for %s", event)
			return 0
		}
	}
}

func anyDelta(json.RawMessage) bool { return true }

func TestBackendBudgets(t *testing.T) {
	path := os.Getenv("FORKIT_PERF_REPO")
	if path == "" {
		t.Skip("set FORKIT_PERF_REPO to a repository made with tools/synthrepo")
	}
	ctx := context.Background()
	spans := tracetest.NewSpanRecorder()
	tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans)).Tracer("perf")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	deltas := &deltaWaiter{latest: map[string]json.RawMessage{}}
	hub := synchub.New(deltas, tracer)
	git, err := gitexec.New(ctx, "", tracer)
	if err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	store, err := prefs.OpenStore(ctx, configDir, synchub.NewChannel(hub, "preferences", func(p model.Preferences) string { return p.ID }), logger)
	if err != nil {
		t.Fatal(err)
	}
	session, err := prefs.OpenSessionStore(ctx, configDir, synchub.NewChannel(hub, "session", func(s model.Session) string { return s.ID }), logger)
	if err != nil {
		t.Fatal(err)
	}
	ws := workspace.New(git, workspace.NewChannels(hub), store, session, tracer, logger)
	defer ws.Shutdown(ctx)

	// Opening: the budget runs from the request to having a window of rows
	// ready for the first paint.
	loc, err := repo.Locate(ctx, git, path)
	if err != nil {
		t.Fatal(err)
	}
	graphEvent := synchub.EventName("graphViews", string(loc.ID))
	reposEvent := synchub.EventName("repos", workspace.ReposScope)
	start := time.Now()
	ready := deltas.expect(reposEvent, func(v json.RawMessage) bool { return strings.Contains(string(v), `"state":"ready"`) })
	shown := deltas.expect(graphEvent, func(v json.RawMessage) bool { return !strings.Contains(string(v), `"totalRows":0`) })
	complete := deltas.expect(graphEvent, func(v json.RawMessage) bool { return strings.Contains(string(v), `"complete":true`) })
	if _, err := ws.Open(ctx, path); err != nil {
		t.Fatal(err)
	}
	shown(t, start)
	view, err := ws.Graph(loc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := view.Window(ctx, 0, windowRows, ""); err != nil {
		t.Fatal(err)
	}
	check(t, "open to first window", time.Since(start), firstWindowBudget)
	t.Logf("full history loaded after %v", complete(t, start).Round(time.Millisecond))
	ready(t, start)

	var shape model.GraphView
	deltas.mu.Lock()
	_ = json.Unmarshal(deltas.latest[graphEvent], &shape)
	deltas.mu.Unlock()
	t.Logf("%d rows, %d lanes", shape.TotalRows, shape.LaneCount)

	runtime.GC()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	if heap := mem.HeapInuse >> 20; heap > memoryBudgetMB {
		t.Errorf("heap in use %d MB, budget %d MB", heap, memoryBudgetMB)
	} else {
		t.Logf("heap in use: %d MB", heap)
	}

	t.Run("deep window", func(t *testing.T) {
		start := time.Now()
		if _, err := view.Window(ctx, shape.TotalRows*3/4, windowRows, ""); err != nil {
			t.Fatal(err)
		}
		check(t, "deep window", time.Since(start), emphasisBudget)
		logSpans(t, spans, start)
	})

	t.Run("emphasis switch", func(t *testing.T) {
		mainRef := model.RefID(string(loc.ID) + ":refs/heads/main")
		start := time.Now()
		if _, err := view.Window(ctx, 0, windowRows, mainRef); err != nil {
			t.Fatal(err)
		}
		check(t, "emphasis switch", time.Since(start), emphasisBudget)
	})

	t.Run("file edit to status", func(t *testing.T) {
		file := filepath.Join(path, "forkit-perf-edit.txt")
		t.Cleanup(func() { os.Remove(file) })
		waitIdle()
		updated := deltas.expect(synchub.EventName("worktrees", string(loc.ID)), anyDelta)
		since := time.Now()
		if err := os.WriteFile(file, []byte("edit"), 0o644); err != nil {
			t.Fatal(err)
		}
		check(t, "file edit to status update", updated(t, since), changeBudget)
		logSpans(t, spans, since)
	})

	t.Run("installing dependencies", func(t *testing.T) {
		if _, err := os.Stat(filepath.Join(path, "node_modules")); err != nil {
			t.Skip("the repository has no node_modules")
		}
		pkg := filepath.Join(path, "node_modules", "forkit-perf-install")
		t.Cleanup(func() { os.RemoveAll(pkg) })
		waitIdle()
		since := time.Now()
		for i := range 500 {
			file := filepath.Join(pkg, fmt.Sprintf("d%d", i%25), fmt.Sprintf("f%d.js", i))
			if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte("module.exports = 1\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		waitIdle()
		for _, span := range spans.Ended() {
			if span.Name() == "git status" && span.StartTime().After(since) {
				t.Errorf("writing ignored files read status at +%v", span.StartTime().Sub(since).Round(time.Millisecond))
			}
		}
	})

	t.Run("fetch updating many refs", func(t *testing.T) {
		const churn = 500
		var updates strings.Builder
		for i := range churn {
			fmt.Fprintf(&updates, "create refs/remotes/origin/forkit-perf/%d HEAD~%d\n", i, i%50)
		}
		t.Cleanup(func() { deleteRefs(path, "refs/remotes/origin/forkit-perf/") })
		waitIdle()
		last := fmt.Sprintf("forkit-perf/%d", churn-1)
		refsUpdated := deltas.expect(synchub.EventName("refs", string(loc.ID)), func(v json.RawMessage) bool {
			return strings.Contains(string(v), last+`"`)
		})
		gitStdin(t, path, updates.String(), "update-ref", "--stdin")
		since := time.Now()
		check(t, "ref churn to refs update", refsUpdated(t, since), changeBudget)
		logSpans(t, spans, since)
	})
}

// waitIdle lets the watcher settle after earlier steps so each measurement
// starts from rest.
func waitIdle() { time.Sleep(700 * time.Millisecond) }

// logSpans lists the spans that started after since, to show where a slow
// step spent its time.
func logSpans(t *testing.T, spans *tracetest.SpanRecorder, since time.Time) {
	t.Helper()
	for _, span := range spans.Ended() {
		if span.StartTime().After(since) {
			t.Logf("  +%-6v %-24s %v", span.StartTime().Sub(since).Round(time.Millisecond), span.Name(), span.EndTime().Sub(span.StartTime()).Round(time.Millisecond))
		}
	}
}

func check(t *testing.T, what string, took, budget time.Duration) {
	t.Helper()
	if took > budget {
		t.Errorf("%s took %v, budget %v", what, took.Round(time.Millisecond), budget)
		return
	}
	t.Logf("%s: %v (budget %v)", what, took.Round(time.Millisecond), budget)
}

func gitStdin(t *testing.T, dir, stdin string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(stdin)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func deleteRefs(dir, prefix string) {
	out, err := exec.Command("git", "-C", dir, "for-each-ref", "--format=delete %(refname)", prefix).Output()
	if err != nil {
		return
	}
	cmd := exec.Command("git", "-C", dir, "update-ref", "--stdin")
	cmd.Stdin = strings.NewReader(string(out))
	_ = cmd.Run()
}
