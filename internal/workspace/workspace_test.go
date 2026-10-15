package workspace_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
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

func TestWorktreeAddedOutsideForkitIsPublished(t *testing.T) {
	ctx := context.Background()
	fixture := gittest.New(t)
	fixture.Commit("initial")
	ws, rec, _ := newWorkspace(t)

	opened, err := ws.Open(ctx, fixture.Dir)
	if err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, synchub.EventName("repos", workspace.ReposScope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"state":"ready"`)
	})

	path := filepath.Join(tempDir(t), "outside")
	if err := runGit(fixture.Dir, "worktree", "add", "-b", "outside", path); err != nil {
		t.Fatal(err)
	}
	encodedPath, err := json.Marshal(path)
	if err != nil {
		t.Fatal(err)
	}
	scope := string(opened.ID)
	rec.waitFor(t, synchub.EventName("worktrees", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), string(encodedPath))
	})
	rec.waitFor(t, synchub.EventName("refs", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), "refs/heads/outside")
	})
}

func TestClosingTheActiveRepositoryActivatesItsNeighbour(t *testing.T) {
	ctx := context.Background()
	ws, _, session := newWorkspace(t)
	var ids []model.RepoID
	for range 3 {
		fixture := gittest.New(t)
		fixture.Commit("initial")
		opened, err := ws.Open(ctx, fixture.Dir)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, opened.ID)
	}

	// The last of three is active; closing it falls back to its left.
	if err := ws.Close(ctx, ids[2]); err != nil {
		t.Fatal(err)
	}
	if got := session.Get().ActiveRepoID; got != ids[1] {
		t.Fatalf("active after closing the last = %s, want %s", got, ids[1])
	}

	// Closing the first activates the one that was to its right.
	if err := session.Update(ctx, func(s *model.Session) { s.ActiveRepoID = ids[0] }); err != nil {
		t.Fatal(err)
	}
	if err := ws.Close(ctx, ids[0]); err != nil {
		t.Fatal(err)
	}
	if got := session.Get().ActiveRepoID; got != ids[1] {
		t.Fatalf("active after closing the first = %s, want %s", got, ids[1])
	}
}

func waitUntil(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func runGit(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=a@example.com", "GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=a@example.com")
	return cmd.Run()
}

func TestCloseWhileLoadingLeavesNothingBehind(t *testing.T) {
	ctx := context.Background()
	fixture := gittest.New(t)
	fixture.Commit("initial")
	ws, rec, _ := newWorkspace(t)
	for range 20 {
		opened, err := ws.Open(ctx, fixture.Dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := ws.Close(ctx, opened.ID); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	rec.mu.Lock()
	count := len(rec.events)
	rec.mu.Unlock()

	fixture.Commit("after close")
	time.Sleep(300 * time.Millisecond)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.events) != count {
		t.Fatal("a closed repository still publishes after files change")
	}
}

func TestOpeningWhilePreferencesChangeDoesNotDeadlock(t *testing.T) {
	ctx := context.Background()
	fixture := gittest.New(t)
	fixture.Commit("initial")
	ws, _, _ := newWorkspace(t)
	store := ws.Preferences()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 50 {
			_ = store.Set(ctx, "graph.showTags", i%2 == 0)
		}
	}()
	for range 20 {
		opened, err := ws.Open(ctx, fixture.Dir)
		if err != nil {
			t.Fatal(err)
		}
		_ = ws.Close(ctx, opened.ID)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("deadlocked")
	}
}

func TestInitMakesAFolderARepositoryAndOpensIt(t *testing.T) {
	ctx := context.Background()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws, rec, session := newWorkspace(t)

	result, err := ws.Init(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Created || session.Get().ActiveRepoID != result.Repo.ID {
		t.Fatalf("result = %+v, session = %+v", result, session.Get())
	}
	scope := string(result.Repo.ID)
	// A repository with no commits yet still loads, and shows its files.
	rec.waitFor(t, synchub.EventName("repos", workspace.ReposScope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"state":"ready"`)
	})
	rec.waitFor(t, synchub.EventName("worktrees", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"untracked":1`)
	})

	gittest.At(t, dir).Commit("first")
	rec.waitFor(t, synchub.EventName("graphViews", scope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"totalRows":1`)
	})

	again, err := ws.Init(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.Created || again.Repo.ID != result.Repo.ID {
		t.Fatalf("initialising an existing repository = %+v", again)
	}
}
