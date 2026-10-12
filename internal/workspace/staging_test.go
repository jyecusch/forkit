package workspace_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// staged lists the paths in the index that differ from HEAD.
func (f *checkoutFixture) staged() string {
	return f.git.Git("diff", "--cached", "--name-only")
}

func TestStageAndUnstage(t *testing.T) {
	ctx := context.Background()
	f := newCheckoutFixture(t)
	f.git.WriteFile("file.txt", "changed\n")
	f.git.WriteFile("[id].txt", "a name that looks like a pattern\n")
	f.git.WriteFile("other.txt", "not staged\n")

	if err := f.ws.Stage(ctx, f.mainWT, []string{"file.txt", "[id].txt"}); err != nil {
		t.Fatal(err)
	}
	if got := f.staged(); got != "[id].txt\nfile.txt" {
		t.Fatalf("staged = %q", got)
	}

	if err := f.ws.Unstage(ctx, f.mainWT, []string{"file.txt"}); err != nil {
		t.Fatal(err)
	}
	if got := f.staged(); got != "[id].txt" {
		t.Fatalf("after unstaging, staged = %q", got)
	}
	if content := f.git.Git("show", ":file.txt"); content != "main" {
		t.Errorf("unstaging changed the index to %q, want HEAD's content", content)
	}
}

func TestStageADeletion(t *testing.T) {
	ctx := context.Background()
	f := newCheckoutFixture(t)
	if err := os.Remove(filepath.Join(f.git.Dir, "file.txt")); err != nil {
		t.Fatal(err)
	}

	if err := f.ws.Stage(ctx, f.mainWT, []string{"file.txt"}); err != nil {
		t.Fatal(err)
	}
	if got := f.git.Git("diff", "--cached", "--name-status"); got != "D\tfile.txt" {
		t.Errorf("staged = %q, want the deletion", got)
	}
}

func TestCommitAndAmend(t *testing.T) {
	ctx := context.Background()
	f := newCheckoutFixture(t)

	if _, err := f.ws.Commit(ctx, f.mainWT, "nothing yet", false); err == nil {
		t.Error("committing with nothing staged succeeded")
	}

	f.git.WriteFile("file.txt", "changed\n")
	if err := f.ws.Stage(ctx, f.mainWT, []string{"file.txt"}); err != nil {
		t.Fatal(err)
	}
	oid, err := f.ws.Commit(ctx, f.mainWT, "#12 change the file\n\nWith a body.\n", false)
	if err != nil {
		t.Fatal(err)
	}
	if head := f.git.Git("rev-parse", "HEAD"); string(oid) != head {
		t.Errorf("returned %s, HEAD is %s", oid, head)
	}
	if message, _ := f.ws.HeadMessage(ctx, f.mainWT); message != "#12 change the file\n\nWith a body." {
		t.Errorf("message = %q; a line starting with # must survive", message)
	}

	amended, err := f.ws.Commit(ctx, f.mainWT, "Change the file", true)
	if err != nil {
		t.Fatal(err)
	}
	if amended == oid || f.git.Git("log", "-1", "--format=%s") != "Change the file" {
		t.Errorf("amend did not replace the commit")
	}
	if count := f.git.Git("rev-list", "--count", "HEAD"); count != "2" {
		t.Errorf("history has %s commits, want the amend to replace one", count)
	}
}

func TestCommitNeedsAMessage(t *testing.T) {
	f := newCheckoutFixture(t)
	f.git.WriteFile("file.txt", "changed\n")
	_ = f.ws.Stage(context.Background(), f.mainWT, []string{"file.txt"})
	if _, err := f.ws.Commit(context.Background(), f.mainWT, "  \n", false); err == nil || !strings.Contains(err.Error(), "message") {
		t.Errorf("err = %v, want a request for a message", err)
	}
}
