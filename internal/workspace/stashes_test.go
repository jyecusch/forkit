package workspace_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jyecusch/forkit/internal/model"
)

func (f *checkoutFixture) stashes() []string {
	f.t.Helper()
	list := f.git.Git("stash", "list", "--format=%gs")
	if list == "" {
		return nil
	}
	return strings.Split(list, "\n")
}

func (f *checkoutFixture) read(path string) string {
	f.t.Helper()
	data, err := os.ReadFile(filepath.Join(f.git.Dir, path))
	if err != nil {
		return ""
	}
	return string(data)
}

func TestStashSavesChangesAndApplyingBringsThemBack(t *testing.T) {
	f := newCheckoutFixture(t)
	ctx := context.Background()
	f.git.WriteFile("file.txt", "changed\n")
	f.git.WriteFile("new.txt", "untracked\n")

	if err := f.ws.Stash(ctx, f.mainWT, "  wip  "); err != nil {
		t.Fatal(err)
	}
	if status := f.git.Git("status", "--porcelain"); status != "" {
		t.Fatalf("worktree not clean after stashing:\n%s", status)
	}
	if got := f.stashes(); len(got) != 1 || got[0] != "On main: wip" {
		t.Fatalf("stashes = %q", got)
	}

	result, err := f.ws.ApplyStash(ctx, f.mainWT, f.ref("stash@{0}"), false)
	if err != nil || result.Conflicted {
		t.Fatalf("apply = %+v, %v", result, err)
	}
	if f.read("file.txt") != "changed\n" || f.read("new.txt") != "untracked\n" || len(f.stashes()) != 1 {
		t.Fatalf("after apply: file.txt %q, new.txt %q, stashes %q", f.read("file.txt"), f.read("new.txt"), f.stashes())
	}

	f.git.Git("checkout", "--", "file.txt")
	f.git.Git("clean", "-qf")
	if _, err := f.ws.ApplyStash(ctx, f.mainWT, f.ref("stash@{0}"), true); err != nil {
		t.Fatal(err)
	}
	if f.read("file.txt") != "changed\n" || len(f.stashes()) != 0 {
		t.Fatalf("after pop: file.txt %q, stashes %q", f.read("file.txt"), f.stashes())
	}
}

func TestStashRefusesACleanWorktree(t *testing.T) {
	f := newCheckoutFixture(t)
	if err := f.ws.Stash(context.Background(), f.mainWT, ""); codeOf(err) != model.ErrorCodeInvalidArgument {
		t.Fatalf("err = %v, want InvalidArgument", err)
	}
}

func TestPoppingAConflictingStashKeepsIt(t *testing.T) {
	f := newCheckoutFixture(t)
	ctx := context.Background()
	f.git.WriteFile("file.txt", "stashed\n")
	if err := f.ws.Stash(ctx, f.mainWT, ""); err != nil {
		t.Fatal(err)
	}
	f.git.WriteFile("file.txt", "committed\n")
	f.git.Git("commit", "-qam", "conflicting")

	result, err := f.ws.ApplyStash(ctx, f.mainWT, f.ref("stash@{0}"), true)
	if err != nil || !result.Conflicted {
		t.Fatalf("pop = %+v, %v; want a conflict", result, err)
	}
	if len(f.stashes()) != 1 {
		t.Errorf("stashes = %q, want the conflicting stash kept", f.stashes())
	}
}

func TestDropRefusesAStashWhosePlaceHasChanged(t *testing.T) {
	f := newCheckoutFixture(t)
	ctx := context.Background()
	for _, content := range []string{"one\n", "two\n"} {
		f.git.WriteFile("file.txt", content)
		if err := f.ws.Stash(ctx, f.mainWT, strings.TrimSpace(content)); err != nil {
			t.Fatal(err)
		}
	}
	// Another tool drops the newest, so "one" moves up to stash@{0}.
	f.git.Git("stash", "drop", "-q")

	if err := f.ws.DropStash(ctx, f.repo.ID, f.ref("stash@{1}")); codeOf(err) != model.ErrorCodeRefNotFound {
		t.Fatalf("err = %v, want RefNotFound", err)
	}
	if got := f.stashes(); len(got) != 1 || got[0] != "On main: one" {
		t.Errorf("stashes = %q, want one left alone", got)
	}
}

func TestOnlyStashesCanBeApplied(t *testing.T) {
	f := newCheckoutFixture(t)
	_, err := f.ws.ApplyStash(context.Background(), f.mainWT, f.ref("refs/heads/feature"), false)
	if codeOf(err) != model.ErrorCodeInvalidArgument {
		t.Fatalf("err = %v, want InvalidArgument", err)
	}
}
