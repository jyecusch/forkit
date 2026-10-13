package repo_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
)

func setup(t *testing.T) (*gitexec.Git, *gittest.Repo, repo.Location) {
	t.Helper()
	ctx := context.Background()
	git, err := gitexec.New(ctx, "", noop.NewTracerProvider().Tracer(""))
	if err != nil {
		t.Fatal(err)
	}
	fixture := gittest.New(t)
	fixture.Commit("initial")
	loc, err := repo.Locate(ctx, git, filepath.Join(fixture.Dir))
	if err != nil {
		t.Fatal(err)
	}
	return git, fixture, loc
}

func TestLocateFromLinkedWorktreeFindsSameRepo(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	linked := filepath.Join(t.TempDir(), "linked")
	fixture.Git("worktree", "add", "-q", "-b", "feature", linked)

	fromLinked, err := repo.Locate(ctx, git, linked)
	if err != nil {
		t.Fatal(err)
	}
	if fromLinked != loc {
		t.Fatalf("got %+v, want %+v", fromLinked, loc)
	}
	if loc.WorkDir != fixture.Dir {
		t.Fatalf("work dir %q, want %q", loc.WorkDir, fixture.Dir)
	}
}

func TestListWorktrees(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	linked := filepath.Join(t.TempDir(), "linked")
	fixture.Git("worktree", "add", "-q", "--detach", linked)
	fixture.Git("worktree", "lock", linked)

	worktrees, err := repo.ListWorktrees(ctx, git, loc)
	if err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 2 {
		t.Fatalf("got %d worktrees", len(worktrees))
	}
	main, other := worktrees[0], worktrees[1]
	if !main.IsMain || main.Head.Kind != model.HeadKindBranch || main.Head.RefID != repo.RefIDFor(loc.ID, "refs/heads/main") {
		t.Errorf("main worktree = %+v", main.Worktree)
	}
	if other.IsMain || !other.Locked || other.Head.Kind != model.HeadKindDetached {
		t.Errorf("linked worktree = %+v", other.Worktree)
	}
}

func TestOperationInProgressIsDetected(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("f.txt", "base\n")
	fixture.Git("add", ".")
	fixture.Git("commit", "-qm", "base")
	fixture.Git("checkout", "-qb", "other")
	fixture.WriteFile("f.txt", "other\n")
	fixture.Git("commit", "-qam", "other")
	fixture.Git("checkout", "-q", "main")
	fixture.WriteFile("f.txt", "main\n")
	fixture.Git("commit", "-qam", "main")
	if _, err := git.Run(ctx, fixture.Dir, "merge", "other"); err == nil {
		t.Fatal("expected a conflicting merge")
	}

	worktrees, err := repo.ListWorktrees(ctx, git, loc)
	if err != nil {
		t.Fatal(err)
	}
	if got := worktrees[0].Operation; got != model.WorktreeOperationMerge {
		t.Errorf("operation = %q", got)
	}
	files, summary, err := repo.ReadStatus(ctx, git, worktrees[0].ID, fixture.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Conflicted != 1 || files[0].Conflict != "UU" {
		t.Errorf("summary %+v, files %+v", summary, files)
	}
}

func TestListRefs(t *testing.T) {
	ctx := context.Background()
	git, upstream, _ := setup(t)
	clone := filepath.Join(t.TempDir(), "clone")
	upstream.Git("clone", "-q", upstream.Dir, clone)
	upstream.Commit("ahead on upstream")
	upstream.GitIn(clone, "fetch", "-q")
	upstream.GitIn(clone, "commit", "--allow-empty", "-qm", "local")
	upstream.GitIn(clone, "tag", "-a", "v1", "-m", "release")

	loc, err := repo.Locate(ctx, git, clone)
	if err != nil {
		t.Fatal(err)
	}
	remotes, err := repo.ListRemotes(ctx, git, loc)
	if err != nil {
		t.Fatal(err)
	}
	if len(remotes) != 1 || remotes[0].Name != "origin" || remotes[0].PushURL != upstream.Dir {
		t.Fatalf("remotes = %+v", remotes)
	}
	refs, err := repo.ListRefs(ctx, git, loc, remotes)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]model.Ref{}
	for _, ref := range refs {
		byName[ref.FullName] = ref
	}
	main := byName["refs/heads/main"]
	if *main.Ahead != 1 || *main.Behind != 1 || main.CheckedOutInWorktreeID == "" {
		t.Errorf("main = %+v", main)
	}
	if remote := byName["refs/remotes/origin/main"]; remote.RemoteID != remotes[0].ID || remote.ShortName != "origin/main" {
		t.Errorf("origin/main = %+v", remote)
	}
	if _, ok := byName["refs/remotes/origin/HEAD"]; ok {
		t.Error("symbolic origin/HEAD was listed")
	}
	if tag := byName["refs/tags/v1"]; tag.PeeledOID != main.TargetOID {
		t.Errorf("tag v1 = %+v", tag)
	}
}

func TestReadStatusAndCommitDetail(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("keep.txt", "one\ntwo\nthree\nfour\nfive\n")
	fixture.WriteFile("bin.dat", "\x00\x01\x02")
	fixture.Git("add", ".")
	fixture.Git("commit", "-qm", "add files")
	fixture.Git("mv", "keep.txt", "renamed.txt")
	fixture.WriteFile("renamed.txt", "one\ntwo\nthree\nfour\nfive\nsix\n")
	fixture.Git("add", ".")
	fixture.Git("commit", "-qm", "rename\n\nwith a body")
	oid := fixture.Git("rev-parse", "HEAD")

	detail, err := repo.ReadCommitDetail(ctx, git, loc, model.OID(oid))
	if err != nil {
		t.Fatal(err)
	}
	if detail.Body != "rename\n\nwith a body" || len(detail.Parents) != 1 || len(detail.Files) != 1 {
		t.Fatalf("detail = %+v", detail)
	}
	if f := detail.Files[0]; f.Status != model.FileChangeStatusRenamed || f.OldPath != "keep.txt" || f.Additions != 1 {
		t.Errorf("file change = %+v", f)
	}

	fixture.WriteFile("renamed.txt", "changed\n")
	fixture.WriteFile("new.txt", "new\n")
	fixture.WriteFile("staged.txt", "staged\n")
	fixture.Git("add", "staged.txt")
	_, summary, err := repo.ReadStatus(ctx, git, "wt", fixture.Dir)
	if err != nil {
		t.Fatal(err)
	}
	want := model.StatusSummary{Staged: 1, Unstaged: 1, Untracked: 1}
	if summary != want {
		t.Errorf("summary = %+v, want %+v", summary, want)
	}
}

func TestStashDetailIncludesUntrackedFilesAndHidesItsOwnCommits(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("tracked.txt", "one\n")
	fixture.Git("add", ".")
	fixture.Git("commit", "-qm", "add tracked")
	base := fixture.Git("rev-parse", "HEAD")
	fixture.WriteFile("tracked.txt", "two\n")
	fixture.WriteFile("untracked.txt", "new\n")
	fixture.Git("stash", "push", "-q", "--include-untracked")
	stash := model.OID(fixture.Git("rev-parse", "stash@{0}"))

	detail, err := repo.ReadStashDetail(ctx, git, loc, stash)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Parents) != 1 || string(detail.Parents[0]) != base {
		t.Errorf("parents = %v, want only %s", detail.Parents, base)
	}
	files := map[string]model.FileChange{}
	for _, file := range detail.Files {
		files[file.Path] = file
	}
	if tracked := files["tracked.txt"]; tracked.Status != model.FileChangeStatusModified || tracked.DiffOID != "" {
		t.Errorf("tracked.txt = %+v", tracked)
	}
	untracked := files["untracked.txt"]
	if untracked.Status != model.FileChangeStatusAdded || untracked.DiffOID == "" || len(files) != 2 {
		t.Fatalf("files = %+v", detail.Files)
	}

	diff, err := repo.ReadDiff(ctx, git, loc, loc.WorkDir, model.DiffRequest{Kind: model.DiffKindCommit, OID: untracked.DiffOID, Path: "untracked.txt"})
	if err != nil || len(diff.Hunks) != 1 || diff.Hunks[0].Lines[0].Text != "new" {
		t.Errorf("untracked file's diff = %+v, %v", diff, err)
	}
}

func TestRefsCarryTheirDate(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	committed := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	fixture.CommitAt("tagged", committed)
	fixture.Git("tag", "light")
	// The fixture dates everything else, the annotated tag included, 2026-01-01.
	fixture.Git("tag", "-a", "annotated", "-m", "release")
	tagged := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	refs, err := repo.ListRefs(ctx, git, loc, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]time.Time{"refs/tags/light": committed, "refs/tags/annotated": tagged, "refs/heads/main": committed}
	for _, ref := range refs {
		if when, ok := want[ref.FullName]; ok && (ref.Date == nil || int64(*ref.Date) != when.UnixMilli()) {
			t.Errorf("%s date = %v, want %v", ref.FullName, ref.Date, when.UnixMilli())
		}
	}
}
