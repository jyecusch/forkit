// Package watch turns filesystem events in a repository's git dirs and
// worktrees into coalesced descriptions of what needs refreshing.
package watch

import (
	"context"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jyecusch/forkit/internal/model"
)

const (
	// quietPeriod is how long events must stop before a change is reported,
	// so a rebase touching hundreds of refs causes one refresh.
	quietPeriod = 25 * time.Millisecond
	// maxDelay bounds how long a steady stream of events can postpone a
	// report.
	maxDelay = 500 * time.Millisecond
	// pollInterval is how often worktrees that could not be watched are
	// checked instead.
	pollInterval = 5 * time.Second
)

// Worktree is a worktree's location on disk.
type Worktree struct {
	ID     model.WorktreeID
	Path   string
	GitDir string
}

// Layout is everything a repository has on disk worth watching.
type Layout struct {
	CommonDir string
	Worktrees []Worktree
}

// Change says what needs refreshing after a batch of events.
type Change struct {
	Refs      bool
	Remotes   bool
	Worktrees bool
	Status    map[model.WorktreeID]bool
}

func (c *Change) empty() bool {
	return !c.Refs && !c.Remotes && !c.Worktrees && len(c.Status) == 0
}

func (c *Change) merge(other Change) {
	c.Refs = c.Refs || other.Refs
	c.Remotes = c.Remotes || other.Remotes
	c.Worktrees = c.Worktrees || other.Worktrees
	for id := range other.Status {
		c.Status[id] = true
	}
}

// source delivers batches of changed absolute paths.
type source interface {
	Events() <-chan []string
	// Unwatched lists roots that could not be watched, which are polled.
	Unwatched() []string
	Close() error
}

// Watcher reports changes to one repository until closed.
type Watcher struct {
	onChange func(context.Context, Change)
	logger   *slog.Logger

	mu     sync.Mutex
	layout Layout
	source source
	cancel context.CancelFunc
}

// Start watches layout and calls onChange, never concurrently, after each
// burst of filesystem activity.
func Start(layout Layout, onChange func(context.Context, Change), logger *slog.Logger) (*Watcher, error) {
	w := &Watcher{onChange: onChange, logger: logger}
	return w, w.Update(layout)
}

// Update re-targets the watcher after worktrees are added or removed.
func (w *Watcher) Update(layout Layout) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopLocked()
	src, err := newSource(roots(layout))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.layout, w.source, w.cancel = layout, src, cancel
	if unwatched := src.Unwatched(); len(unwatched) > 0 {
		w.logger.Warn("too many directories to watch, polling worktree status instead", "roots", unwatched)
	}
	go w.run(ctx, layout, src)
	return nil
}

// Degraded reports whether some worktrees are polled because the system's
// watch limit was reached.
func (w *Watcher) Degraded() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.source != nil && len(w.source.Unwatched()) > 0
}

// Close stops watching.
func (w *Watcher) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopLocked()
}

func (w *Watcher) stopLocked() {
	if w.source == nil {
		return
	}
	w.cancel()
	if err := w.source.Close(); err != nil {
		w.logger.Warn("closing watcher failed", "error", err)
	}
	w.source = nil
}

func roots(layout Layout) []string {
	paths := []string{layout.CommonDir}
	for _, wt := range layout.Worktrees {
		paths = append(paths, wt.Path)
		if wt.GitDir != "" && !within(wt.GitDir, layout.CommonDir) {
			paths = append(paths, wt.GitDir)
		}
	}
	return paths
}

func (w *Watcher) run(ctx context.Context, layout Layout, src source) {
	pending := Change{Status: map[model.WorktreeID]bool{}}
	var quiet, deadline <-chan time.Time
	poll := time.NewTicker(pollInterval)
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case paths, ok := <-src.Events():
			if !ok {
				return
			}
			change := Classify(layout, paths)
			if change.empty() {
				continue
			}
			pending.merge(change)
			quiet = time.After(quietPeriod)
			if deadline == nil {
				deadline = time.After(maxDelay)
			}
			continue
		case <-poll.C:
			for _, wt := range layout.Worktrees {
				if slices.Contains(src.Unwatched(), wt.Path) {
					pending.Status[wt.ID] = true
				}
			}
			if pending.empty() {
				continue
			}
		case <-quiet:
		case <-deadline:
		}
		w.onChange(ctx, pending)
		pending = Change{Status: map[model.WorktreeID]bool{}}
		quiet, deadline = nil, nil
	}
}

// Classify maps changed paths to the refreshes they call for. Object
// database writes, reflogs and lock files are ignored: they either change
// nothing visible or are followed by an event that does.
func Classify(layout Layout, paths []string) Change {
	change := Change{Status: map[model.WorktreeID]bool{}}
	for _, path := range paths {
		classifyPath(layout, filepath.Clean(path), &change)
	}
	return change
}

func classifyPath(layout Layout, path string, change *Change) {
	if strings.HasSuffix(path, ".lock") {
		return
	}
	for _, wt := range layout.Worktrees {
		if wt.GitDir != "" && wt.GitDir != layout.CommonDir && within(path, wt.GitDir) {
			classifyGitDirPath(relative(wt.GitDir, path), wt.ID, change)
			return
		}
	}
	if within(path, layout.CommonDir) {
		rel := relative(layout.CommonDir, path)
		if rel == "worktrees" || strings.HasPrefix(rel, "worktrees"+string(filepath.Separator)) {
			change.Worktrees = true
			return
		}
		classifyCommonDirPath(layout, rel, change)
		return
	}
	for _, wt := range layout.Worktrees {
		if within(path, wt.Path) {
			change.Status[wt.ID] = true
			return
		}
	}
}

func classifyCommonDirPath(layout Layout, rel string, change *Change) {
	first, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	switch first {
	case "objects", "logs", "hooks", "info", "FETCH_HEAD", "ORIG_HEAD", "COMMIT_EDITMSG":
		return
	case "refs", "packed-refs":
		change.Refs = true
		return
	case "config":
		change.Remotes = true
		change.Refs = true
		return
	}
	for _, wt := range layout.Worktrees {
		if wt.GitDir == layout.CommonDir {
			classifyGitDirPath(rel, wt.ID, change)
			return
		}
	}
	if first == "HEAD" {
		change.Refs = true // a bare repository's HEAD
	}
}

// classifyGitDirPath handles files in a worktree's private git dir.
func classifyGitDirPath(rel string, id model.WorktreeID, change *Change) {
	first, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	switch first {
	case "HEAD":
		change.Worktrees = true
		change.Refs = true
		change.Status[id] = true
	case "index":
		change.Status[id] = true
	case "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply":
		change.Worktrees = true
		change.Status[id] = true
	}
}

func within(path, dir string) bool {
	return path == dir || strings.HasPrefix(path, dir+string(filepath.Separator))
}

func relative(dir, path string) string {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return path
	}
	return rel
}
