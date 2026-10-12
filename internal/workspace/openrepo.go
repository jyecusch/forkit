package workspace

import (
	"context"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/sync/errgroup"

	"github.com/jyecusch/forkit/internal/graph"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/watch"
)

// statusConcurrency bounds how many worktrees run git status at once.
const statusConcurrency = 4

// openRepo is one open repository and the latest state read from it.
//
// Locks are taken in the order Workspace.mu, refreshMu, mu. Everything
// published for the repository happens under refreshMu, or under mu for
// operations, so close can drop its scopes without a late publish
// recreating them.
type openRepo struct {
	ws       *Workspace
	loc      repo.Location
	lifetime context.Context // ends when the repository is closed
	cancel   context.CancelFunc
	view     *graph.View

	refreshMu sync.Mutex
	closed    bool
	watcher   *watch.Watcher

	graphRequests chan struct{}
	graphDone     chan struct{}

	mu            sync.Mutex
	state         model.LoadState
	loadErr       string
	openedAt      model.UnixMillis
	defaultBranch string
	worktrees     []repo.WorktreeInfo
	refs          []model.Ref
	remotes       []model.Remote
	graphOptions  graph.Options
	graphTrace    trace.SpanContext
	operations    map[string]model.Operation
}

func newOpenRepo(w *Workspace, loc repo.Location, options graph.Options) *openRepo {
	lifetime, cancel := context.WithCancel(context.Background())
	r := &openRepo{
		ws:            w,
		loc:           loc,
		lifetime:      lifetime,
		cancel:        cancel,
		view:          graph.NewView(lifetime, loc.ID, w.git.Repo(loc.CommonDir, loc.WorkDir), w.channels.GraphViews, w.tracer),
		graphRequests: make(chan struct{}, 1),
		graphDone:     make(chan struct{}),
		state:         model.LoadStateLoading,
		openedAt:      nowMillis(),
		graphOptions:  options,
		operations:    map[string]model.Operation{},
	}
	go r.graphLoop()
	return r
}

func (r *openRepo) repoEntity() model.Repo {
	r.mu.Lock()
	defer r.mu.Unlock()
	entity := model.Repo{
		ID:            r.loc.ID,
		Name:          repoName(r.loc),
		CommonDir:     r.loc.CommonDir,
		IsBare:        r.loc.IsBare,
		DefaultBranch: r.defaultBranch,
		LastOpenedAt:  r.openedAt,
		State:         r.state,
		Error:         r.loadErr,
	}
	for _, wt := range r.worktrees {
		if wt.IsMain {
			entity.MainWorktreeID = wt.ID
		}
	}
	return entity
}

func repoName(loc repo.Location) string {
	if loc.IsBare {
		return strings.TrimSuffix(filepath.Base(loc.CommonDir), ".git")
	}
	return filepath.Base(loc.WorkDir)
}

// load reads everything about the repository, then keeps it current. It
// runs for the repository's lifetime, continuing the trace of the request
// that opened it.
func (r *openRepo) load(trigger trace.SpanContext) {
	ctx := trace.ContextWithSpanContext(r.lifetime, trigger)
	ctx, span := r.ws.tracer.Start(ctx, "repo.load", trace.WithAttributes(attribute.String("repo.id", string(r.loc.ID))))
	defer span.End()

	if r.ws.prefs.Get().Git.MaintainCommitGraph {
		go func() {
			if err := repo.EnsureCommitGraph(r.lifetime, r.ws.git, r.loc); err != nil {
				r.ws.logger.WarnContext(ctx, "writing commit-graph failed", "error", err)
			}
		}()
	}

	err := r.refresh(ctx, watch.Change{Refs: true, Remotes: true, Worktrees: true, Status: map[model.WorktreeID]bool{}})
	if err == nil {
		err = r.startWatching()
	}

	r.mu.Lock()
	r.state = model.LoadStateReady
	if err != nil && r.lifetime.Err() == nil {
		span.RecordError(err)
		r.state, r.loadErr = model.LoadStateError, err.Error()
	}
	r.mu.Unlock()
	r.ws.publishRepos(ctx)
}

func (r *openRepo) startWatching() error {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	if r.closed {
		return nil
	}
	watcher, err := watch.Start(r.watchLayout(), r.onFilesChanged, r.ws.logger)
	r.watcher = watcher
	return err
}

func (r *openRepo) onFilesChanged(ctx context.Context, change watch.Change) {
	ctx, span := r.ws.tracer.Start(ctx, "watch.batch", trace.WithAttributes(
		attribute.String("repo.id", string(r.loc.ID)),
		attribute.Bool("change.refs", change.Refs),
		attribute.Int("change.status", len(change.Status)),
	))
	defer span.End()
	if err := r.refresh(ctx, change); err != nil && r.lifetime.Err() == nil {
		span.RecordError(err)
		r.ws.logger.WarnContext(ctx, "refreshing repository failed", "error", err)
	}
}

// refresh re-reads what change says is stale and publishes it. The graph is
// requested as soon as refs are known, because status can be slow on large
// worktrees and the graph does not depend on it.
func (r *openRepo) refresh(ctx context.Context, change watch.Change) error {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	if r.closed {
		return nil
	}
	statusOf := maps.Clone(change.Status)
	if statusOf == nil {
		statusOf = map[model.WorktreeID]bool{}
	}
	channels := r.ws.channels
	scope := string(r.loc.ID)

	if change.Remotes {
		remotes, err := repo.ListRemotes(ctx, r.ws.git, r.loc)
		if err != nil {
			return err
		}
		r.mu.Lock()
		r.remotes = remotes
		r.mu.Unlock()
		if err := channels.Remotes.Publish(ctx, scope, remotes); err != nil {
			return err
		}
	}

	worktreesChanged := change.Worktrees || len(statusOf) > 0
	var newWorktrees []model.WorktreeID
	if change.Worktrees {
		added, removed, err := r.reloadWorktrees(ctx)
		if err != nil {
			return err
		}
		newWorktrees = added
		for _, id := range added {
			statusOf[id] = true
		}
		for _, id := range removed {
			channels.FileStatus.Drop(ctx, string(id))
		}
		if r.watcher != nil && (len(added) > 0 || len(removed) > 0) {
			if err := r.watcher.Update(r.watchLayout()); err != nil {
				return err
			}
		}
	}

	if change.Refs {
		if err := r.reloadRefs(ctx); err != nil {
			return err
		}
	}
	if change.Refs || change.Worktrees {
		r.requestGraphRefresh(ctx)
	}

	r.refreshIndexes(ctx, newWorktrees)
	if err := r.reloadStatus(ctx, statusOf); err != nil {
		return err
	}
	if worktreesChanged {
		r.mu.Lock()
		worktrees := make([]model.Worktree, len(r.worktrees))
		for i, wt := range r.worktrees {
			worktrees[i] = wt.Worktree
		}
		r.mu.Unlock()
		if err := channels.Worktrees.Publish(ctx, scope, worktrees); err != nil {
			return err
		}
	}
	return nil
}

func (r *openRepo) reloadWorktrees(ctx context.Context) (added, removed []model.WorktreeID, err error) {
	worktrees, err := repo.ListWorktrees(ctx, r.ws.git, r.loc)
	if err != nil {
		return nil, nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	previous := map[model.WorktreeID]model.StatusSummary{}
	for _, wt := range r.worktrees {
		previous[wt.ID] = wt.StatusSummary
	}
	for i := range worktrees {
		summary, known := previous[worktrees[i].ID]
		worktrees[i].StatusSummary = summary
		delete(previous, worktrees[i].ID)
		if !known {
			added = append(added, worktrees[i].ID)
		}
	}
	for id := range previous {
		removed = append(removed, id)
	}
	r.worktrees = worktrees
	return added, removed, nil
}

func (r *openRepo) reloadRefs(ctx context.Context) error {
	r.mu.Lock()
	remotes := r.remotes
	r.mu.Unlock()
	var refs []model.Ref
	var defaultBranch string
	group, groupCtx := errgroup.WithContext(ctx)
	group.Go(func() (err error) {
		refs, err = repo.ListRefs(groupCtx, r.ws.git, r.loc, remotes)
		return err
	})
	group.Go(func() (err error) {
		defaultBranch, err = repo.DefaultBranch(groupCtx, r.ws.git, r.loc)
		return err
	})
	if err := group.Wait(); err != nil {
		return err
	}
	r.mu.Lock()
	r.refs, r.defaultBranch = refs, defaultBranch
	r.mu.Unlock()
	return r.ws.channels.Refs.Publish(ctx, string(r.loc.ID), refs)
}

// refreshIndexes brings newly seen worktrees' index stat caches up to date
// so their status checks stay fast.
func (r *openRepo) refreshIndexes(ctx context.Context, ids []model.WorktreeID) {
	r.mu.Lock()
	worktrees := slices.Clone(r.worktrees)
	r.mu.Unlock()
	group, ctx := errgroup.WithContext(ctx)
	group.SetLimit(statusConcurrency)
	for _, wt := range worktrees {
		if !slices.Contains(ids, wt.ID) || wt.Prunable {
			continue
		}
		group.Go(func() error {
			if err := repo.RefreshIndex(ctx, r.ws.git, r.loc, wt.Path); err != nil {
				r.ws.logger.WarnContext(ctx, "refreshing index failed", "error", err)
			}
			return nil
		})
	}
	_ = group.Wait()
}

func (r *openRepo) reloadStatus(ctx context.Context, ids map[model.WorktreeID]bool) error {
	r.mu.Lock()
	targets := slices.DeleteFunc(slices.Clone(r.worktrees), func(wt repo.WorktreeInfo) bool {
		return !ids[wt.ID] || wt.Prunable
	})
	r.mu.Unlock()

	group, ctx := errgroup.WithContext(ctx)
	group.SetLimit(statusConcurrency)
	for _, wt := range targets {
		group.Go(func() error {
			files, summary, err := repo.ReadStatus(ctx, r.ws.git, wt.ID, wt.Path)
			if err != nil {
				return err
			}
			r.mu.Lock()
			for i := range r.worktrees {
				if r.worktrees[i].ID == wt.ID {
					r.worktrees[i].StatusSummary = summary
				}
			}
			r.mu.Unlock()
			return r.ws.channels.FileStatus.Publish(ctx, string(wt.ID), files)
		})
	}
	return group.Wait()
}

func (r *openRepo) watchLayout() watch.Layout {
	r.mu.Lock()
	defer r.mu.Unlock()
	layout := watch.Layout{CommonDir: r.loc.CommonDir}
	for _, wt := range r.worktrees {
		if !wt.Prunable {
			layout.Worktrees = append(layout.Worktrees, watch.Worktree{ID: wt.ID, Path: wt.Path, GitDir: wt.GitDir})
		}
	}
	return layout
}

// setGraphOptions changes what the graph shows, refreshing it if that is
// different from before.
func (r *openRepo) setGraphOptions(ctx context.Context, options graph.Options) {
	r.mu.Lock()
	changed := r.graphOptions != options
	r.graphOptions = options
	r.mu.Unlock()
	if changed {
		r.requestGraphRefresh(ctx)
	}
}

// requestGraphRefresh asks the graph loop to refresh. Requests made while a
// refresh runs are coalesced into one more.
func (r *openRepo) requestGraphRefresh(ctx context.Context) {
	r.mu.Lock()
	r.graphTrace = trace.SpanContextFromContext(ctx)
	r.mu.Unlock()
	select {
	case r.graphRequests <- struct{}{}:
	default:
	}
}

func (r *openRepo) graphLoop() {
	defer close(r.graphDone)
	for {
		select {
		case <-r.lifetime.Done():
			return
		case <-r.graphRequests:
		}
		r.mu.Lock()
		refs, options := r.refs, r.graphOptions
		ctx := trace.ContextWithSpanContext(r.lifetime, r.graphTrace)
		var heads []model.OID
		for _, wt := range r.worktrees {
			if wt.Head.Kind == model.HeadKindDetached {
				heads = append(heads, wt.Head.OID)
			}
		}
		r.mu.Unlock()
		if err := r.view.Refresh(ctx, refs, heads, options); err != nil && r.lifetime.Err() == nil {
			r.ws.logger.WarnContext(ctx, "refreshing graph failed", "error", err)
		}
	}
}

// close stops all work for the repository and drops its synced entities.
func (r *openRepo) close(ctx context.Context) {
	r.cancel()
	<-r.graphDone

	r.refreshMu.Lock()
	r.closed = true
	if r.watcher != nil {
		r.watcher.Close()
	}
	r.mu.Lock()
	worktrees := r.worktrees
	r.mu.Unlock()
	scope := string(r.loc.ID)
	channels := r.ws.channels
	for _, wt := range worktrees {
		channels.FileStatus.Drop(ctx, string(wt.ID))
	}
	channels.Worktrees.Drop(ctx, scope)
	channels.Refs.Drop(ctx, scope)
	channels.Remotes.Drop(ctx, scope)
	channels.GraphViews.Drop(ctx, scope)
	r.refreshMu.Unlock()
	r.view.Close()

	r.mu.Lock()
	defer r.mu.Unlock()
	channels.Operations.Drop(ctx, scope)
}
