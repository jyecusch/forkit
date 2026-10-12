package workspace_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jyecusch/forkit/internal/gittest"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/internal/workspace"
)

type remoteFixture struct {
	t      *testing.T
	ws     *workspace.Workspace
	rec    *recorder
	local  *gittest.Repo
	other  *gittest.Repo
	repo   model.Repo
	mainWT model.WorktreeID
}

// newRemoteFixture opens a clone whose main tracks origin/main, next to
// another clone that pushes to the same origin, like a teammate.
func newRemoteFixture(t *testing.T) *remoteFixture {
	t.Helper()
	// Forkit's own merges and rebases need an identity.
	t.Setenv("GIT_AUTHOR_NAME", "Ada")
	t.Setenv("GIT_AUTHOR_EMAIL", "ada@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Ada")
	t.Setenv("GIT_COMMITTER_EMAIL", "ada@example.com")

	origin := filepath.Join(t.TempDir(), "origin.git")
	seed := gittest.New(t)
	seed.WriteFile("file.txt", "one\n")
	seed.Git("add", ".")
	seed.Git("commit", "-qm", "first")
	seed.Git("clone", "-q", "--bare", seed.Dir, origin)

	clone := func() *gittest.Repo {
		r := gittest.New(t)
		r.Git("remote", "add", "origin", origin)
		r.Git("fetch", "-q", "origin")
		r.Git("reset", "-q", "--hard", "origin/main")
		r.Git("branch", "-q", "--set-upstream-to=origin/main")
		return r
	}
	local, other := clone(), clone()

	ws, rec, _ := newWorkspace(t)
	opened, err := ws.Open(context.Background(), local.Dir)
	if err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, synchub.EventName("repos", workspace.ReposScope), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"state":"ready"`)
	})
	return &remoteFixture{t: t, ws: ws, rec: rec, local: local, other: other, repo: opened, mainWT: repo.WorktreeIDFor(local.Dir)}
}

// teammatePushes commits a change to file.txt in the other clone and pushes it.
func (f *remoteFixture) teammatePushes(content string) {
	f.t.Helper()
	f.other.WriteFile("file.txt", content)
	f.other.Git("commit", "-qam", "teammate")
	f.other.Git("push", "-q", "origin", "main")
}

// waitForHead waits until Forkit has seen the local clone's latest commit
// on branch, and the branch itself.
func (f *remoteFixture) waitForHead(branch string) {
	f.t.Helper()
	head := model.OID(f.local.Git("rev-parse", "HEAD"))
	ref := repo.RefIDFor(f.repo.ID, "refs/heads/"+branch)
	waitUntil(f.t, func() bool {
		wt, err := f.ws.WorktreeInfo(f.mainWT)
		return err == nil && wt.Head.OID == head && wt.Head.RefID == ref
	})
	f.rec.waitFor(f.t, synchub.EventName("refs", string(f.repo.ID)), func(v json.RawMessage) bool {
		return strings.Contains(string(v), `"id":"`+string(ref)+`"`) && strings.Contains(string(v), string(head))
	})
}

func (f *remoteFixture) setPullMode(mode model.PullMode) {
	f.t.Helper()
	if err := f.ws.Preferences().Set(context.Background(), "git.pullMode", string(mode)); err != nil {
		f.t.Fatal(err)
	}
}

func TestFetchUpdatesRemoteTrackingBranches(t *testing.T) {
	f := newRemoteFixture(t)
	f.teammatePushes("two\n")

	if err := f.ws.Fetch(context.Background(), f.repo.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, want := f.local.Git("rev-parse", "origin/main"), f.other.Git("rev-parse", "HEAD"); got != want {
		t.Errorf("origin/main = %s, want the teammate's %s", got, want)
	}
	if err := f.ws.Fetch(context.Background(), f.repo.ID, "nope"); codeOf(err) != model.ErrorCodeInvalidArgument {
		t.Errorf("fetching an unknown remote: err = %v", err)
	}
}

func TestPullFastForwards(t *testing.T) {
	f := newRemoteFixture(t)
	f.teammatePushes("two\n")
	f.local.WriteFile("notes.txt", "uncommitted\n")

	if err := f.ws.Pull(context.Background(), f.mainWT); err != nil {
		t.Fatal(err)
	}
	if got, want := f.local.Git("rev-parse", "HEAD"), f.other.Git("rev-parse", "HEAD"); got != want {
		t.Errorf("HEAD = %s, want the teammate's %s", got, want)
	}
	if status := f.local.Git("status", "--porcelain"); status != "?? notes.txt" {
		t.Errorf("status = %q; uncommitted work should survive the pull", status)
	}
}

func TestPullOfDivergedBranch(t *testing.T) {
	f := newRemoteFixture(t)
	f.teammatePushes("two\n")
	f.local.WriteFile("mine.txt", "mine\n")
	f.local.Git("add", ".")
	f.local.Git("commit", "-qm", "mine")

	if err := f.ws.Pull(context.Background(), f.mainWT); codeOf(err) != model.ErrorCodeDiverged {
		t.Fatalf("fast-forward-only pull: err = %v, want Diverged", err)
	}

	f.setPullMode(model.PullModeRebase)
	if err := f.ws.Pull(context.Background(), f.mainWT); err != nil {
		t.Fatal(err)
	}
	if got := f.local.Git("log", "--format=%s", "-3"); got != "mine\nteammate\nfirst" {
		t.Errorf("history after rebase = %q", got)
	}
}

func TestPullThatConflictsLeavesTheMergeToFinish(t *testing.T) {
	f := newRemoteFixture(t)
	f.teammatePushes("theirs\n")
	f.local.WriteFile("file.txt", "ours\n")
	f.local.Git("commit", "-qam", "ours")
	f.setPullMode(model.PullModeMerge)

	err := f.ws.Pull(context.Background(), f.mainWT)
	if codeOf(err) != model.ErrorCodeOperationInProgress {
		t.Fatalf("err = %v, want the merge left in progress", err)
	}
	if got := f.local.Git("diff", "--name-only", "--diff-filter=U"); got != "file.txt" {
		t.Errorf("conflicted files = %q", got)
	}
}

func TestPullNeedsAnUpstream(t *testing.T) {
	f := newRemoteFixture(t)
	f.local.Git("checkout", "-qb", "topic")
	f.waitForHead("topic")

	if err := f.ws.Pull(context.Background(), f.mainWT); codeOf(err) != model.ErrorCodeNoUpstream {
		t.Errorf("err = %v, want NoUpstream", err)
	}
}

func TestPushPublishesAndUpdatesBranches(t *testing.T) {
	f := newRemoteFixture(t)
	ctx := context.Background()
	f.local.Git("checkout", "-qb", "topic")
	f.local.Commit("topic work")
	f.waitForHead("topic")

	if err := f.ws.Push(ctx, f.mainWT, "", false); err != nil {
		t.Fatal(err)
	}
	if upstream := f.local.Git("rev-parse", "--abbrev-ref", "topic@{upstream}"); upstream != "origin/topic" {
		t.Errorf("upstream = %q, want origin/topic", upstream)
	}

	f.local.Commit("more topic work")
	if err := f.ws.Push(ctx, f.mainWT, "", false); err != nil {
		t.Fatal(err)
	}
	if got, want := f.local.Git("ls-remote", "origin", "refs/heads/topic"), f.local.Git("rev-parse", "HEAD"); !strings.HasPrefix(got, want) {
		t.Errorf("origin topic = %q, want %s", got, want)
	}
}

func TestPushRejectedUntilForced(t *testing.T) {
	f := newRemoteFixture(t)
	ctx := context.Background()
	f.teammatePushes("theirs\n")
	f.local.Git("fetch", "-q", "origin")
	f.local.Commit("mine")
	f.waitForHead("main")

	if err := f.ws.Push(ctx, f.mainWT, "", false); codeOf(err) != model.ErrorCodePushRejected {
		t.Fatalf("err = %v, want PushRejected", err)
	}
	if err := f.ws.Push(ctx, f.mainWT, "", true); err != nil {
		t.Fatalf("force push: %v", err)
	}

	// The teammate pushes again, which this clone has not fetched.
	f.other.Git("fetch", "-q", "origin")
	f.other.Git("reset", "-q", "--hard", "origin/main")
	f.teammatePushes("again\n")
	f.local.Commit("mine again")
	f.waitForHead("main")
	if err := f.ws.Push(ctx, f.mainWT, "", true); codeOf(err) != model.ErrorCodePushRejected {
		t.Errorf("forcing over unfetched work: err = %v, want PushRejected", err)
	}
}
