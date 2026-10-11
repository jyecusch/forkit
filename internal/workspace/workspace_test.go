package workspace_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/internal/workspace"
)

// recorder keeps every delta emitted, by event name.
type recorder struct {
	mu     sync.Mutex
	events map[string][]model.SyncDelta
}

func (r *recorder) Emit(event string, payload any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events[event] = append(r.events[event], payload.(model.SyncDelta))
}

// waitFor polls until some delta on event contains an entity matching match.
func (r *recorder) waitFor(t *testing.T, event string, match func(json.RawMessage) bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		for _, delta := range r.events[event] {
			for _, op := range delta.Ops {
				if value, ok := op.Value.(json.RawMessage); ok && match(value) {
					r.mu.Unlock()
					return
				}
			}
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no matching %s delta", event)
}

func newWorkspace(t *testing.T) (*workspace.Workspace, *recorder, *prefs.SessionStore) {
	t.Helper()
	ctx := context.Background()
	tracer := noop.NewTracerProvider().Tracer("")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := &recorder{events: map[string][]model.SyncDelta{}}
	hub := synchub.New(rec, tracer)
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
	t.Cleanup(func() { ws.Shutdown(context.Background()) })
	return ws, rec, session
}

func TestOpenPublishesRepositoryAndFollowsChanges(t *testing.T) {
	ctx := context.Background()
	fixture := gittest.New(t)
	fixture.Commit("initial")
	ws, rec, session := newWorkspace(t)

	opened, err := ws.Open(ctx, filepath.Join(fixture.Dir))
	if err != nil {
		t.Fatal(err)
	}
	if got := session.Get(); got.ActiveRepoID != opened.ID || len(got.OpenRepos) != 1 {
		t.Fatalf("session = %+v", got)
	}
	scope := string(opened.ID)
	rec.waitFor(t, synchub.EventName("repos", workspace.ReposScope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"state":"ready"`)
	})
	rec.waitFor(t, synchub.EventName("refs", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), "refs/heads/main")
	})
	rec.waitFor(t, synchub.EventName("graphViews", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"totalRows":1`)
	})

	fixture.WriteFile("new.txt", "hello")
	rec.waitFor(t, synchub.EventName("worktrees", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"untracked":1`)
	})

	fixture.Commit("second")
	rec.waitFor(t, synchub.EventName("graphViews", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"totalRows":2`)
	})

	if err := ws.Close(ctx, opened.ID); err != nil {
		t.Fatal(err)
	}
	if got := session.Get(); len(got.OpenRepos) != 0 || got.ActiveRepoID != "" {
		t.Fatalf("session after close = %+v", got)
	}
}
