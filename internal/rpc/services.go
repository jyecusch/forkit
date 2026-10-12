package rpc

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
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
// It returns nil if the user cancels.
func (x *Repos) ChooseAndOpen(meta model.CallMeta) (*model.Repo, error) {
	return call(x.s, meta, "Repos.ChooseAndOpen", func(ctx context.Context) (*model.Repo, error) {
		path, err := x.s.deps.ChooseDirectory("Open repository")
		if err != nil || path == "" {
			return nil, err
		}
		repo, err := x.s.deps.Workspace.Open(ctx, path)
		if err != nil {
			return nil, err
		}
		return &repo, nil
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

// Diff returns one file's changes in a commit or a worktree.
func (x *Repos) Diff(meta model.CallMeta, id model.RepoID, req model.DiffRequest) (model.FileDiff, error) {
	return call(x.s, meta, "Repos.Diff", func(ctx context.Context) (model.FileDiff, error) {
		loc, err := x.s.deps.Workspace.Location(id)
		if err != nil {
			return model.FileDiff{}, err
		}
		dir := loc.WorkDir
		if req.Kind == model.DiffKindCommit {
			if !isOID(req.OID) {
				return model.FileDiff{}, apperr.New(model.ErrorCodeInvalidArgument, "not a commit hash")
			}
		} else {
			wt, err := x.s.deps.Workspace.WorktreeInfo(req.WorktreeID)
			if err != nil {
				return model.FileDiff{}, err
			}
			if wt.RepoID != id {
				return model.FileDiff{}, apperr.New(model.ErrorCodeWorktreeNotFound, "worktree is not in this repository")
			}
			dir = wt.Path
		}
		return repo.ReadDiff(ctx, x.s.deps.Workspace.Git(), loc, dir, req)
	}, attribute.String("repo.id", string(id)), attribute.String("diff.kind", string(req.Kind)))
}

// Fetch updates remote-tracking branches from remote, or from every remote
// when it is empty.
func (x *Repos) Fetch(meta model.CallMeta, id model.RepoID, remote string) error {
	return callNoResult(x.s, meta, "Repos.Fetch", func(ctx context.Context) error {
		return x.s.deps.Workspace.Fetch(ctx, id, remote)
	}, attribute.String("repo.id", string(id)))
}

// CancelOperation stops a running operation.
func (x *Repos) CancelOperation(meta model.CallMeta, id model.RepoID, operation string) error {
	return callNoResult(x.s, meta, "Repos.CancelOperation", func(context.Context) error {
		return x.s.deps.Workspace.CancelOperation(id, operation)
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

// SetLayoutSize remembers the size the user gave a panel or column.
func (x *Session) SetLayoutSize(meta model.CallMeta, name model.LayoutSize, size float64) error {
	return callNoResult(x.s, meta, "Session.SetLayoutSize", func(ctx context.Context) error {
		if !slices.Contains(layoutSizes, name) || !(size > 0 && size <= maxLayoutSize) {
			return apperr.New(model.ErrorCodeInvalidArgument, fmt.Sprintf("%v is not a size for %q", size, name))
		}
		return x.s.deps.Session.Update(ctx, func(s *model.Session) {
			if s.Layout == nil {
				s.Layout = map[string]float64{}
			}
			s.Layout[string(name)] = size
		})
	}, attribute.String("layout.name", string(name)))
}

// ResetLayoutSize forgets a panel or column's size, so it is chosen
// automatically again.
func (x *Session) ResetLayoutSize(meta model.CallMeta, name model.LayoutSize) error {
	return callNoResult(x.s, meta, "Session.ResetLayoutSize", func(ctx context.Context) error {
		return x.s.deps.Session.Update(ctx, func(s *model.Session) { delete(s.Layout, string(name)) })
	}, attribute.String("layout.name", string(name)))
}

var layoutSizes = []model.LayoutSize{
	model.LayoutSizeSidebar, model.LayoutSizeDetails, model.LayoutSizeStaged, model.LayoutSizeDiffSplit,
	model.LayoutSizeRefsColumn, model.LayoutSizeGraphColumn, model.LayoutSizeAuthorColumn,
}

// maxLayoutSize bounds a remembered size, so a hand-edited file cannot make
// a panel wider than any screen.
const maxLayoutSize = 4000

func position(ids []model.RepoID, id model.RepoID) int {
	if i := slices.Index(ids, id); i >= 0 {
		return i
	}
	return len(ids)
}

// SetActiveWorktree selects a worktree sub-tab of a repository.
func (x *Session) SetActiveWorktree(meta model.CallMeta, repoID model.RepoID, worktreeID model.WorktreeID) error {
	err := x.updateOpenRepo(meta, "Session.SetActiveWorktree", repoID, func(o *model.OpenRepo) { o.ActiveWorktreeID = worktreeID })
	if err == nil {
		x.s.deps.Workspace.ActiveWorktreeChanged(context.Background(), repoID)
	}
	return err
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

// Stage adds paths' current contents to a worktree's index.
func (x *Worktrees) Stage(meta model.CallMeta, worktreeID model.WorktreeID, paths []string) error {
	return callNoResult(x.s, meta, "Worktrees.Stage", func(ctx context.Context) error {
		return x.s.deps.Workspace.Stage(ctx, worktreeID, paths)
	}, attribute.String("worktree.id", string(worktreeID)), attribute.Int("paths", len(paths)))
}

// Unstage returns paths in a worktree's index to their state in HEAD.
func (x *Worktrees) Unstage(meta model.CallMeta, worktreeID model.WorktreeID, paths []string) error {
	return callNoResult(x.s, meta, "Worktrees.Unstage", func(ctx context.Context) error {
		return x.s.deps.Workspace.Unstage(ctx, worktreeID, paths)
	}, attribute.String("worktree.id", string(worktreeID)), attribute.Int("paths", len(paths)))
}

// Commit records a worktree's staged changes, or amends its last commit.
func (x *Worktrees) Commit(meta model.CallMeta, worktreeID model.WorktreeID, message string, amend bool) (model.OID, error) {
	return call(x.s, meta, "Worktrees.Commit", func(ctx context.Context) (model.OID, error) {
		return x.s.deps.Workspace.Commit(ctx, worktreeID, message, amend)
	}, attribute.String("worktree.id", string(worktreeID)), attribute.Bool("commit.amend", amend))
}

// HeadMessage returns the message of a worktree's checked-out commit.
func (x *Worktrees) HeadMessage(meta model.CallMeta, worktreeID model.WorktreeID) (string, error) {
	return call(x.s, meta, "Worktrees.HeadMessage", func(ctx context.Context) (string, error) {
		return x.s.deps.Workspace.HeadMessage(ctx, worktreeID)
	}, attribute.String("worktree.id", string(worktreeID)))
}

// Pull brings a worktree's branch up to date with its upstream.
func (x *Worktrees) Pull(meta model.CallMeta, worktreeID model.WorktreeID) error {
	return callNoResult(x.s, meta, "Worktrees.Pull", func(ctx context.Context) error {
		return x.s.deps.Workspace.Pull(ctx, worktreeID)
	}, attribute.String("worktree.id", string(worktreeID)))
}

// Push sends a worktree's branch to its upstream, or publishes it to remote
// when it has none.
func (x *Worktrees) Push(meta model.CallMeta, worktreeID model.WorktreeID, remote string, force bool) error {
	return callNoResult(x.s, meta, "Worktrees.Push", func(ctx context.Context) error {
		return x.s.deps.Workspace.Push(ctx, worktreeID, remote, force)
	}, attribute.String("worktree.id", string(worktreeID)), attribute.Bool("push.force", force))
}

// ChooseParentDirectory asks the user where to put a new worktree and
// returns "" if they cancel.
func (x *Worktrees) ChooseParentDirectory(meta model.CallMeta) (string, error) {
	return call(x.s, meta, "Worktrees.ChooseParentDirectory", func(context.Context) (string, error) {
		return x.s.deps.ChooseDirectory("Choose where to create the worktree")
	})
}
