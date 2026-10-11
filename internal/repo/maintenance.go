package repo

import (
	"context"
	"os"
	"path/filepath"

	"github.com/jyecusch/forkit/internal/gitexec"
)

// EnsureCommitGraph writes git's commit-graph file if the repository has
// none. It lets git stream topologically ordered history instead of walking
// everything first, which matters most on very large repositories.
func EnsureCommitGraph(ctx context.Context, git *gitexec.Git, loc Location) error {
	for _, name := range []string{"commit-graph", "commit-graphs"} {
		if _, err := os.Stat(filepath.Join(loc.CommonDir, "objects", "info", name)); err == nil {
			return nil
		}
	}
	_, err := git.Repo(loc.CommonDir, loc.WorkDir).Mutate(ctx, "commit-graph", "write", "--reachable", "--split")
	return err
}

// RefreshIndex updates the stat information cached in a worktree's index.
// Reads run without optional locks, so git status never saves this itself;
// without it, a fresh clone re-hashes every file on every status.
func RefreshIndex(ctx context.Context, git *gitexec.Git, loc Location, worktreePath string) error {
	_, err := git.Repo(loc.CommonDir, worktreePath).Mutate(ctx, "update-index", "-q", "--refresh")
	if gitexec.ExitCode(err) == 1 {
		return nil // exits 1 when files need updating, which is not a failure
	}
	return err
}
