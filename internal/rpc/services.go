package rpc

import (
	"context"
	"encoding/base64"
	"errors"
	"regexp"
	"slices"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/repo"
)

// Sync serves snapshots of synced collections.
type Sync struct{ s *Server }

// Subscribe returns a channel scope's entities and the seq deltas follow on.
func (x *Sync) Subscribe(meta model.CallMeta, channel, scope string) (model.SyncSnapshot, error) {
	return call(x.s, meta, "Sync.Subscribe", func(context.Context) (model.SyncSnapshot, error) {
		return x.s.deps.Hub.Subscribe(channel, scope), nil
	}, attribute.String("sync.channel", channel), attribute.String("sync.scope", scope))
}

// Telemetry receives spans from the frontend.
type Telemetry struct{ s *Server }

// Ingest accepts a base64-encoded OTLP protobuf TracesData message. It is
// not traced itself, which would make every export produce more spans.
func (x *Telemetry) Ingest(payload string) error {
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return callError{apperr.ToRPC(apperr.New(model.ErrorCodeInvalidArgument, "payload is not base64"))}
	}
	if err := x.s.deps.Telemetry.Ingest(x.s.deps.Ctx, decoded); err != nil {
		return callError{apperr.ToRPC(err)}
	}
	return nil
}

// Repos opens repositories and reads their history.
type Repos struct{ s *Server }

// Open opens the repository containing path.
func (x *Repos) Open(meta model.CallMeta, path string) (model.Repo, error) {
	return call(x.s, meta, "Repos.Open", func(ctx context.Context) (model.Repo, error) {
		return x.s.deps.Workspace.Open(ctx, path)
	})
}

// ChooseAndOpen asks the user for a folder and opens the repository in it.
// It returns an empty Repo if the user cancels.
func (x *Repos) ChooseAndOpen(meta model.CallMeta) (model.Repo, error) {
	return call(x.s, meta, "Repos.ChooseAndOpen", func(ctx context.Context) (model.Repo, error) {
		path, err := x.s.deps.ChooseDirectory("Open repository")
		if err != nil || path == "" {
			return model.Repo{}, err
		}
		return x.s.deps.Workspace.Open(ctx, path)
	})
}

// Close closes an open repository.
func (x *Repos) Close(meta model.CallMeta, id model.RepoID) error {
	return callNoResult(x.s, meta, "Repos.Close", func(ctx context.Context) error {
		return x.s.deps.Workspace.Close(ctx, id)
	}, attribute.String("repo.id", string(id)))
}

// GraphWindow returns rows [start, start+count) of a repository's graph.
func (x *Repos) GraphWindow(meta model.CallMeta, id model.RepoID, start, count int, emphasized model.RefID) (model.GraphWindow, error) {
	return call(x.s, meta, "Repos.GraphWindow", func(ctx context.Context) (model.GraphWindow, error) {
		view, err := x.s.deps.Workspace.Graph(id)
		if err != nil {
			return model.GraphWindow{}, err
		}
		return view.Window(ctx, start, count, emphasized)
	}, attribute.String("repo.id", string(id)), attribute.Int("rows.start", start), attribute.Int("rows.requested", count))
}

// RowOfRef returns the graph row of the commit a ref points at, or -1.
func (x *Repos) RowOfRef(meta model.CallMeta, id model.RepoID, ref model.RefID) (int, error) {
	return call(x.s, meta, "Repos.RowOfRef", func(context.Context) (int, error) {
		view, err := x.s.deps.Workspace.Graph(id)
		if err != nil {
			return -1, err
		}
		return view.RowOfRef(ref), nil
	}, attribute.String("repo.id", string(id)))
}

// CommitDetail returns a commit's message and changed files.
func (x *Repos) CommitDetail(meta model.CallMeta, id model.RepoID, oid model.OID) (model.CommitDetail, error) {
	return call(x.s, meta, "Repos.CommitDetail", func(ctx context.Context) (model.CommitDetail, error) {
		if !isOID(oid) {
			return model.CommitDetail{}, apperr.New(model.ErrorCodeInvalidArgument, "not a commit hash")
		}
		loc, err := x.s.deps.Workspace.Location(id)
		if err != nil {
			return model.CommitDetail{}, err
		}
		return repo.ReadCommitDetail(ctx, x.s.deps.Workspace.Git(), loc, oid)
	}, attribute.String("repo.id", string(id)))
}

var oidPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// isOID reports whether oid is a full SHA-1 or SHA-256 hash, so it can be
// passed to git without being mistaken for an option.
func isOID(oid model.OID) bool { return oidPattern.MatchString(string(oid)) }

// Preferences changes user preferences.
type Preferences struct{ s *Server }

// Set changes the preference at a dot-separated path.
func (x *Preferences) Set(meta model.CallMeta, path string, value any) error {
	return callNoResult(x.s, meta, "Preferences.Set", func(ctx context.Context) error {
		return preferenceError(x.s.deps.Prefs.Set(ctx, path, value))
	}, attribute.String("preference.path", path))
}

// Reset restores the default value of a preference.
func (x *Preferences) Reset(meta model.CallMeta, path string) error {
	return callNoResult(x.s, meta, "Preferences.Reset", func(ctx context.Context) error {
		return preferenceError(x.s.deps.Prefs.Reset(ctx, path))
	}, attribute.String("preference.path", path))
}

func preferenceError(err error) error {
	var invalid *prefs.InvalidPreferenceError
	if errors.As(err, &invalid) {
		return apperr.New(model.ErrorCodeInvalidArgument, invalid.Error())
	}
	return err
}

// Session records which tab, worktree and history the user is looking at.
type Session struct{ s *Server }

// SetActiveRepo selects a repository tab.
func (x *Session) SetActiveRepo(meta model.CallMeta, id model.RepoID) error {
	return callNoResult(x.s, meta, "Session.SetActiveRepo", func(ctx context.Context) error {
		return x.s.deps.Session.Update(ctx, func(s *model.Session) { s.ActiveRepoID = id })
	})
}

// ReorderRepos sets the order of the repository tabs.
func (x *Session) ReorderRepos(meta model.CallMeta, ids []model.RepoID) error {
	return callNoResult(x.s, meta, "Session.ReorderRepos", func(ctx context.Context) error {
		return x.s.deps.Session.Update(ctx, func(s *model.Session) {
			slices.SortStableFunc(s.OpenRepos, func(a, b model.OpenRepo) int {
				return position(ids, a.ID) - position(ids, b.ID)
			})
		})
	})
}

func position(ids []model.RepoID, id model.RepoID) int {
	if i := slices.Index(ids, id); i >= 0 {
		return i
	}
	return len(ids)
}

// SetActiveWorktree selects a worktree sub-tab of a repository.
func (x *Session) SetActiveWorktree(meta model.CallMeta, repoID model.RepoID, worktreeID model.WorktreeID) error {
	return x.updateOpenRepo(meta, "Session.SetActiveWorktree", repoID, func(o *model.OpenRepo) { o.ActiveWorktreeID = worktreeID })
}

// SetEmphasizedRef chooses whose history the graph emphasizes.
func (x *Session) SetEmphasizedRef(meta model.CallMeta, repoID model.RepoID, refID model.RefID) error {
	return x.updateOpenRepo(meta, "Session.SetEmphasizedRef", repoID, func(o *model.OpenRepo) { o.EmphasizedRefID = refID })
}

func (x *Session) updateOpenRepo(meta model.CallMeta, method string, id model.RepoID, change func(*model.OpenRepo)) error {
	return callNoResult(x.s, meta, method, func(ctx context.Context) error {
		found := false
		err := x.s.deps.Session.Update(ctx, func(s *model.Session) {
			for i := range s.OpenRepos {
				if s.OpenRepos[i].ID == id {
					change(&s.OpenRepos[i])
					found = true
				}
			}
		})
		if err == nil && !found {
			return apperr.New(model.ErrorCodeRepoNotOpen, "repository is not open")
		}
		return err
	}, attribute.String("repo.id", string(id)))
}

// Worktrees checks out refs and manages worktrees.
type Worktrees struct{ s *Server }

// Checkout switches a worktree to a ref, handling uncommitted changes as
// mode says.
func (x *Worktrees) Checkout(meta model.CallMeta, worktreeID model.WorktreeID, refID model.RefID, mode model.CheckoutMode) (model.CheckoutResult, error) {
	return call(x.s, meta, "Worktrees.Checkout", func(ctx context.Context) (model.CheckoutResult, error) {
		return x.s.deps.Workspace.Checkout(ctx, worktreeID, refID, mode)
	}, attribute.String("worktree.id", string(worktreeID)), attribute.String("checkout.mode", string(mode)))
}

// Create adds a worktree; see workspace.CreateWorktree.
func (x *Worktrees) Create(meta model.CallMeta, repoID model.RepoID, base model.RefID, newBranch, path string) (model.Worktree, error) {
	return call(x.s, meta, "Worktrees.Create", func(ctx context.Context) (model.Worktree, error) {
		return x.s.deps.Workspace.CreateWorktree(ctx, repoID, base, newBranch, path)
	}, attribute.String("repo.id", string(repoID)))
}

// Remove deletes a linked worktree.
func (x *Worktrees) Remove(meta model.CallMeta, worktreeID model.WorktreeID, force bool) error {
	return callNoResult(x.s, meta, "Worktrees.Remove", func(ctx context.Context) error {
		return x.s.deps.Workspace.RemoveWorktree(ctx, worktreeID, force)
	}, attribute.String("worktree.id", string(worktreeID)))
}

// ChooseParentDirectory asks the user where to put a new worktree and
// returns "" if they cancel.
func (x *Worktrees) ChooseParentDirectory(meta model.CallMeta) (string, error) {
	return call(x.s, meta, "Worktrees.ChooseParentDirectory", func(context.Context) (string, error) {
		return x.s.deps.ChooseDirectory("Choose where to create the worktree")
	})
}
