// Package workspace manages the repositories open in the app: it loads their
// entities, keeps them current as files change and publishes them for sync.
package workspace

import (
	"cmp"
	"context"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/graph"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/repo"
	"github.com/jyecusch/forkit/internal/synchub"
)

// Channels are the synced collections the workspace publishes.
type Channels struct {
	Repos      synchub.Channel[model.Repo]
	Worktrees  synchub.Channel[model.Worktree]
	Refs       synchub.Channel[model.Ref]
	Remotes    synchub.Channel[model.Remote]
	FileStatus synchub.Channel[model.FileStatus]
	GraphViews synchub.Channel[model.GraphView]
	Operations synchub.Channel[model.Operation]
}

// NewChannels registers the workspace's channels on hub.
func NewChannels(hub *synchub.Hub) Channels {
	return Channels{
		Repos:      synchub.NewChannel(hub, "repos", func(e model.Repo) string { return string(e.ID) }),
		Worktrees:  synchub.NewChannel(hub, "worktrees", func(e model.Worktree) string { return string(e.ID) }),
		Refs:       synchub.NewChannel(hub, "refs", func(e model.Ref) string { return string(e.ID) }),
		Remotes:    synchub.NewChannel(hub, "remotes", func(e model.Remote) string { return string(e.ID) }),
		FileStatus: synchub.NewChannel(hub, "fileStatuses", func(e model.FileStatus) string { return e.ID }),
		GraphViews: synchub.NewChannel(hub, "graphViews", func(e model.GraphView) string { return string(e.ID) }),
		Operations: synchub.NewChannel(hub, "operations", func(e model.Operation) string { return e.ID }),
	}
}

// ReposScope is the single scope of the Repos channel.
const ReposScope = "all"

// Workspace is the set of open repositories. Its mu is taken before any
// openRepo lock.
type Workspace struct {
	git      *gitexec.Git
	channels Channels
	prefs    *prefs.Store
	session  *prefs.SessionStore
	tracer   trace.Tracer
	logger   *slog.Logger

	mu       sync.Mutex
	repos    map[model.RepoID]*openRepo
	shutDown bool
}

// New creates an empty workspace. Call Restore to reopen the last session.
func New(git *gitexec.Git, channels Channels, preferences *prefs.Store, session *prefs.SessionStore, tracer trace.Tracer, logger *slog.Logger) *Workspace {
	w := &Workspace{
		git:      git,
		channels: channels,
		prefs:    preferences,
		session:  session,
		tracer:   tracer,
		logger:   logger,
		repos:    map[model.RepoID]*openRepo{},
	}
	preferences.OnChange(w.applyPreferences)
	return w
}

// Restore reopens the repositories of the previous session. Repositories
// that no longer exist are dropped from the session.
func (w *Workspace) Restore(ctx context.Context) {
	for _, open := range w.session.Get().OpenRepos {
		if _, err := w.open(ctx, open.CommonDir); err != nil {
			w.logger.WarnContext(ctx, "could not reopen repository", "error", err)
			_ = w.session.Update(ctx, func(s *model.Session) {
				s.OpenRepos = slices.DeleteFunc(s.OpenRepos, func(r model.OpenRepo) bool { return r.ID == open.ID })
			})
		}
	}
}

// Open opens the repository containing path, or returns it if it is already
// open, and makes it the active repository.
func (w *Workspace) Open(ctx context.Context, path string) (model.Repo, error) {
	r, err := w.open(ctx, path)
	if err != nil {
		return model.Repo{}, err
	}
	err = w.session.Update(ctx, func(s *model.Session) {
		if !slices.ContainsFunc(s.OpenRepos, func(o model.OpenRepo) bool { return o.ID == r.loc.ID }) {
			s.OpenRepos = append(s.OpenRepos, model.OpenRepo{ID: r.loc.ID, CommonDir: r.loc.CommonDir})
		}
		s.ActiveRepoID = r.loc.ID
	})
	return r.repoEntity(), err
}

func (w *Workspace) open(ctx context.Context, path string) (*openRepo, error) {
	loc, err := repo.Locate(ctx, w.git, path)
	if err != nil {
		return nil, err
	}
	options := graphOptions(w.prefs.Get())
	w.mu.Lock()
	if w.shutDown {
		w.mu.Unlock()
		return nil, apperr.New(model.ErrorCodeCancelled, "Forkit is shutting down")
	}
	if existing, ok := w.repos[loc.ID]; ok {
		w.mu.Unlock()
		return existing, nil
	}
	r := newOpenRepo(w, loc, options)
	w.repos[loc.ID] = r
	w.mu.Unlock()

	w.publishRepos(ctx)
	go r.load(trace.SpanContextFromContext(ctx))
	return r, nil
}

// Close stops watching a repository, removes it from the session and drops
// its synced entities.
func (w *Workspace) Close(ctx context.Context, id model.RepoID) error {
	w.mu.Lock()
	r, ok := w.repos[id]
	delete(w.repos, id)
	w.mu.Unlock()
	if !ok {
		return apperr.New(model.ErrorCodeRepoNotOpen, "repository is not open")
	}
	r.close(ctx)
	// The session moves on before the repository disappears, so the
	// frontend never has an active repository it cannot find.
	err := w.session.Update(ctx, func(s *model.Session) {
		closed := slices.IndexFunc(s.OpenRepos, func(o model.OpenRepo) bool { return o.ID == id })
		if closed < 0 {
			return
		}
		s.OpenRepos = slices.Delete(s.OpenRepos, closed, closed+1)
		if s.ActiveRepoID == id {
			s.ActiveRepoID = ""
			// Like closing a browser tab: the one to its right, or else its left.
			if len(s.OpenRepos) > 0 {
				s.ActiveRepoID = s.OpenRepos[min(closed, len(s.OpenRepos)-1)].ID
			}
		}
	})
	w.publishRepos(ctx)
	return err
}

// Shutdown closes every repository without changing the session, and
// refuses to open more.
func (w *Workspace) Shutdown(ctx context.Context) {
	w.mu.Lock()
	w.shutDown = true
	repos := slices.Collect(maps.Values(w.repos))
	w.repos = map[model.RepoID]*openRepo{}
	w.mu.Unlock()
	for _, r := range repos {
		r.close(ctx)
	}
}

// Graph returns the history view of an open repository.
func (w *Workspace) Graph(id model.RepoID) (*graph.View, error) {
	r, err := w.repo(id)
	if err != nil {
		return nil, err
	}
	return r.view, nil
}

// Location returns where an open repository is on disk.
func (w *Workspace) Location(id model.RepoID) (repo.Location, error) {
	r, err := w.repo(id)
	if err != nil {
		return repo.Location{}, err
	}
	return r.loc, nil
}

func (w *Workspace) repo(id model.RepoID) (*openRepo, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	r, ok := w.repos[id]
	if !ok {
		return nil, apperr.New(model.ErrorCodeRepoNotOpen, "repository is not open")
	}
	return r, nil
}

func (w *Workspace) publishRepos(ctx context.Context) {
	w.mu.Lock()
	entities := make([]model.Repo, 0, len(w.repos))
	for _, r := range w.repos {
		entities = append(entities, r.repoEntity())
	}
	w.mu.Unlock()
	slices.SortFunc(entities, func(a, b model.Repo) int { return cmp.Compare(a.ID, b.ID) })
	if err := w.channels.Repos.Publish(ctx, ReposScope, entities); err != nil {
		w.logger.ErrorContext(ctx, "publishing repositories failed", "error", err)
	}
}

func (w *Workspace) applyPreferences(ctx context.Context, preferences model.Preferences) {
	w.mu.Lock()
	repos := slices.Collect(maps.Values(w.repos))
	w.mu.Unlock()
	for _, r := range repos {
		r.setGraphOptions(ctx, graphOptions(preferences))
	}
}

func graphOptions(p model.Preferences) graph.Options {
	return graph.Options{
		Order:          p.Graph.Order,
		IncludeRemotes: p.Graph.ShowRemoteBranches,
		IncludeTags:    p.Graph.ShowTags,
	}
}

func nowMillis() model.UnixMillis {
	return model.UnixMillis(time.Now().UnixMilli())
}

// Preferences is the store the workspace follows.
func (w *Workspace) Preferences() *prefs.Store { return w.prefs }

// ActiveWorktreeChanged tells a repository that another of its worktrees is
// active, so its graph shows that worktree's uncommitted changes.
func (w *Workspace) ActiveWorktreeChanged(ctx context.Context, id model.RepoID) {
	if r, err := w.repo(id); err == nil {
		r.requestGraphRefresh(ctx)
	}
}

// Git is the git binary the workspace runs.
func (w *Workspace) Git() *gitexec.Git { return w.git }
