package workspace

import (
	"context"
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
type openRepo struct {
	ws     *Workspace
	loc    repo.Location
	ctx    context.Context // ends when the repository is closed
	cancel context.CancelFunc
	view   *graph.View

	refreshMu sync.Mutex // serializes refresh
	watcher   *watch.Watcher

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

	graphRequests chan struct{}
}

func newOpenRepo(w *Workspace, loc repo.Location) *openRepo {
	ctx, cancel := context.WithCancel(context.Background())
	r := &openRepo{
		ws:            w,
		loc:           loc,
		ctx:           ctx,
		cancel:        cancel,
		view:          graph.NewView(ctx, loc.ID, w.git.Repo(loc.CommonDir, loc.WorkDir), w.channels.GraphViews, w.tracer),
		state:         model.LoadStateLoading,
		openedAt:      nowMillis(),
		graphOptions:  graphOptions(w.prefs.Get()),
		graphRequests: make(chan struct{}, 1),
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

// load reads everything about the repository, then keeps it current.
func (r *openRepo) load(ctx context.Context) {
	ctx, span := r.ws.tracer.Start(ctx, "repo.load", trace.WithAttributes(attribute.String("repo.id", string(r.loc.ID))))
	defer span.End()

	if r.ws.prefs.Get().Git.MaintainCommitGraph {
		go func() {
			if err := repo.EnsureCommitGraph(r.ctx, r.ws.git, r.loc); err != nil {
				r.ws.logger.WarnContext(ctx, "writing commit-graph failed", "error", err)
			}
		}()
	}

	err := r.refresh(ctx, watch.Change{Refs: true, Remotes: true, Worktrees: true, Status: map[model.WorktreeID]bool{}})
	if err == nil {
		r.refreshMu.Lock()
		r.watcher, err = watch.Start(r.watchLayout(), r.onFilesChanged, r.ws.logger)
		r.refreshMu.Unlock()
	}

	r.mu.Lock()
	r.state = model.LoadStateReady
	if err != nil && r.ctx.Err() == nil {
		span.RecordError(err)
		r.state, r.loadErr = model.LoadStateError, err.Error()
	}
	r.mu.Unlock()
	r.ws.publishRepos(ctx)
}

func (r *openRepo) onFilesChanged(ctx context.Context, change watch.Change) {
	ctx, span := r.ws.tracer.Start(ctx, "watch.batch", trace.WithAttributes(
		attribute.String("repo.id", string(r.loc.ID)),
		attribute.Bool("change.refs", change.Refs),
		attribute.Int("change.status", len(change.Status)),
	))
	defer span.End()
	if err := r.refresh(ctx, change); err != nil && r.ctx.Err() == nil {
		span.RecordError(err)
		r.ws.logger.WarnContext(ctx, "refreshing repository failed", "error", err)
	}
}

// refresh re-reads what change says is stale and publishes it.
func (r *openRepo) refresh(ctx context.Context, change watch.Change) error {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
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

	worktreesChanged := change.Worktrees || len(change.Status) > 0
	if change.Worktrees {
		added, removed, err := r.reloadWorktrees(ctx)
		if err != nil {
			return err
		}
		for _, id := range added {
			change.Status[id] = true
		}
		r.refreshIndexes(ctx, added)
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

	if err := r.reloadStatus(ctx, change.Status); err != nil {
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
	if change.Refs || change.Worktrees {
		r.requestGraphRefresh(ctx)
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

// setGraphOptions changes what the graph shows and refreshes it.
func (r *openRepo) setGraphOptions(ctx context.Context, options graph.Options) {
	r.mu.Lock()
	r.graphOptions = options
	r.mu.Unlock()
	r.requestGraphRefresh(ctx)
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
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-r.graphRequests:
		}
		r.mu.Lock()
		refs, options := r.refs, r.graphOptions
		ctx := trace.ContextWithSpanContext(r.ctx, r.graphTrace)
		var heads []model.OID
		for _, wt := range r.worktrees {
			if wt.Head.Kind == model.HeadKindDetached {
				heads = append(heads, wt.Head.OID)
			}
		}
		r.mu.Unlock()
		if err := r.view.Refresh(ctx, refs, heads, options); err != nil && r.ctx.Err() == nil {
			r.ws.logger.WarnContext(ctx, "refreshing graph failed", "error", err)
		}
	}
}

func (r *openRepo) close(ctx context.Context) {
	r.cancel()
	r.refreshMu.Lock()
	if r.watcher != nil {
		r.watcher.Close()
	}
	r.refreshMu.Unlock()
	r.view.Close()

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
	channels.Operations.Drop(ctx, scope)
}
