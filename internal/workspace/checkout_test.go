package workspace_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/internal/workspace"
)

type checkoutFixture struct {
	t      *testing.T
	ws     *workspace.Workspace
	git    *gittest.Repo
	repo   model.Repo
	mainWT model.WorktreeID
}

// newCheckoutFixture opens a repository with main and a feature branch, each
// with its own version of file.txt.
func newCheckoutFixture(t *testing.T) *checkoutFixture {
	t.Helper()
	fixture := gittest.New(t)
	fixture.WriteFile("file.txt", "main\n")
	fixture.Git("add", ".")
	fixture.Git("commit", "-qm", "main")
	fixture.Git("branch", "feature")
	fixture.Git("checkout", "-q", "feature")
	fixture.WriteFile("file.txt", "feature\n")
	fixture.Git("commit", "-qam", "feature")
	fixture.Git("checkout", "-q", "main")

	ws, rec, _ := newWorkspace(t)
	opened, err := ws.Open(context.Background(), fixture.Dir)
	if err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, synchub.EventName("repos", workspace.ReposScope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"state":"ready"`)
	})
	return &checkoutFixture{t: t, ws: ws, git: fixture, repo: opened, mainWT: repo.WorktreeIDFor(fixture.Dir)}
}

func (f *checkoutFixture) ref(name string) model.RefID {
	return repo.RefIDFor(f.repo.ID, name)
}

func (f *checkoutFixture) checkout(wt model.WorktreeID, ref string, mode model.CheckoutMode) (model.CheckoutResult, error) {
	return f.ws.Checkout(context.Background(), wt, f.ref(ref), mode)
}

func (f *checkoutFixture) branch(dir string) string {
	return f.git.GitIn(dir, "rev-parse", "--abbrev-ref", "HEAD")
}

func codeOf(err error) model.ErrorCode {
	var appErr *apperr.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}

func TestCheckoutCleanWorktree(t *testing.T) {
	f := newCheckoutFixture(t)
	result, err := f.checkout(f.mainWT, "refs/heads/feature", model.CheckoutModeSafe)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.branch(f.git.Dir); got != "feature" || result.Branch != f.ref("refs/heads/feature") {
		t.Fatalf("on %s, result %+v", got, result)
	}
}

func TestCheckoutWithUncommittedChanges(t *testing.T) {
	t.Run("safe refuses", func(t *testing.T) {
		f := newCheckoutFixture(t)
		f.git.WriteFile("other.txt", "x")
		f.git.Git("add", "other.txt")
		_, err := f.checkout(f.mainWT, "refs/heads/feature", model.CheckoutModeSafe)
		if codeOf(err) != model.ErrorCodeDirtyWorktree {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("stash reapplies the changes", func(t *testing.T) {
		f := newCheckoutFixture(t)
		f.git.WriteFile("other.txt", "x")
		f.git.Git("add", "other.txt")
		result, err := f.checkout(f.mainWT, "refs/heads/feature", model.CheckoutModeStash)
		if err != nil || result.ReapplyConflicted {
			t.Fatalf("result %+v, err %v", result, err)
		}
		if f.branch(f.git.Dir) != "feature" || f.git.Git("stash", "list") != "" {
			t.Fatal("did not switch with changes reapplied")
		}
		if _, err := os.Stat(filepath.Join(f.git.Dir, "other.txt")); err != nil {
			t.Fatal("stashed file was not restored")
		}
	})

	t.Run("stash reports conflicts when reapplying", func(t *testing.T) {
		f := newCheckoutFixture(t)
		f.git.WriteFile("file.txt", "local edit\n")
		result, err := f.checkout(f.mainWT, "refs/heads/feature", model.CheckoutModeStash)
		if err != nil || !result.ReapplyConflicted {
			t.Fatalf("result %+v, err %v", result, err)
		}
		if f.git.Git("stash", "list") == "" {
			t.Fatal("conflicting changes were not kept in the stash")
		}
	})
}

func TestCheckoutBranchCheckedOutElsewhere(t *testing.T) {
	f := newCheckoutFixture(t)
	linked := filepath.Join(tempDir(t), "linked")
	f.git.Git("worktree", "add", "-q", linked, "feature")
	waitUntil(t, func() bool {
		_, err := f.checkout(f.mainWT, "refs/heads/feature", model.CheckoutModeSafe)
		var appErr *apperr.Error
		return errors.As(err, &appErr) && appErr.Code == model.ErrorCodeBranchCheckedOutElsewhere &&
			appErr.Details["worktreeId"] == string(repo.WorktreeIDFor(linked))
	})
}

func TestCheckoutRemoteBranchCreatesTrackingBranch(t *testing.T) {
	upstream := newCheckoutFixture(t)
	clone := filepath.Join(tempDir(t), "clone")
	upstream.git.Git("clone", "-q", upstream.git.Dir, clone)
	ws, rec, _ := newWorkspace(t)
	opened, err := ws.Open(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, synchub.EventName("repos", workspace.ReposScope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"state":"ready"`)
	})
	_, err = ws.Checkout(context.Background(), repo.WorktreeIDFor(clone), repo.RefIDFor(opened.ID, "refs/remotes/origin/feature"), model.CheckoutModeSafe)
	if err != nil {
		t.Fatal(err)
	}
	if got := upstream.git.GitIn(clone, "rev-parse", "--abbrev-ref", "feature@{upstream}"); got != "origin/feature" {
		t.Fatalf("upstream = %s", got)
	}
}

func TestCheckoutDuringMergeIsRefused(t *testing.T) {
	f := newCheckoutFixture(t)
	f.git.WriteFile("file.txt", "conflict\n")
	f.git.Git("commit", "-qam", "conflict")
	cmdErr := runGit(f.git.Dir, "merge", "feature")
	if cmdErr == nil {
		t.Fatal("expected a conflict")
	}
	waitUntil(t, func() bool {
		_, err := f.checkout(f.mainWT, "refs/heads/feature", model.CheckoutModeCarry)
		return codeOf(err) == model.ErrorCodeOperationInProgress
	})
}

func TestCreateAndRemoveWorktree(t *testing.T) {
	ctx := context.Background()
	f := newCheckoutFixture(t)
	path := filepath.Join(tempDir(t), "tabs")
	wt, err := f.ws.CreateWorktree(ctx, f.repo.ID, f.ref("refs/heads/main"), "topic/tabs", path)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.branch(path); got != "topic/tabs" {
		t.Fatalf("new worktree is on %s", got)
	}

	if _, err := f.ws.CreateWorktree(ctx, f.repo.ID, f.ref("refs/heads/main"), "topic/tabs", ""); codeOf(err) != model.ErrorCodeInvalidArgument {
		t.Fatalf("duplicate branch: %v", err)
	}

	os.WriteFile(filepath.Join(path, "dirty.txt"), []byte("x"), 0o644)
	if err := f.ws.RemoveWorktree(ctx, wt.ID, false); codeOf(err) != model.ErrorCodeDirtyWorktree {
		t.Fatalf("removing a dirty worktree: %v", err)
	}
	if err := f.ws.RemoveWorktree(ctx, wt.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("worktree directory still exists")
	}
	if err := f.ws.RemoveWorktree(ctx, f.mainWT, true); codeOf(err) != model.ErrorCodeInvalidArgument && codeOf(err) != model.ErrorCodeWorktreeNotFound {
		t.Fatalf("removing the main worktree: %v", err)
	}
}

// tempDir returns a temporary directory with symlinks resolved, matching the
// paths git reports.
func tempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}
