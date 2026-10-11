// Package repo builds the synced entities (repositories, worktrees, refs,
// remotes, file status) from git's porcelain output.
package repo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// Location identifies an on-disk repository.
type Location struct {
	ID        model.RepoID
	CommonDir string
	// WorkDir is the directory git commands run in: the main worktree, or the
	// common dir of a bare repository.
	WorkDir string
	IsBare  bool
}

// Locate finds the repository containing path.
func Locate(ctx context.Context, git *gitexec.Git, path string) (Location, error) {
	out, err := git.Run(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--is-bare-repository")
	if err != nil {
		return Location{}, err
	}
	fields := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(fields) != 2 {
		return Location{}, fmt.Errorf("unexpected rev-parse output %q", out)
	}
	commonDir, err := canonicalPath(fields[0])
	if err != nil {
		return Location{}, err
	}
	loc := Location{ID: RepoIDFor(commonDir), CommonDir: commonDir, IsBare: fields[1] == "true"}
	if loc.IsBare {
		loc.WorkDir = commonDir
		return loc, nil
	}
	loc.WorkDir, err = mainWorktreePath(ctx, git, commonDir)
	return loc, err
}

// mainWorktreePath asks git rather than assuming the common dir's parent,
// because core.worktree or a separate git dir can put it elsewhere.
func mainWorktreePath(ctx context.Context, git *gitexec.Git, commonDir string) (string, error) {
	out, err := git.Run(ctx, commonDir, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return "", err
	}
	first, _, _ := strings.Cut(string(out), "\x00")
	path, ok := strings.CutPrefix(first, "worktree ")
	if !ok {
		return "", fmt.Errorf("unexpected worktree list output %q", first)
	}
	return canonicalPath(path)
}

func canonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// RepoIDFor derives a stable ID from a repository's canonical common dir.
func RepoIDFor(commonDir string) model.RepoID {
	return model.RepoID(shortHash(commonDir))
}

// WorktreeIDFor derives a stable ID from a worktree's absolute path.
func WorktreeIDFor(path string) model.WorktreeID {
	return model.WorktreeID(shortHash(path))
}

// RefIDFor combines a repository ID and a full ref name.
func RefIDFor(repoID model.RepoID, fullName string) model.RefID {
	return model.RefID(string(repoID) + ":" + fullName)
}

// RemoteIDFor combines a repository ID and a remote name.
func RemoteIDFor(repoID model.RepoID, name string) model.RemoteID {
	return model.RemoteID(string(repoID) + ":" + name)
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:8])
}
