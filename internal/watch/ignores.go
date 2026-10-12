package watch

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// ignoresTimeout bounds each question to git about ignored directories.
const ignoresTimeout = 10 * time.Second

// Ignores answers which directories git ignores in a worktree. The watcher
// neither watches them nor refreshes status for changes inside them, so a
// package manager filling node_modules costs nothing.
type Ignores interface {
	// Dirs lists the absolute paths of a worktree's ignored directories.
	Dirs(ctx context.Context, worktree string) ([]string, error)
	// Filter returns those of dirs, absolute paths inside worktree, that
	// are ignored.
	Filter(ctx context.Context, worktree string, dirs []string) ([]string, error)
}

// ignoreSet is what is known about one layout's ignored directories. It
// starts from git's list and learns about directories created later, such
// as a node_modules made by an install, the first time something changes
// in them.
type ignoreSet struct {
	ignores Ignores
	layout  Layout
	logger  *slog.Logger

	mu sync.Mutex
	// ignored holds each worktree's topmost ignored directories, by path.
	ignored map[string][]string
	// clean holds directories known not to be ignored.
	clean map[string]bool
}

func newIgnoreSet(ignores Ignores, layout Layout, logger *slog.Logger) *ignoreSet {
	layout = normalizeLayout(layout)
	set := &ignoreSet{ignores: ignores, layout: layout, logger: logger, ignored: map[string][]string{}, clean: map[string]bool{}}
	if ignores == nil {
		return set
	}
	ctx, cancel := context.WithTimeout(context.Background(), ignoresTimeout)
	defer cancel()
	for _, wt := range layout.Worktrees {
		dirs, err := ignores.Dirs(ctx, wt.Path)
		if err != nil {
			logger.Warn("listing ignored directories failed", "worktree", wt.Path, "error", err)
			continue
		}
		for _, dir := range dirs {
			set.ignored[wt.Path] = append(set.ignored[wt.Path], normalize(dir))
		}
	}
	return set
}

// skipDir reports whether dir, a directory about to be watched, is
// ignored. Git is asked about a directory only when it was just created;
// the list made when watching started covers the others.
func (s *ignoreSet) skipDir(dir string, created bool) bool {
	dir = normalize(dir)
	wt, ok := s.worktreeOf(dir)
	if !ok || dir == wt.Path {
		return false
	}
	if created {
		s.learn(wt, []string{dir})
	}
	return s.covers(wt, dir)
}

// drop removes paths inside ignored directories of the worktrees that
// contain them, first asking git about directories it has not seen.
func (s *ignoreSet) drop(paths []string) []string {
	unknown := map[string][]string{}
	worktrees := map[string]Worktree{}
	for _, path := range paths {
		path = normalize(path)
		wt, ok := s.worktreeOf(path)
		if !ok {
			continue
		}
		worktrees[wt.Path] = wt
		unknown[wt.Path] = append(unknown[wt.Path], filepath.Dir(path))
	}
	for root, dirs := range unknown {
		s.learn(worktrees[root], dirs)
	}
	return slices.DeleteFunc(paths, func(path string) bool {
		path = normalize(path)
		wt, ok := s.worktreeOf(path)
		return ok && s.covers(wt, path)
	})
}

// worktreeOf finds the innermost worktree containing path, unless path is
// in a git dir, which git never ignores.
func (s *ignoreSet) worktreeOf(path string) (Worktree, bool) {
	if within(path, s.layout.CommonDir) {
		return Worktree{}, false
	}
	for _, wt := range s.layout.Worktrees {
		if wt.GitDir != "" && within(path, wt.GitDir) {
			return Worktree{}, false
		}
	}
	return innermostWorktree(s.layout, path)
}

func (s *ignoreSet) covers(wt Worktree, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.ignored[wt.Path], func(dir string) bool { return within(path, dir) })
}

// learn asks git about dirs, and the directories between them and the
// worktree's root, that are not known either way, and records the answers.
func (s *ignoreSet) learn(wt Worktree, dirs []string) {
	if s.ignores == nil {
		return
	}
	var ask []string
	for _, dir := range dirs {
		for dir != wt.Path && within(dir, wt.Path) && !s.known(wt, dir) && !slices.Contains(ask, dir) {
			ask = append(ask, dir)
			dir = filepath.Dir(dir)
		}
	}
	if len(ask) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), ignoresTimeout)
	defer cancel()
	ignored, err := s.ignores.Filter(ctx, wt.Path, ask)
	if err != nil {
		s.logger.Warn("checking ignored directories failed", "worktree", wt.Path, "error", err)
		return
	}
	for i := range ignored {
		ignored[i] = normalize(ignored[i])
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, dir := range ask {
		switch {
		case !slices.Contains(ignored, dir):
			// A directory that no longer exists may be ignored once it is
			// made again, by a rule that applies only to directories.
			if _, err := os.Stat(dir); err == nil {
				s.clean[dir] = true
			}
		case !slices.Contains(ignored, filepath.Dir(dir)):
			// Only the topmost ignored directory is kept; it covers the rest.
			s.ignored[wt.Path] = append(s.ignored[wt.Path], dir)
		}
	}
}

func (s *ignoreSet) known(wt Worktree, dir string) bool {
	if s.covers(wt, dir) {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clean[dir]
}

// changesIgnoreRules reports whether path is a file that decides what git
// ignores.
func changesIgnoreRules(layout Layout, path string) bool {
	path = normalize(path)
	return filepath.Base(path) == ".gitignore" || path == filepath.Join(normalize(layout.CommonDir), "info", "exclude")
}
