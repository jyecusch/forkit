package gitexec_test

import (
	"bufio"
	"context"
	"errors"
	"io"
	"testing"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/gittest"
)

func newGit(t *testing.T) *gitexec.Git {
	t.Helper()
	g, err := gitexec.New(context.Background(), "", noop.NewTracerProvider().Tracer(""))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestRunReturnsStdout(t *testing.T) {
	fixture := gittest.New(t)
	oid := fixture.Commit("first")
	repo := newGit(t).Repo(fixture.Dir+"/.git", fixture.Dir)

	out, err := repo.Run(context.Background(), "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if got := string(out); got != oid+"\n" {
		t.Fatalf("got %q, want %q", got, oid)
	}
}

func TestRunOutsideRepoIsClassified(t *testing.T) {
	_, err := newGit(t).Run(context.Background(), t.TempDir(), "rev-parse", "HEAD")
	if !gitexec.IsNotARepo(err) {
		t.Fatalf("expected not-a-repo error, got %v", err)
	}
}

func TestStreamStopsEarlyWithoutError(t *testing.T) {
	fixture := gittest.New(t)
	for range 50 {
		fixture.Commit("c")
	}
	repo := newGit(t).Repo(fixture.Dir+"/.git", fixture.Dir)

	var first string
	errStop := errors.New("stop")
	err := repo.Stream(context.Background(), nil, func(r io.Reader) error {
		first, _ = bufio.NewReader(r).ReadString('\n')
		return errStop
	}, "log", "--format=%H")
	if !errors.Is(err, errStop) {
		t.Fatalf("expected the consumer's error, got %v", err)
	}
	if len(first) != 41 {
		t.Fatalf("expected one oid line, got %q", first)
	}
}

func TestParseVersion(t *testing.T) {
	cases := map[string]gitexec.Version{
		"git version 2.50.1 (Apple Git-155)": {Major: 2, Minor: 50, Patch: 1},
		"git version 2.45.windows.1":          {Major: 2, Minor: 45},
	}
	for output, want := range cases {
		got, err := gitexec.ParseVersion(output)
		if err != nil || got != want {
			t.Errorf("ParseVersion(%q) = %v, %v; want %v", output, got, err, want)
		}
	}
}

func TestRedactArgs(t *testing.T) {
	got := gitexec.RedactArgs([]string{
		"clone", "https://example.com/r.git", "git@github.com:o/r.git", "/home/ada/r",
		"--git-dir=/home/ada/r/.git", "refs/heads/main", "--", "secret/file.txt",
	})
	want := []string{
		"clone", "<url>", "<url>", "<path>",
		"--git-dir=<path>", "refs/heads/main", "--", "<path>",
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("arg %d: got %q, want %q", i, got[i], want[i])
		}
	}
}
