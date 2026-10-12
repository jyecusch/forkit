package watch_test

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

var layout = watch.Layout{
	CommonDir: "/r/.git",
	Worktrees: []watch.Worktree{
		{ID: "main", Path: "/r", GitDir: "/r/.git"},
		{ID: "linked", Path: "/wt", GitDir: "/r/.git/worktrees/wt"},
		{ID: "nested", Path: "/r/.worktrees/n", GitDir: "/r/.git/worktrees/n"},
	},
}

func TestClassify(t *testing.T) {
	cases := map[string]watch.Change{
		"/r/.git/refs/heads/main":      {Refs: true, Worktrees: true},
		"/r/.git/refs/remotes/o/main":  {Refs: true},
		"/r/.git/packed-refs":          {Refs: true, Worktrees: true},
		"/r/.git/config":               {Refs: true, Remotes: true},
		"/r/.git/HEAD":                 {Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{"main": true}},
		"/r/.git/index":                {Status: map[model.WorktreeID]bool{"main": true}},
		"/r/.git/worktrees/wt/index":   {Status: map[model.WorktreeID]bool{"linked": true}},
		"/r/.git/worktrees/new":        {Worktrees: true},
		"/r/.git/MERGE_HEAD":           {Worktrees: true, Status: map[model.WorktreeID]bool{"main": true}},
		"/r/src/main.go":               {Status: map[model.WorktreeID]bool{"linked": false, "main": true}},
		"/wt/src/main.go":              {Status: map[model.WorktreeID]bool{"linked": true}},
		"/r/.git/objects/ab/cdef":      {},
		"/r/.git/index.lock":           {},
		"/r/.git/logs/refs/heads/main": {},
		"/elsewhere/file":              {},
	}
	for path, want := range cases {
		got := watch.Classify(layout, []string{path})
		if got.Refs != want.Refs || got.Remotes != want.Remotes || got.Worktrees != want.Worktrees || !sameStatus(got.Status, want.Status) {
			t.Errorf("%s: got %+v, want %+v", path, got, want)
		}
	}
}

func sameStatus(got, want map[model.WorktreeID]bool) bool {
	count := 0
	for id, on := range want {
		if on {
			count++
			if !got[id] {
				return false
			}
		}
	}
	return len(got) == count
}

// startWatcher watches a repository's main worktree and returns the changes
// it reports.
func startWatcher(t *testing.T, fixture *gittest.Repo) <-chan watch.Change {
	t.Helper()
	git, err := gitexec.New(context.Background(), "", noop.NewTracerProvider().Tracer(""))
	if err != nil {
		t.Fatal(err)
	}
	changes := make(chan watch.Change, 64)
	w, err := watch.Start(watch.Layout{
		CommonDir: filepath.Join(fixture.Dir, ".git"),
		Worktrees: []watch.Worktree{{ID: "main", Path: fixture.Dir, GitDir: filepath.Join(fixture.Dir, ".git")}},
	}, repo.Ignores{Git: git}, func(c watch.Change) { changes <- c }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	time.Sleep(100 * time.Millisecond) // let the stream start
	return changes
}

func TestWatcherReportsCommitsAndEdits(t *testing.T) {
	fixture := gittest.New(t)
	fixture.Commit("initial")
	changes := startWatcher(t, fixture)

	fixture.WriteFile("new.txt", "hello")
	waitFor(t, changes, func(c watch.Change) bool { return c.Status["main"] })

	fixture.Commit("second")
	waitFor(t, changes, func(c watch.Change) bool { return c.Refs })
}

func TestWatcherLeavesIgnoredDirectoriesAlone(t *testing.T) {
	fixture := gittest.New(t)
	fixture.WriteFile(".gitignore", "deps\ncache/\n*.log\n")
	fixture.WriteFile("deps/a/index.js", "old")
	fixture.WriteFile("reports/old.log", "old")
	fixture.Git("add", ".gitignore")
	fixture.Git("commit", "-qm", "initial")
	changes := startWatcher(t, fixture)

	// One ignored directory existed when watching started; the other is
	// made afterwards, as an install would.
	fixture.WriteFile("deps/a/index.js", "new")
	fixture.WriteFile("deps/b/index.js", "new")
	fixture.WriteFile("cache/x/y.bin", "new")
	fixture.WriteFile("cache/x/z.bin", "new")
	fixture.WriteFile("deps/a/.gitignore", "*.log\n")
	expectQuiet(t, changes, 300*time.Millisecond)

	fixture.WriteFile("src/main.go", "package main")
	waitFor(t, changes, func(c watch.Change) bool { return c.Status["main"] })

	// Everything in reports is ignored, but reports itself is not.
	fixture.WriteFile("reports/notes.txt", "new")
	waitFor(t, changes, func(c watch.Change) bool { return c.Status["main"] })

	// Once deps is no longer ignored, changes in it count.
	fixture.WriteFile(".gitignore", "cache/\n")
	waitFor(t, changes, func(c watch.Change) bool { return c.Status["main"] })
	time.Sleep(200 * time.Millisecond) // let the watcher start again
	drain(changes)
	fixture.WriteFile("deps/a/index.js", "newer")
	waitFor(t, changes, func(c watch.Change) bool { return c.Status["main"] })
}

// expectQuiet fails if any change is reported within period.
func expectQuiet(t *testing.T, changes <-chan watch.Change, period time.Duration) {
	t.Helper()
	select {
	case c := <-changes:
		t.Fatalf("unexpected change %+v", c)
	case <-time.After(period):
	}
}

func drain(changes <-chan watch.Change) {
	for {
		select {
		case <-changes:
		default:
			return
		}
	}
}

func waitFor(t *testing.T, changes <-chan watch.Change, match func(watch.Change) bool) {
	t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case c := <-changes:
			if match(c) {
				return
			}
		case <-timeout:
			t.Fatal("expected change was not reported")
		}
	}
}
