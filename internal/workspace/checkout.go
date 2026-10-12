package workspace

import (
	"context"
	"fmt"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

// Checkout switches a worktree to a ref. Local branches are checked out,
// remote branches get a local tracking branch (or their existing one), and
// tags and stashes are checked out as a detached HEAD. mode decides what
// happens to uncommitted changes.
func (w *Workspace) Checkout(ctx context.Context, worktreeID model.WorktreeID, refID model.RefID, mode model.CheckoutMode) (model.CheckoutResult, error) {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return model.CheckoutResult{}, err
	}
	ref, err := r.ref(refID)
	if err != nil {
		return model.CheckoutResult{}, err
	}
	if wt.Operation != model.WorktreeOperationNone {
		return model.CheckoutResult{}, apperr.New(model.ErrorCodeOperationInProgress,
			fmt.Sprintf("Finish or abort the %s in progress before checking out.", wt.Operation)).
			WithDetail("operation", string(wt.Operation))
	}
	args, err := r.checkoutArgs(ref, wt)
	if err != nil || args == nil {
		return model.CheckoutResult{}, err
	}

	var result model.CheckoutResult
	err = r.runOperation(ctx, model.OperationKindCheckout, wt.ID, func(ctx context.Context) error {
		result, err = r.checkout(ctx, wt, ref, args, mode)
		return err
	})
	if refreshErr := r.refresh(ctx, watch.Change{Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{wt.ID: true}}); err == nil {
		err = refreshErr
	}
	return result, err
}

// checkoutArgs returns the git arguments that check out ref, or nil when the
// worktree is already on it.
func (r *openRepo) checkoutArgs(ref model.Ref, wt repo.WorktreeInfo) ([]string, error) {
	switch ref.Kind {
	case model.RefKindLocalBranch:
		switch ref.CheckedOutInWorktreeID {
		case "":
			return []string{"checkout", ref.ShortName, "--"}, nil
		case wt.ID:
			return nil, nil
		}
		return nil, apperr.New(model.ErrorCodeBranchCheckedOutElsewhere,
			fmt.Sprintf("%s is checked out in another worktree.", ref.ShortName)).
			WithDetail("worktreeId", string(ref.CheckedOutInWorktreeID))
	case model.RefKindRemoteBranch:
		return r.remoteCheckoutArgs(ref, wt)
	case model.RefKindTag:
		return []string{"checkout", "--detach", ref.FullName, "--"}, nil
	}
	return []string{"checkout", "--detach", string(ref.TargetOID), "--"}, nil
}

// remoteCheckoutArgs checks out the local branch tracking a remote branch,
// creating it when there is none.
func (r *openRepo) remoteCheckoutArgs(remote model.Ref, wt repo.WorktreeInfo) ([]string, error) {
	r.mu.Lock()
	remoteName := ""
	for _, rm := range r.remotes {
		if rm.ID == remote.RemoteID {
			remoteName = rm.Name
		}
	}
	name := strings.TrimPrefix(remote.ShortName, remoteName+"/")
	var local *model.Ref
	for i := range r.refs {
		if r.refs[i].Kind == model.RefKindLocalBranch && r.refs[i].ShortName == name {
			local = &r.refs[i]
		}
	}
	r.mu.Unlock()

	switch {
	case local == nil:
		return []string{"checkout", "--track", "-b", name, remote.FullName, "--"}, nil
	case local.UpstreamRefID == remote.ID:
		return r.checkoutArgs(*local, wt)
	}
	return nil, apperr.New(model.ErrorCodeInvalidArgument,
		fmt.Sprintf("A local branch named %s already exists and does not track %s.", name, remote.ShortName))
}

func (r *openRepo) checkout(ctx context.Context, wt repo.WorktreeInfo, ref model.Ref, args []string, mode model.CheckoutMode) (model.CheckoutResult, error) {
	git := r.ws.git.Repo(r.loc.CommonDir, wt.Path)
	_, summary, err := repo.ReadStatus(ctx, r.ws.git, wt.ID, wt.Path)
	if err != nil {
		return model.CheckoutResult{}, err
	}
	changes := summary.Staged + summary.Unstaged + summary.Conflicted
	if changes == 0 || mode == model.CheckoutModeCarry {
		_, err := git.Mutate(ctx, args...)
		return model.CheckoutResult{}, err
	}
	if mode != model.CheckoutModeStash {
		return model.CheckoutResult{}, apperr.New(model.ErrorCodeDirtyWorktree,
			fmt.Sprintf("This worktree has %d uncommitted %s.", changes, plural(changes, "change", "changes"))).
			WithDetail("changes", fmt.Sprint(changes))
	}

	if _, err := git.Mutate(ctx, "stash", "push", "-m", "Forkit: before checking out "+ref.ShortName); err != nil {
		return model.CheckoutResult{}, err
	}
	if _, err := git.Mutate(ctx, args...); err != nil {
		_, popErr := git.Mutate(ctx, "stash", "pop")
		return model.CheckoutResult{}, joinRestoreError(err, popErr)
	}
	if _, popErr := git.Mutate(ctx, "stash", "pop"); popErr != nil {
		// A conflicting pop leaves the stash in place and the files unmerged.
		_, after, err := repo.ReadStatus(ctx, r.ws.git, wt.ID, wt.Path)
		if err == nil && after.Conflicted > 0 {
			return model.CheckoutResult{ReapplyConflicted: true}, nil
		}
		return model.CheckoutResult{}, popErr
	}
	return model.CheckoutResult{}, nil
}

// joinRestoreError reports a failed checkout, noting if the changes stashed
// before it could not be put back.
func joinRestoreError(checkoutErr, popErr error) error {
	if popErr == nil {
		return checkoutErr
	}
	return fmt.Errorf("%w (your changes are kept in the stash: %v)", checkoutErr, popErr)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// worktree finds an open worktree by ID.
func (w *Workspace) worktree(id model.WorktreeID) (*openRepo, repo.WorktreeInfo, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, r := range w.repos {
		r.mu.Lock()
		for _, wt := range r.worktrees {
			if wt.ID == id {
				r.mu.Unlock()
				return r, wt, nil
			}
		}
		r.mu.Unlock()
	}
	return nil, repo.WorktreeInfo{}, apperr.New(model.ErrorCodeWorktreeNotFound, "worktree not found")
}

func (r *openRepo) ref(id model.RefID) (model.Ref, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ref := range r.refs {
		if ref.ID == id {
			return ref, nil
		}
	}
	return model.Ref{}, apperr.New(model.ErrorCodeRefNotFound, "ref not found")
}
