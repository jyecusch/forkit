package workspace

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// ClonesScope is the single scope of the Clones channel.
const ClonesScope = "all"

type runningClone struct {
	clone  model.Clone
	cancel context.CancelFunc
}

// Clone copies the repository at url into path, which must not exist yet,
// then opens it. The clone is published with its progress until it ends.
// If it fails or is cancelled, the folder it made is removed.
func (w *Workspace) Clone(ctx context.Context, url, path string) (model.Repo, error) {
	url = strings.TrimSpace(url)
	if url == "" {
		return model.Repo{}, apperr.New(model.ErrorCodeInvalidArgument, "Enter the URL of the repository to clone.")
	}
	if !filepath.IsAbs(path) {
		return model.Repo{}, apperr.New(model.ErrorCodeInvalidArgument, "Choose where to put the repository.")
	}
	parent := filepath.Dir(path)
	if info, err := os.Stat(parent); err != nil || !info.IsDir() {
		return model.Repo{}, apperr.New(model.ErrorCodeInvalidArgument,
			fmt.Sprintf("The folder %s isn't there any more. Choose another location.", filepath.Base(parent)))
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return model.Repo{}, apperr.New(model.ErrorCodeInvalidArgument,
			fmt.Sprintf("There's already a %s in %s. Choose another location.", filepath.Base(path), filepath.Base(parent)))
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := w.startClone(ctx, model.Clone{Path: path, URL: url}, cancel); err != nil {
		return model.Repo{}, err
	}
	defer w.endClone(context.WithoutCancel(ctx), path)

	progress := throttled(func(progress *model.OperationProgress) {
		w.updateClone(ctx, path, func(c *model.Clone) { c.Progress = progress })
	})
	_, err := w.git.Repo(parent, parent).Network(ctx, progress, "clone", "--progress", "--", url, path)
	if err != nil {
		if removeErr := os.RemoveAll(path); removeErr != nil {
			w.logger.WarnContext(ctx, "could not remove unfinished clone", "error", removeErr)
		}
		if ctx.Err() != nil {
			return model.Repo{}, context.Canceled
		}
		return model.Repo{}, w.cloneError(ctx, err)
	}

	ctx = context.WithoutCancel(ctx)
	if err := w.session.Update(ctx, func(s *model.Session) { s.CloneDirectory = parent }); err != nil {
		w.logger.WarnContext(ctx, "could not remember clone directory", "error", err)
	}
	return w.Open(ctx, path)
}

// CancelClone stops the clone into path. A clone that has already finished
// is left alone.
func (w *Workspace) CancelClone(path string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if c, ok := w.clones[path]; ok {
		c.cancel()
	}
}

func (w *Workspace) startClone(ctx context.Context, clone model.Clone, cancel context.CancelFunc) error {
	w.mu.Lock()
	if w.shutDown {
		w.mu.Unlock()
		return apperr.New(model.ErrorCodeCancelled, "Forkit is shutting down")
	}
	if _, ok := w.clones[clone.Path]; ok {
		w.mu.Unlock()
		return apperr.New(model.ErrorCodeOperationInProgress, fmt.Sprintf("%s is already being cloned.", filepath.Base(clone.Path)))
	}
	w.clones[clone.Path] = runningClone{clone: clone, cancel: cancel}
	w.mu.Unlock()
	w.publishClones(ctx)
	return nil
}

func (w *Workspace) updateClone(ctx context.Context, path string, change func(*model.Clone)) {
	w.mu.Lock()
	if c, ok := w.clones[path]; ok {
		change(&c.clone)
		w.clones[path] = c
	}
	w.mu.Unlock()
	w.publishClones(ctx)
}

func (w *Workspace) endClone(ctx context.Context, path string) {
	w.mu.Lock()
	delete(w.clones, path)
	w.mu.Unlock()
	w.publishClones(ctx)
}

func (w *Workspace) publishClones(ctx context.Context) {
	w.mu.Lock()
	clones := make([]model.Clone, 0, len(w.clones))
	for c := range maps.Values(w.clones) {
		clones = append(clones, c.clone)
	}
	w.mu.Unlock()
	slices.SortFunc(clones, func(a, b model.Clone) int { return cmp.Compare(a.Path, b.Path) })
	if err := w.channels.Clones.Publish(ctx, ClonesScope, clones); err != nil {
		w.logger.ErrorContext(ctx, "publishing clones failed", "error", err)
	}
}

// cloneError explains why a clone failed in terms of what to check, and
// logs git's own account.
func (w *Workspace) cloneError(ctx context.Context, err error) error {
	switch {
	// Hosts such as GitHub ask for sign-in rather than admit a repository
	// doesn't exist, so a mistyped URL lands here too.
	case gitexec.IsAuthFailed(err):
		return apperr.New(model.ErrorCodeAuthFailed,
			"Couldn't sign in to get this repository. Check the URL. If the repository is private, Forkit signs in with your SSH agent and git's credential helper, so check that cloning it in a terminal works.")
	case gitexec.IsHostUnreachable(err):
		return apperr.New(model.ErrorCodeGitFailed, "Couldn't reach the server. Check the URL and your connection, then try again.")
	case gitexec.IsRepoNotFound(err):
		return apperr.New(model.ErrorCodeGitFailed, "There's no repository at that URL, or you don't have access to it. Check the URL, then try again.")
	}
	w.logger.WarnContext(ctx, "could not clone repository", "error", err)
	return apperr.New(model.ErrorCodeGitFailed, "Couldn't clone the repository. Check the URL, then try again.")
}
