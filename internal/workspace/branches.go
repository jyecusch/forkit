package workspace

import (
	"context"
	"fmt"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/watch"
)

// DeleteBranches deletes local branches, whether merged or not, and deletes
// remote branches from their remotes. A remote branch the remote no longer
// has only loses its remote-tracking ref. Nothing is deleted if any ref is
// not a branch or is checked out.
func (w *Workspace) DeleteBranches(ctx context.Context, repoID model.RepoID, refIDs []model.RefID) error {
	r, err := w.repo(repoID)
	if err != nil {
		return err
	}
	var local []string
	remote := map[string][]model.Ref{}
	var remoteOrder []string
	for _, id := range refIDs {
		ref, err := r.ref(id)
		if err != nil {
			return err
		}
		switch ref.Kind {
		case model.RefKindLocalBranch:
			if ref.CheckedOutInWorktreeID != "" {
				return apperr.New(model.ErrorCodeInvalidArgument,
					fmt.Sprintf("%s is checked out, so it can't be deleted. Switch to another branch first.", ref.ShortName)).
					WithDetail("worktreeId", string(ref.CheckedOutInWorktreeID))
			}
			local = append(local, ref.ShortName)
		case model.RefKindRemoteBranch:
			name := r.remoteName(ref.RemoteID)
			if name == "" {
				return apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("%s does not belong to a configured remote.", ref.ShortName))
			}
			if _, seen := remote[name]; !seen {
				remoteOrder = append(remoteOrder, name)
			}
			remote[name] = append(remote[name], ref)
		default:
			return apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("%s is not a branch.", ref.ShortName))
		}
	}

	git := w.git.Repo(r.loc.CommonDir, r.loc.WorkDir)
	err = r.runOperation(ctx, model.OperationKindDeleteBranches, "", func(ctx context.Context, progress func(gitexec.Progress)) error {
		if len(local) > 0 {
			if _, err := git.Mutate(ctx, append([]string{"branch", "-D", "--"}, local...)...); err != nil {
				return err
			}
		}
		for _, name := range remoteOrder {
			if err := deleteRemoteBranches(ctx, git, progress, name, remote[name]); err != nil {
				return err
			}
		}
		return nil
	})
	refreshErr := r.refresh(context.WithoutCancel(ctx), watch.Change{Refs: true})
	if err != nil {
		return remoteError(err)
	}
	return refreshErr
}

func deleteRemoteBranches(ctx context.Context, git *gitexec.Repo, progress func(gitexec.Progress), remote string, refs []model.Ref) error {
	args := []string{"push", "--progress", remote}
	for _, ref := range refs {
		args = append(args, ":refs/heads/"+strings.TrimPrefix(ref.FullName, "refs/remotes/"+remote+"/"))
	}
	_, err := git.Network(ctx, progress, args...)
	if !gitexec.IsRemoteRefMissing(err) {
		return err
	}
	// The push still deleted the branches the remote had, along with their
	// tracking refs. The rest were deleted elsewhere, so their tracking refs
	// are stale.
	for _, ref := range refs {
		if _, err := git.Mutate(ctx, "update-ref", "-d", ref.FullName); err != nil {
			return err
		}
	}
	return nil
}
