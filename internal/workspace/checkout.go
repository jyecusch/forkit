package workspace

import (
	"context"
	"fmt"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
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
		return model.CheckoutResult{Branch: r.headBranch(wt.ID)}, err
	}

	var result model.CheckoutResult
	err = r.runOperation(ctx, model.OperationKindCheckout, wt.ID, func(ctx context.Context, _ func(gitexec.Progress)) error {
		result, err = r.checkout(ctx, wt, ref, args, mode)
		return err
	})
	if refreshErr := r.refresh(ctx, watch.Change{Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{wt.ID: true}}); err == nil {
		err = refreshErr
	}
	if err == nil {
		result.Branch = r.headBranch(wt.ID)
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
	remoteName, known := "", false
	for _, rm := range r.remotes {
		if rm.ID == remote.RemoteID {
			remoteName, known = rm.Name, true
		}
	}
	name := strings.TrimPrefix(remote.ShortName, remoteName+"/")
	var local model.Ref
	hasLocal := false
	for _, ref := range r.refs {
		if ref.Kind == model.RefKindLocalBranch && ref.ShortName == name {
			local, hasLocal = ref, true
		}
	}
	r.mu.Unlock()

	switch {
	case !known:
		return nil, apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("%s does not belong to a configured remote.", remote.ShortName))
	case !hasLocal:
		return []string{"checkout", "--track", "-b", name, remote.FullName, "--"}, nil
	case local.UpstreamRefID == remote.ID:
		return r.checkoutArgs(local, wt)
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

	before, err := stashTip(ctx, git)
	if err != nil {
		return model.CheckoutResult{}, err
	}
	if _, err := git.Mutate(ctx, "stash", "push", "-m", "Forkit: before checking out "+ref.ShortName); err != nil {
		return model.CheckoutResult{}, err
	}
	ours, err := stashTip(ctx, git)
	if err != nil {
		return model.CheckoutResult{}, err
	}
	if ours == before {
		// Nothing was stashed after all, so there is nothing to reapply.
		_, err := git.Mutate(ctx, args...)
		return model.CheckoutResult{}, err
	}
	if _, err := git.Mutate(ctx, args...); err != nil {
		return model.CheckoutResult{}, joinRestoreError(err, popStash(ctx, git, ours))
	}
	if popErr := popStash(ctx, git, ours); popErr != nil {
		// A conflicting pop leaves the stash in place and the files unmerged.
		_, after, err := repo.ReadStatus(ctx, r.ws.git, wt.ID, wt.Path)
		if err == nil && after.Conflicted > 0 {
			return model.CheckoutResult{ReapplyConflicted: true}, nil
		}
		return model.CheckoutResult{}, popErr
	}
	return model.CheckoutResult{}, nil
}

// stashTip returns the commit of the newest stash, or "" when there is none.
func stashTip(ctx context.Context, git *gitexec.Repo) (string, error) {
	out, err := git.Run(ctx, "rev-parse", "-q", "--verify", "refs/stash")
	if gitexec.ExitCode(err) == 1 {
		return "", nil
	}
	return strings.TrimSpace(string(out)), err
}

// popStash reapplies the stash entry made for a checkout, refusing if
// something else has stashed since, which would put the wrong changes back.
func popStash(ctx context.Context, git *gitexec.Repo, ours string) error {
	tip, err := stashTip(ctx, git)
	if err != nil {
		return err
	}
	if tip != ours {
		return apperr.New(model.ErrorCodeGitFailed, "Another stash was made during checkout, so your changes were left in the stash.")
	}
	_, err = git.Mutate(ctx, "stash", "pop", "stash@{0}")
	return err
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

// headBranch returns the branch a worktree has checked out, or "" when its
// HEAD is detached.
func (r *openRepo) headBranch(id model.WorktreeID) model.RefID {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, wt := range r.worktrees {
		if wt.ID == id && wt.Head.Kind == model.HeadKindBranch {
			return wt.Head.RefID
		}
	}
	return ""
}

// WorktreeInfo returns an open worktree by ID.
func (w *Workspace) WorktreeInfo(id model.WorktreeID) (repo.WorktreeInfo, error) {
	_, wt, err := w.worktree(id)
	return wt, err
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
