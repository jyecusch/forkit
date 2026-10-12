package workspace

import (
	"context"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

// Stage adds the current contents of paths in a worktree to its index,
// including deletions and untracked files.
func (w *Workspace) Stage(ctx context.Context, worktreeID model.WorktreeID, paths []string) error {
	return w.changeIndex(ctx, worktreeID, paths, func(wt repo.WorktreeInfo) []string {
		return []string{"add", "--all"}
	})
}

// Unstage returns paths in a worktree's index to their state in HEAD,
// leaving the files themselves alone.
func (w *Workspace) Unstage(ctx context.Context, worktreeID model.WorktreeID, paths []string) error {
	return w.changeIndex(ctx, worktreeID, paths, func(wt repo.WorktreeInfo) []string {
		if wt.Head.Kind == model.HeadKindUnborn {
			// Before the first commit there is no HEAD to restore from.
			return []string{"rm", "--cached", "-r", "--quiet"}
		}
		return []string{"restore", "--staged"}
	})
}

func (w *Workspace) changeIndex(ctx context.Context, worktreeID model.WorktreeID, paths []string, command func(repo.WorktreeInfo) []string) error {
	if len(paths) == 0 {
		return apperr.New(model.ErrorCodeInvalidArgument, "no paths given")
	}
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return err
	}
	args := append(command(wt), "--")
	for _, path := range paths {
		// Literal, so a name such as "[id].tsx" is not read as a pattern.
		args = append(args, ":(literal)"+path)
	}
	_, err = w.git.Repo(r.loc.CommonDir, wt.Path).Mutate(ctx, args...)
	if refreshErr := r.refresh(ctx, watch.Change{Status: map[model.WorktreeID]bool{wt.ID: true}}); err == nil {
		err = refreshErr
	}
	return err
}

// Commit records a worktree's staged changes with message, or with amend
// replaces its last commit, and returns the new commit.
func (w *Workspace) Commit(ctx context.Context, worktreeID model.WorktreeID, message string, amend bool) (model.OID, error) {
	if strings.TrimSpace(message) == "" {
		return "", apperr.New(model.ErrorCodeInvalidArgument, "Write a commit message first.")
	}
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return "", err
	}
	if amend && wt.Head.Kind == model.HeadKindUnborn {
		return "", apperr.New(model.ErrorCodeInvalidArgument, "There is no commit to amend yet.")
	}
	if !amend {
		_, summary, err := repo.ReadStatus(ctx, w.git, wt.ID, wt.Path)
		if err != nil {
			return "", err
		}
		if summary.Staged == 0 {
			return "", apperr.New(model.ErrorCodeInvalidArgument, "Stage some changes to commit first.")
		}
	}

	git := w.git.Repo(r.loc.CommonDir, wt.Path)
	args := []string{"commit", "--file=-", "--cleanup=whitespace"}
	if amend {
		args = append(args, "--amend")
	}
	_, err = git.MutateWithInput(ctx, strings.NewReader(message), args...)
	if refreshErr := r.refresh(ctx, watch.Change{Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{wt.ID: true}}); err == nil {
		err = refreshErr
	}
	if err != nil {
		return "", err
	}
	head, err := git.Run(ctx, "rev-parse", "HEAD")
	return model.OID(strings.TrimSpace(string(head))), err
}

// HeadMessage returns the full message of a worktree's checked-out commit,
// to start an amend from.
func (w *Workspace) HeadMessage(ctx context.Context, worktreeID model.WorktreeID) (string, error) {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return "", err
	}
	if wt.Head.Kind == model.HeadKindUnborn {
		return "", nil
	}
	out, err := w.git.Repo(r.loc.CommonDir, wt.Path).Run(ctx, "log", "-1", "--format=%B", "HEAD", "--")
	return strings.TrimRight(string(out), "\n"), err
}
