package repo

import (
	"context"
	"io"
	"path/filepath"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
)

// Ignores asks git which directories it ignores in a worktree.
type Ignores struct{ Git *gitexec.Git }

// Dirs lists the absolute paths of the worktree's ignored directories.
func (i Ignores) Dirs(ctx context.Context, worktree string) ([]string, error) {
	out, err := i.Git.Run(ctx, worktree, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory")
	if err != nil {
		return nil, err
	}
	var dirs []string
	for _, entry := range strings.Split(string(out), "\x00") {
		if dir, ok := strings.CutSuffix(entry, "/"); ok {
			dirs = append(dirs, filepath.Join(worktree, filepath.FromSlash(dir)))
		}
	}
	if len(dirs) == 0 {
		return nil, nil
	}
	// A directory is also listed when everything in it happens to be
	// ignored, but a new file there may not be.
	return i.Filter(ctx, worktree, dirs)
}

// Filter returns those of dirs, absolute paths inside the worktree, that git
// ignores.
func (i Ignores) Filter(ctx context.Context, worktree string, dirs []string) ([]string, error) {
	var stdin strings.Builder
	for _, dir := range dirs {
		rel, err := filepath.Rel(worktree, dir)
		if err != nil {
			return nil, err
		}
		stdin.WriteString(filepath.ToSlash(rel))
		stdin.WriteByte(0)
	}
	var out []byte
	err := i.Git.Repo("", worktree).Stream(ctx, strings.NewReader(stdin.String()), func(r io.Reader) (err error) {
		out, err = io.ReadAll(r)
		return err
	}, "check-ignore", "-z", "--stdin")
	if gitexec.ExitCode(err) == 1 {
		return nil, nil // none of them is ignored
	}
	if err != nil {
		return nil, err
	}
	var ignored []string
	for _, rel := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		ignored = append(ignored, filepath.Join(worktree, filepath.FromSlash(rel)))
	}
	return ignored, nil
}
