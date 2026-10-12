package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

// CreateWorktree adds a worktree on a new branch started from base, or on
// base itself when newBranch is empty (base must then be a local branch that
// is not checked out). An empty path puts the worktree beside the main one.
func (w *Workspace) CreateWorktree(ctx context.Context, repoID model.RepoID, base model.RefID, newBranch, path string) (model.Worktree, error) {
	r, err := w.repo(repoID)
	if err != nil {
		return model.Worktree{}, err
	}
	ref, err := r.ref(base)
	if err != nil {
		return model.Worktree{}, err
	}
	branch := newBranch
	if branch == "" {
		if ref.Kind != model.RefKindLocalBranch || ref.CheckedOutInWorktreeID != "" {
			return model.Worktree{}, apperr.New(model.ErrorCodeInvalidArgument, "Choose a local branch that is not checked out, or name a new branch.")
		}
		branch = ref.ShortName
	} else if err := r.validateBranchName(ctx, newBranch); err != nil {
		return model.Worktree{}, err
	}
	switch {
	case path == "":
		path = r.defaultWorktreePath(branch)
	case !filepath.IsAbs(path):
		return model.Worktree{}, apperr.New(model.ErrorCodeInvalidArgument, "The worktree location must be an absolute path.")
	}
	if _, err := os.Stat(path); err == nil {
		return model.Worktree{}, apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("%s already exists.", path))
	}

	args := []string{"worktree", "add", path, ref.ShortName}
	if newBranch != "" {
		args = []string{"worktree", "add", "-b", newBranch, path, ref.FullName}
	}
	err = r.runOperation(ctx, model.OperationKindCreateWorktree, "", func(ctx context.Context) error {
		_, err := w.git.Repo(r.loc.CommonDir, r.loc.WorkDir).Mutate(ctx, args...)
		return err
	})
	if err != nil {
		return model.Worktree{}, err
	}
	if err := r.refresh(ctx, watch.Change{Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{}}); err != nil {
		return model.Worktree{}, err
	}
	return r.worktreeAt(path)
}

// RemoveWorktree deletes a linked worktree. Without force it refuses one
// with uncommitted changes.
func (w *Workspace) RemoveWorktree(ctx context.Context, worktreeID model.WorktreeID, force bool) error {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return err
	}
	if wt.IsMain {
		return apperr.New(model.ErrorCodeInvalidArgument, "The main worktree cannot be removed.")
	}
	args := []string{"worktree", "remove", wt.Path}
	if force {
		args = []string{"worktree", "remove", "--force", wt.Path}
	}
	err = r.runOperation(ctx, model.OperationKindRemoveWorktree, wt.ID, func(ctx context.Context) error {
		_, err := w.git.Repo(r.loc.CommonDir, r.loc.WorkDir).Mutate(ctx, args...)
		if !force && gitexec.IsWorktreeDirty(err) {
			return apperr.New(model.ErrorCodeDirtyWorktree, fmt.Sprintf("%s has uncommitted changes.", filepath.Base(wt.Path)))
		}
		return err
	})
	if err != nil {
		return err
	}
	return r.refresh(ctx, watch.Change{Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{}})
}

func (r *openRepo) validateBranchName(ctx context.Context, name string) error {
	if _, err := r.ws.git.Run(ctx, r.loc.WorkDir, "check-ref-format", "--branch", name); err != nil {
		return apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("%q is not a valid branch name.", name))
	}
	if _, err := r.ref(repo.RefIDFor(r.loc.ID, "refs/heads/"+name)); err == nil {
		return apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("A branch named %s already exists.", name))
	}
	return nil
}

var unsafePathChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// defaultWorktreePath places a worktree next to the main one, named after
// the repository and branch, e.g. ~/code/forkit-feature-tabs.
func (r *openRepo) defaultWorktreePath(branch string) string {
	main := r.loc.WorkDir
	return filepath.Join(filepath.Dir(main), repoName(r.loc)+"-"+unsafePathChars.ReplaceAllString(branch, "-"))
}

func (r *openRepo) worktreeAt(path string) (model.Worktree, error) {
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return model.Worktree{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, wt := range r.worktrees {
		if wt.Path == canonical || wt.Path == path {
			return wt.Worktree, nil
		}
	}
	return model.Worktree{}, apperr.New(model.ErrorCodeWorktreeNotFound, "the new worktree was not found")
}
