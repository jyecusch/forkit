package graph_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/graph"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
)

type viewFixture struct {
	t       *testing.T
	git     *gitexec.Git
	repo    *gittest.Repo
	loc     repo.Location
	view    *graph.View
	hub     *synchub.Hub
	options graph.Options
}

type nopEmitter struct{}

func (nopEmitter) Emit(string, any) {}

func newViewFixture(t *testing.T) *viewFixture {
	t.Helper()
	ctx := context.Background()
	tracer := noop.NewTracerProvider().Tracer("")
	git, err := gitexec.New(ctx, "", tracer)
	if err != nil {
		t.Fatal(err)
	}
	fixture := gittest.New(t)
	fixture.Commit("root")
	loc, err := repo.Locate(ctx, git, fixture.Dir)
	if err != nil {
		t.Fatal(err)
	}
	hub := synchub.New(nopEmitter{}, tracer)
	channel := synchub.NewChannel(hub, "graphViews", func(v model.GraphView) string { return string(v.ID) })
	view := graph.NewView(ctx, loc.ID, git.Repo(loc.CommonDir, loc.WorkDir), channel, tracer)
	t.Cleanup(view.Close)
	return &viewFixture{t: t, git: git, repo: fixture, loc: loc, view: view, hub: hub, options: graph.Options{Order: model.GraphOrderTopo, IncludeTags: true}}
}

func (f *viewFixture) refresh() []model.Ref {
	f.t.Helper()
	refs, err := repo.ListRefs(context.Background(), f.git, f.loc, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := f.view.Refresh(context.Background(), refs, nil, f.options); err != nil {
		f.t.Fatal(err)
	}
	return refs
}

func (f *viewFixture) window(emphasized model.RefID) model.GraphWindow {
	f.t.Helper()
	window, err := f.view.Window(context.Background(), 0, 1000, emphasized)
	if err != nil {
		f.t.Fatal(err)
	}
	return window
}

// assertMatchesGitLog checks the rows list the same commits, in the same
// order, as git log does.
func (f *viewFixture) assertMatchesGitLog() {
	f.t.Helper()
	order := map[model.GraphOrder]string{model.GraphOrderTopo: "--topo-order", model.GraphOrderDate: "--date-order"}[f.options.Order]
	want := strings.Fields(f.repo.Git("log", order, "--format=%H", "--branches", "--tags"))
	window := f.window("")
	if len(window.Rows) != len(want) {
		f.t.Fatalf("got %d rows, want %d", len(window.Rows), len(want))
	}
	for i, row := range window.Rows {
		if string(row.OID) != want[i] || window.Commits[i].OID != row.OID {
			f.t.Fatalf("row %d is %s, want %s", i, row.OID, want[i])
		}
	}
}

func TestViewFollowsHistoryChanges(t *testing.T) {
	f := newViewFixture(t)
	f.repo.Git("checkout", "-qb", "feature")
	f.repo.Commit("feature work")
	f.repo.Git("checkout", "-q", "main")
	f.repo.Commit("main work")
	f.repo.Git("merge", "-q", "--no-ff", "-m", "merge feature", "feature")
	f.refresh()
	f.assertMatchesGitLog()

	t.Run("new commits are prepended", func(t *testing.T) {
		f.repo.Commit("on top")
		f.refresh()
		f.assertMatchesGitLog()
	})

	t.Run("rewritten history is reloaded", func(t *testing.T) {
		f.repo.Git("reset", "-q", "--hard", "HEAD~2")
		f.repo.Git("branch", "-qD", "feature")
		f.refresh()
		f.assertMatchesGitLog()
	})
}

func TestDateOrderPlacesOlderNewCommitsAmongTheRest(t *testing.T) {
	f := newViewFixture(t)
	f.options.Order = model.GraphOrderDate
	start := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	f.repo.CommitAt("on main", start.Add(5*time.Hour))
	f.refresh()
	f.assertMatchesGitLog()

	// A branch fetched now whose commit is older than main's newest.
	f.repo.Git("checkout", "-qb", "older", "HEAD~1")
	f.repo.CommitAt("older work", start.Add(3*time.Hour))
	f.repo.Git("checkout", "-q", "main")
	f.refresh()
	f.assertMatchesGitLog()

	f.repo.CommitAt("newest", start.Add(9*time.Hour))
	f.refresh()
	f.assertMatchesGitLog()
}

func TestWindowMarksEmphasizedHistoryAndRefs(t *testing.T) {
	f := newViewFixture(t)
	f.repo.Git("checkout", "-qb", "feature")
	f.repo.Commit("feature work")
	f.repo.Git("checkout", "-q", "main")
	f.repo.Commit("main work")
	f.repo.Git("tag", "-a", "v1", "-m", "release")
	refs := f.refresh()

	feature := repo.RefIDFor(f.loc.ID, "refs/heads/feature")
	window := f.window(feature)
	subjects := map[string]bool{}
	for i, row := range window.Rows {
		if row.OnEmphasized {
			subjects[window.Commits[i].Subject] = true
		}
	}
	if !subjects["feature work"] || !subjects["root"] || subjects["main work"] {
		t.Errorf("emphasized subjects = %v", subjects)
	}

	tag := repo.RefIDFor(f.loc.ID, "refs/tags/v1")
	row := f.view.RowOfRef(tag)
	if row < 0 || !slices.Contains(window.Rows[row].RefIDs, tag) {
		t.Errorf("tag v1 not found on its commit's row (refs %v)", refs)
	}
}

// published returns the graph view last published for the repository.
func (f *viewFixture) published() model.GraphView {
	f.t.Helper()
	snapshot := f.hub.Subscribe("graphViews", string(f.loc.ID))
	if len(snapshot.Entities) != 1 {
		f.t.Fatalf("published %d graph views, want 1", len(snapshot.Entities))
	}
	raw, err := json.Marshal(snapshot.Entities[0])
	var view model.GraphView
	if err == nil {
		err = json.Unmarshal(raw, &view)
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return view
}

func TestViewPublishesEachBranchsThread(t *testing.T) {
	f := newViewFixture(t)
	f.repo.Git("checkout", "-qb", "feature")
	f.repo.Commit("feature work")
	f.repo.Git("checkout", "-q", "main")
	f.repo.Commit("main work")
	f.repo.Git("tag", "v1")
	f.refresh()

	window := f.window("")
	threads := f.published().BranchThreads
	for _, name := range []string{"main", "feature"} {
		ref := repo.RefIDFor(f.loc.ID, "refs/heads/"+name)
		thread, ok := threads[string(ref)]
		if row := f.view.RowOfRef(ref); !ok || thread != window.Rows[row].ThreadID {
			t.Errorf("%s: published thread %d (%v), its row's is %d", name, thread, ok, window.Rows[row].ThreadID)
		}
	}
	if len(threads) != 2 {
		t.Errorf("published %d threads, want only the local branches'", len(threads))
	}
}

func TestWindowRejectsNegativeRangesAndClampsTheEnd(t *testing.T) {
	f := newViewFixture(t)
	f.refresh()
	if _, err := f.view.Window(context.Background(), -1, 10, ""); err == nil {
		t.Fatal("negative start was accepted")
	}
	window, err := f.view.Window(context.Background(), 5, 10, "")
	if err != nil || len(window.Rows) != 0 {
		t.Fatalf("window past the end = %+v, %v", window, err)
	}
	// The view must still be usable afterwards.
	f.refresh()
}

// stashRows returns the rows the view marks as stashes.
func stashRows(window model.GraphWindow) []model.GraphRow {
	var rows []model.GraphRow
	for _, row := range window.Rows {
		if row.Stash != nil && *row.Stash {
			rows = append(rows, row)
		}
	}
	return rows
}

func TestStashesShowAsRowsJoinedToTheCommitTheyWereMadeOn(t *testing.T) {
	f := newViewFixture(t)
	f.repo.WriteFile("tracked.txt", "one")
	f.repo.Git("add", "tracked.txt")
	f.repo.Commit("add tracked")
	f.refresh()
	mainThread := f.published().BranchThreads[string(repo.RefIDFor(f.loc.ID, "refs/heads/main"))]

	// Staged, unstaged and untracked changes give the stash all three parents.
	f.repo.WriteFile("tracked.txt", "two")
	f.repo.Git("add", "tracked.txt")
	f.repo.WriteFile("tracked.txt", "three")
	f.repo.WriteFile("untracked.txt", "new")
	f.repo.Git("stash", "push", "-q", "--include-untracked", "-m", "first")
	f.options.IncludeStashes = true
	f.refresh()

	window := f.window("")
	commits := len(strings.Fields(f.repo.Git("log", "--format=%H", "--branches")))
	if len(window.Rows) != commits+1 {
		t.Fatalf("got %d rows, want the %d commits and the stash alone", len(window.Rows), commits)
	}
	stashes := stashRows(window)
	if len(stashes) != 1 || string(stashes[0].OID) != f.repo.Git("rev-parse", "stash@{0}") {
		t.Fatalf("stash rows = %+v", stashes)
	}
	stash := stashes[0]
	if stash.ThreadID == mainThread || !slices.Contains(stash.RefIDs, repo.RefIDFor(f.loc.ID, "stash@{0}")) {
		t.Errorf("stash row has thread %d (main's is %d) and refs %v", stash.ThreadID, mainThread, stash.RefIDs)
	}
	below := window.Rows[stash.Index].Edges
	if !slices.ContainsFunc(below, func(e model.GraphEdge) bool { return e.Stash != nil && e.FromLane == stash.Lane }) {
		t.Errorf("no stash line leaves the stash row: %+v", below)
	}
	if got := f.published().BranchThreads[string(repo.RefIDFor(f.loc.ID, "refs/heads/main"))]; got != mainThread {
		t.Errorf("main's thread changed from %d to %d when a stash appeared", mainThread, got)
	}

	t.Run("a new stash is added", func(t *testing.T) {
		f.repo.WriteFile("tracked.txt", "four")
		f.repo.Git("stash", "push", "-q", "-m", "second")
		f.refresh()
		if got := len(stashRows(f.window(""))); got != 2 {
			t.Errorf("got %d stash rows, want 2", got)
		}
	})

	t.Run("a dropped stash is removed", func(t *testing.T) {
		f.repo.Git("stash", "drop", "-q")
		f.refresh()
		window := f.window("")
		if got := stashRows(window); len(got) != 1 || string(got[0].OID) != f.repo.Git("rev-parse", "stash@{0}") {
			t.Errorf("stash rows = %+v", got)
		}
	})

	t.Run("stashes can be hidden", func(t *testing.T) {
		f.options.IncludeStashes = false
		f.refresh()
		f.assertMatchesGitLog()
	})
}
