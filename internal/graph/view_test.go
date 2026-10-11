package graph_test

import (
	"context"
	"slices"
	"strings"
	"testing"

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
	return &viewFixture{t: t, git: git, repo: fixture, loc: loc, view: view, options: graph.Options{Order: model.GraphOrderTopo, IncludeTags: true}}
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
	want := strings.Fields(f.repo.Git("log", "--topo-order", "--format=%H", "--branches", "--tags"))
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
