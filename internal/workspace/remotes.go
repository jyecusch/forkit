package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

const (
	// fetchCheckInterval is how often the background fetcher checks whether
	// a fetch is due.
	fetchCheckInterval = time.Minute
	// backgroundFetchTimeout ends a background fetch that has stalled.
	backgroundFetchTimeout = 2 * time.Minute
	// maxFetchBackoff caps how many times the interval doubles after
	// background fetches fail.
	maxFetchBackoff = 3
)

// fetchRecord is what Forkit knows about fetching from one remote, which git
// does not record.
type fetchRecord struct {
	state model.FetchState
	at    model.UnixMillis
}

// Fetch updates the remote-tracking branches of remote, or of every remote
// when it is empty.
func (w *Workspace) Fetch(ctx context.Context, repoID model.RepoID, remote string) error {
	r, err := w.repo(repoID)
	if err != nil {
		return err
	}
	names := r.remoteNames()
	if remote != "" {
		if !slices.Contains(names, remote) {
			return apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("There is no remote named %s.", remote))
		}
		names = []string{remote}
	}
	return r.runOperation(ctx, model.OperationKindFetch, "", func(ctx context.Context, progress func(gitexec.Progress)) error {
		return r.fetch(ctx, names, progress)
	})
}

// Pull brings a worktree's branch up to date with its upstream. It fetches
// the upstream's remote, then fast-forwards, merges or rebases as the
// preferences say, setting uncommitted changes aside while it does.
func (w *Workspace) Pull(ctx context.Context, worktreeID model.WorktreeID) error {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return err
	}
	if wt.Operation != model.WorktreeOperationNone {
		return apperr.New(model.ErrorCodeOperationInProgress,
			fmt.Sprintf("Finish or abort the %s in progress before pulling.", wt.Operation)).
			WithDetail("operation", string(wt.Operation))
	}
	t, err := r.tracking(wt)
	if err != nil {
		return err
	}
	mode := w.prefs.Get().Git.PullMode
	err = r.runOperation(ctx, model.OperationKindPull, wt.ID, func(ctx context.Context, progress func(gitexec.Progress)) error {
		if t.remote != "" {
			if err := r.fetch(ctx, []string{t.remote}, progress); err != nil {
				return err
			}
		}
		_, err := w.git.Repo(r.loc.CommonDir, wt.Path).Mutate(ctx, pullArgs(mode, t.upstream.FullName)...)
		return err
	})
	refreshErr := r.refresh(context.WithoutCancel(ctx), watch.Change{Refs: true, Worktrees: true, Status: map[model.WorktreeID]bool{wt.ID: true}})
	if err != nil {
		return r.pullError(err, wt.ID, t)
	}
	return refreshErr
}

func pullArgs(mode model.PullMode, upstream string) []string {
	switch mode {
	case model.PullModeMerge:
		return []string{"merge", "--no-edit", "--autostash", upstream}
	case model.PullModeRebase:
		return []string{"rebase", "--autostash", upstream}
	}
	return []string{"merge", "--ff-only", "--autostash", upstream}
}

func (r *openRepo) pullError(err error, wt model.WorktreeID, t tracking) error {
	if gitexec.IsNotFastForward(err) {
		return apperr.New(model.ErrorCodeDiverged, fmt.Sprintf(
			"%s and %s have both changed, so %s can't simply move forward. Set pulls to merge or rebase in Settings → Git.",
			t.branch.ShortName, t.upstream.ShortName, t.branch.ShortName))
	}
	if operation := r.operationIn(wt); operation != model.WorktreeOperationNone {
		return apperr.New(model.ErrorCodeOperationInProgress,
			fmt.Sprintf("The pull stopped at conflicts. Resolve them, then finish the %s.", operation)).
			WithDetail("operation", string(operation))
	}
	return remoteError(err)
}

func (r *openRepo) operationIn(id model.WorktreeID) model.WorktreeOperation {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, wt := range r.worktrees {
		if wt.ID == id {
			return wt.Operation
		}
	}
	return model.WorktreeOperationNone
}

// Push sends a worktree's branch to a remote. A branch with an upstream on
// a remote is pushed there; otherwise it is pushed to a branch of the same
// name on remote, which becomes its upstream. With force, the push replaces
// the remote branch, but only if it is still where it was last fetched.
func (w *Workspace) Push(ctx context.Context, worktreeID model.WorktreeID, remote string, force bool) error {
	r, wt, err := w.worktree(worktreeID)
	if err != nil {
		return err
	}
	branch, err := r.checkedOutBranch(wt)
	if err != nil {
		return err
	}
	args := []string{"push", "--progress"}
	if force {
		args = append(args, "--force-with-lease")
	}
	t, err := r.tracking(wt)
	if err == nil && t.remote != "" && (remote == "" || remote == t.remote) {
		args = append(args, t.remote, "refs/heads/"+branch.ShortName+":refs/heads/"+t.remoteBranch)
	} else {
		if remote == "" {
			if remote, err = r.defaultPushRemote(branch); err != nil {
				return err
			}
		}
		args = append(args, "--set-upstream", remote, "refs/heads/"+branch.ShortName+":refs/heads/"+branch.ShortName)
	}
	err = r.runOperation(ctx, model.OperationKindPush, wt.ID, func(ctx context.Context, progress func(gitexec.Progress)) error {
		_, err := w.git.Repo(r.loc.CommonDir, wt.Path).Network(ctx, progress, args...)
		return err
	})
	refreshErr := r.refresh(context.WithoutCancel(ctx), watch.Change{Refs: true})
	switch {
	case gitexec.IsPushRejected(err) && force:
		return apperr.New(model.ErrorCodePushRejected,
			fmt.Sprintf("The remote %s moved since it was last fetched. Fetch and check what changed before forcing again.", branch.ShortName)).
			WithDetail("stale", "true")
	case gitexec.IsPushRejected(err):
		return apperr.New(model.ErrorCodePushRejected,
			fmt.Sprintf("The remote %s has commits that aren't in yours. Pull them first, or force push to replace them.", branch.ShortName))
	case err != nil:
		return remoteError(err)
	}
	return refreshErr
}

// defaultPushRemote picks where to publish a branch with no upstream: the
// only remote, or origin.
func (r *openRepo) defaultPushRemote(branch model.Ref) (string, error) {
	names := r.remoteNames()
	switch {
	case len(names) == 1:
		return names[0], nil
	case slices.Contains(names, "origin"):
		return "origin", nil
	case len(names) == 0:
		return "", apperr.New(model.ErrorCodeNoUpstream, "This repository has no remotes to push to.")
	}
	return "", apperr.New(model.ErrorCodeNoUpstream, fmt.Sprintf("Choose a remote to push %s to.", branch.ShortName))
}

// tracking is a checked-out branch and the branch it pulls from.
type tracking struct {
	branch   model.Ref
	upstream model.Ref
	// remote is the upstream's remote, empty when it is a local branch.
	remote string
	// remoteBranch is the upstream's name on its remote.
	remoteBranch string
}

func (r *openRepo) tracking(wt repo.WorktreeInfo) (tracking, error) {
	branch, err := r.checkedOutBranch(wt)
	if err != nil {
		return tracking{}, err
	}
	noUpstream := apperr.New(model.ErrorCodeNoUpstream, fmt.Sprintf("%s has no upstream branch.", branch.ShortName)).
		WithDetail("branch", branch.ShortName)
	if branch.UpstreamRefID == "" {
		return tracking{}, noUpstream
	}
	upstream, err := r.ref(branch.UpstreamRefID)
	if err != nil {
		return tracking{}, noUpstream
	}
	t := tracking{branch: branch, upstream: upstream}
	if upstream.Kind == model.RefKindRemoteBranch {
		t.remote = r.remoteName(upstream.RemoteID)
		t.remoteBranch = strings.TrimPrefix(upstream.FullName, "refs/remotes/"+t.remote+"/")
	}
	return t, nil
}

func (r *openRepo) checkedOutBranch(wt repo.WorktreeInfo) (model.Ref, error) {
	if wt.Head.Kind != model.HeadKindBranch || wt.Head.RefID == "" {
		return model.Ref{}, apperr.New(model.ErrorCodeInvalidArgument, "Check out a branch first.")
	}
	return r.ref(wt.Head.RefID)
}

func (r *openRepo) remoteNames() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make([]string, len(r.remotes))
	for i, remote := range r.remotes {
		names[i] = remote.Name
	}
	return names
}

func (r *openRepo) remoteName(id model.RemoteID) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, remote := range r.remotes {
		if remote.ID == id {
			return remote.Name
		}
	}
	return ""
}

// fetch fetches the named remotes, one fetch at a time per repository, and
// records how it went.
func (r *openRepo) fetch(ctx context.Context, names []string, progress func(gitexec.Progress)) error {
	if len(names) == 0 {
		return apperr.New(model.ErrorCodeInvalidArgument, "This repository has no remotes to fetch from.")
	}
	r.fetchMu.Lock()
	defer r.fetchMu.Unlock()
	args := []string{"fetch", "--progress"}
	if r.ws.prefs.Get().Git.PruneOnFetch {
		args = append(args, "--prune")
	}
	if len(names) > 1 {
		args = append(args, "--multiple")
	}
	args = append(args, names...)

	published := context.WithoutCancel(ctx)
	r.setFetchState(published, names, model.FetchStateFetching)
	_, err := r.ws.git.Repo(r.loc.CommonDir, r.loc.WorkDir).Network(ctx, progress, args...)
	state := model.FetchStateIdle
	if err != nil {
		state = model.FetchStateError
	}
	r.setFetchState(published, names, state)
	if refreshErr := r.refresh(published, watch.Change{Refs: true}); err == nil {
		return refreshErr
	}
	return remoteError(err)
}

func (r *openRepo) setFetchState(ctx context.Context, names []string, state model.FetchState) {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	if r.closed {
		return
	}
	r.mu.Lock()
	for _, name := range names {
		record := r.fetches[name]
		record.state = state
		if state == model.FetchStateIdle {
			record.at = nowMillis()
		}
		r.fetches[name] = record
	}
	remotes := r.withFetchState(r.remotes)
	r.mu.Unlock()
	if err := r.ws.channels.Remotes.Publish(ctx, string(r.loc.ID), remotes); err != nil {
		r.ws.logger.ErrorContext(ctx, "publishing remotes failed", "error", err)
	}
}

// withFetchState returns remotes with what is known about fetching them.
// Remotes not fetched since the repository was opened are taken to have
// been fetched when FETCH_HEAD was last written. Callers hold r.mu.
func (r *openRepo) withFetchState(remotes []model.Remote) []model.Remote {
	remotes = slices.Clone(remotes)
	for i := range remotes {
		record := r.fetches[remotes[i].Name]
		remotes[i].FetchState = model.FetchStateIdle
		if record.state != "" {
			remotes[i].FetchState = record.state
		}
		at := record.at
		if at == 0 {
			at = r.fetchHeadAt
		}
		if at != 0 {
			remotes[i].LastFetchedAt = &at
		}
	}
	return remotes
}

// lastFetchedAt reads when the repository was last fetched by anything.
func lastFetchedAt(loc repo.Location) model.UnixMillis {
	info, err := os.Stat(filepath.Join(loc.CommonDir, "FETCH_HEAD"))
	if err != nil {
		return 0
	}
	return model.UnixMillis(info.ModTime().UnixMilli())
}

// fetchLoop fetches every remote in the background at the interval the
// preferences set, doubling it after each failure up to maxFetchBackoff
// times. Failures are only logged and shown on the remotes, since nobody
// asked for the fetch.
func (r *openRepo) fetchLoop() {
	ticker := time.NewTicker(fetchCheckInterval)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-r.lifetime.Done():
			return
		case <-ticker.C:
		}
		interval := time.Duration(r.ws.prefs.Get().Git.FetchInterval) * time.Minute
		if interval == 0 || !r.fetchDue(interval<<min(failures, maxFetchBackoff)) {
			continue
		}
		ctx, cancel := context.WithTimeout(r.lifetime, backgroundFetchTimeout)
		err := r.fetch(ctx, r.remoteNames(), nil)
		cancel()
		switch {
		case err == nil:
			failures = 0
		case r.lifetime.Err() == nil && !errors.Is(err, context.Canceled):
			failures++
			r.ws.logger.WarnContext(r.lifetime, "background fetch failed", "repo", r.loc.ID, "error", err)
		}
	}
}

// fetchDue reports whether some remote was last fetched longer ago than
// interval and nothing that fetches is running.
func (r *openRepo) fetchDue(interval time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, op := range r.operations {
		if op.State == model.OperationStateRunning && (op.Kind == model.OperationKindFetch || op.Kind == model.OperationKindPull) {
			return false
		}
	}
	due := nowMillis() - model.UnixMillis(interval.Milliseconds())
	for _, remote := range r.withFetchState(r.remotes) {
		if remote.LastFetchedAt == nil || *remote.LastFetchedAt < due {
			return true
		}
	}
	return false
}

// remoteError explains failures to reach or sign in to a remote.
func remoteError(err error) error {
	if gitexec.IsAuthFailed(err) {
		return apperr.New(model.ErrorCodeAuthFailed,
			"Couldn't sign in to the remote. Forkit uses your SSH agent and git's credential helper, so check that running the same command in a terminal works.")
	}
	return err
}
