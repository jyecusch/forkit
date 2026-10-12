// Package gittest builds throwaway git repositories for tests.
package gittest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Repo is a repository in a temporary directory.
type Repo struct {
	t   testing.TB
	Dir string
}

// New initialises an empty repository whose first branch is main.
func New(t testing.TB) *Repo {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := &Repo{t: t, Dir: dir}
	r.Git("init", "--initial-branch=main")
	// Forkit reads the system's git config but these helpers do not, so line
	// endings are pinned where both see it, or Windows' autocrlf would
	// make files Forkit checks out look modified here.
	r.Git("config", "core.autocrlf", "false")
	return r
}

// Git runs git in the repository with a fixed identity and clock, failing the
// test on error, and returns trimmed stdout.
func (r *Repo) Git(args ...string) string {
	r.t.Helper()
	return r.GitIn(r.Dir, args...)
}

// GitIn is Git run in another directory, such as a linked worktree.
func (r *Repo) GitIn(dir string, args ...string) string {
	r.t.Helper()
	return r.run(dir, "2026-01-01T00:00:00Z", args...)
}

// CommitAt creates an empty commit dated when and returns its oid.
func (r *Repo) CommitAt(message string, when time.Time) string {
	r.t.Helper()
	r.run(r.Dir, when.UTC().Format(time.RFC3339), "commit", "--allow-empty", "-q", "-m", message)
	return r.Git("rev-parse", "HEAD")
}

func (r *Repo) run(dir, date string, args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=ada@example.com",
		"GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=ada@example.com",
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date,
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// Commit creates an empty commit and returns its oid.
func (r *Repo) Commit(message string) string {
	r.t.Helper()
	r.Git("commit", "--allow-empty", "-q", "-m", message)
	return r.Git("rev-parse", "HEAD")
}

// WriteFile writes content to a path relative to the repository root.
func (r *Repo) WriteFile(path, content string) {
	r.t.Helper()
	full := filepath.Join(r.Dir, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}
