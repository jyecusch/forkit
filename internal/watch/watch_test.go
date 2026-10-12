package watch_test

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/model"
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
		"/r/.git/refs/heads/main":      {Refs: true},
		"/r/.git/packed-refs":          {Refs: true},
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

func TestWatcherReportsCommitsAndEdits(t *testing.T) {
	fixture := gittest.New(t)
	fixture.Commit("initial")
	changes := make(chan watch.Change, 16)
	w, err := watch.Start(watch.Layout{
		CommonDir: filepath.Join(fixture.Dir, ".git"),
		Worktrees: []watch.Worktree{{ID: "main", Path: fixture.Dir, GitDir: filepath.Join(fixture.Dir, ".git")}},
	}, func(c watch.Change) { changes <- c }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	time.Sleep(100 * time.Millisecond) // let the stream start

	fixture.WriteFile("new.txt", "hello")
	waitFor(t, changes, func(c watch.Change) bool { return c.Status["main"] })

	fixture.Commit("second")
	waitFor(t, changes, func(c watch.Change) bool { return c.Refs })
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
