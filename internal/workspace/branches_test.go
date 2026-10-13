package workspace_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
)

func TestDeleteBranchesLocallyAndOnTheRemote(t *testing.T) {
	f := newRemoteFixture(t)
	ctx := context.Background()
	f.local.Git("checkout", "-qb", "topic")
	f.local.Commit("unmerged topic work")
	f.local.Git("push", "-q", "-u", "origin", "topic")
	f.local.Git("checkout", "-q", "main")
	f.waitForHead("main")
	waitForRef(t, f, "refs/remotes/origin/topic")

	refs := []model.RefID{
		repo.RefIDFor(f.repo.ID, "refs/heads/topic"),
		repo.RefIDFor(f.repo.ID, "refs/remotes/origin/topic"),
	}
	if err := f.ws.DeleteBranches(ctx, f.repo.ID, refs); err != nil {
		t.Fatal(err)
	}
	if got := f.local.Git("for-each-ref", "--format=%(refname)", "refs/heads/topic", "refs/remotes/origin/topic"); got != "" {
		t.Errorf("refs left behind: %q", got)
	}
	if got := f.local.Git("ls-remote", "origin", "refs/heads/topic"); got != "" {
		t.Errorf("origin still has topic: %q", got)
	}
}

func TestDeletingABranchTheRemoteNoLongerHasRemovesItsTrackingRef(t *testing.T) {
	f := newRemoteFixture(t)
	f.other.Git("push", "-q", "origin", "main:gone")
	f.local.Git("fetch", "-q", "origin")
	f.other.Git("push", "-q", "origin", "--delete", "gone")
	waitForRef(t, f, "refs/remotes/origin/gone")

	if err := f.ws.DeleteBranches(context.Background(), f.repo.ID, []model.RefID{repo.RefIDFor(f.repo.ID, "refs/remotes/origin/gone")}); err != nil {
		t.Fatal(err)
	}
	if got := f.local.Git("for-each-ref", "refs/remotes/origin/gone"); got != "" {
		t.Errorf("tracking ref left behind: %q", got)
	}
}

func TestCheckedOutBranchIsNotDeleted(t *testing.T) {
	f := newRemoteFixture(t)
	f.local.Git("branch", "spare")
	waitForRef(t, f, "refs/heads/spare")

	refs := []model.RefID{repo.RefIDFor(f.repo.ID, "refs/heads/spare"), repo.RefIDFor(f.repo.ID, "refs/heads/main")}
	if err := f.ws.DeleteBranches(context.Background(), f.repo.ID, refs); codeOf(err) != model.ErrorCodeInvalidArgument {
		t.Fatalf("err = %v, want InvalidArgument", err)
	}
	if got := f.local.Git("for-each-ref", "--format=%(refname)", "refs/heads/spare"); got != "refs/heads/spare" {
		t.Errorf("spare should survive a refused delete, got %q", got)
	}
}

// waitForRef waits until Forkit publishes a ref, so commands can name it.
func waitForRef(t *testing.T, f *remoteFixture, fullName string) {
	t.Helper()
	id := repo.RefIDFor(f.repo.ID, fullName)
	f.rec.waitFor(t, synchub.EventName("refs", string(f.repo.ID)), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"id":"`+string(id)+`"`)
	})
}
