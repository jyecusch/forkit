package workspace

import (
	"context"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

// Stash saves a worktree's uncommitted changes, untracked files included, as
// the newest stash and leaves the worktree clean. Without a message git
// names the stash after the checked-out commit.
func (w *Workspace) Stash(ctx context.Context, worktreeID model.WorktreeID, message string) error {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return err
	}
	_, summary, err := repo.ReadStatus(ctx, w.git, wt.ID, wt.Path)
	if err != nil {
		return err
	}
	if summary.Staged+summary.Unstaged+summary.Untracked+summary.Conflicted == 0 {
		return apperr.New(model.ErrorCodeInvalidArgument, "There are no changes to stash.")
	}
	args := []string{"stash", "push", "--include-untracked"}
	if message = strings.TrimSpace(message); message != "" {
		args = append(args, "--message", message)
	}
	err = r.runOperation(ctx, model.OperationKindStash, wt.ID, func(ctx context.Context, _ func(gitexec.Progress)) error {
		_, err := w.git.Repo(r.loc.CommonDir, wt.Path).Mutate(ctx, args...)
		return err
	})
	return r.refreshAfterStash(ctx, wt.ID, err)
}

// ApplyStash puts a stash's changes into a worktree. With pop the stash is
// then dropped, unless its changes conflicted, when it is kept so they can
// be applied again.
func (w *Workspace) ApplyStash(ctx context.Context, worktreeID model.WorktreeID, stashID model.RefID, pop bool) (model.ApplyStashResult, error) {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return model.ApplyStashResult{}, err
	}
	stash, err := r.stash(stashID)
	if err != nil {
		return model.ApplyStashResult{}, err
	}
	var result model.ApplyStashResult
	err = r.runOperation(ctx, model.OperationKindApplyStash, wt.ID, func(ctx context.Context, _ func(gitexec.Progress)) error {
		git := w.git.Repo(r.loc.CommonDir, wt.Path)
		// Applied by commit, so the stash applied is the one asked for even
		// if others were made since the list was read.
		if _, err := git.Mutate(ctx, "stash", "apply", string(stash.TargetOID)); err != nil {
			_, summary, statusErr := repo.ReadStatus(ctx, w.git, wt.ID, wt.Path)
			if statusErr != nil || summary.Conflicted == 0 {
				return err
			}
			result.Conflicted = true
			return nil
		}
		if !pop {
			return nil
		}
		return r.dropStash(ctx, git, stash)
	})
	return result, r.refreshAfterStash(ctx, wt.ID, err)
}

// DropStash deletes a stash.
func (w *Workspace) DropStash(ctx context.Context, repoID model.RepoID, stashID model.RefID) error {
	r, err := w.repo(repoID)
	if err != nil {
		return err
	}
	stash, err := r.stash(stashID)
	if err != nil {
		return err
	}
	err = r.runOperation(ctx, model.OperationKindDropStash, "", func(ctx context.Context, _ func(gitexec.Progress)) error {
		return r.dropStash(ctx, w.git.Repo(r.loc.CommonDir, r.loc.WorkDir), stash)
	})
	return r.refreshAfterStash(ctx, "", err)
}

// stash returns the stash ref named by id.
func (r *openRepo) stash(id model.RefID) (model.Ref, error) {
	ref, err := r.ref(id)
	if err == nil && ref.Kind != model.RefKindStash {
		err = apperr.New(model.ErrorCodeInvalidArgument, ref.ShortName+" is not a stash.")
	}
	return ref, err
}

// dropStash drops stash by its place in the list, refusing if that place
// now holds another stash, as it does once a stash above it is dropped.
func (r *openRepo) dropStash(ctx context.Context, git *gitexec.Repo, stash model.Ref) error {
	out, err := git.Run(ctx, "rev-parse", "-q", "--verify", stash.FullName)
	if err != nil || model.OID(strings.TrimSpace(string(out))) != stash.TargetOID {
		return apperr.New(model.ErrorCodeRefNotFound, "The stash list has changed since it was read, so nothing was dropped. Try again.")
	}
	_, err = git.Mutate(ctx, "stash", "drop", "-q", stash.FullName)
	return err
}

// refreshAfterStash reads the stash list again, and the status of the
// worktree the stash came from or went to, if any. It returns opErr, or the
// refresh's error when the operation succeeded.
func (r *openRepo) refreshAfterStash(ctx context.Context, worktree model.WorktreeID, opErr error) error {
	change := watch.Change{Refs: true}
	if worktree != "" {
		change.Status = map[model.WorktreeID]bool{worktree: true}
	}
	if err := r.refresh(ctx, change); opErr == nil {
		return err
	}
	return opErr
}

// IsStash reports whether oid is one of an open repository's stashes.
func (w *Workspace) IsStash(repoID model.RepoID, oid model.OID) bool {
	r, err := w.repo(repoID)
	if err != nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ref := range r.refs {
		if ref.Kind == model.RefKindStash && ref.TargetOID == oid {
			return true
		}
	}
	return false
}
