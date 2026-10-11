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
