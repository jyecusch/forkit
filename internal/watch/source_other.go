//go:build !darwin

package watch

import (
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/fsnotify/fsnotify"
)

// skippedDirs are never watched: they change constantly and never matter.
var skippedDirs = map[string]bool{"objects": true, "logs": true, "lfs": true}

// dirSource watches every directory under its roots individually, as
// inotify and ReadDirectoryChangesW require. Roots whose directories would
// exceed the system's watch budget are left unwatched.
type dirSource struct {
	watcher *fsnotify.Watcher
	events  chan []string
	done    chan struct{}
	// unwatched is fixed at construction.
	unwatched []string
}

func newSource(roots []string) (source, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	s := &dirSource{watcher: watcher, events: make(chan []string), done: make(chan struct{})}
	budget := watchBudget()
	for _, root := range roots {
		dirs := collectDirs(root)
		if len(dirs) > budget {
			s.unwatched = append(s.unwatched, root)
			continue
		}
		budget -= len(dirs)
		for _, dir := range dirs {
			_ = watcher.Add(dir)
		}
	}
	go s.forward()
	return s, nil
}

// watchBudget is half the per-user inotify limit, leaving room for other
// programs. Other platforms have no comparable limit.
func watchBudget() int {
	raw, err := os.ReadFile("/proc/sys/fs/inotify/max_user_watches")
	if err != nil {
		return 1 << 30
	}
	limit, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 1 << 30
	}
	return limit / 2
}

func collectDirs(root string) []string {
	var dirs []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if path != root && (d.Name() == ".git" || skippedDirs[d.Name()]) {
			return filepath.SkipDir
		}
		dirs = append(dirs, path)
		return nil
	})
	return dirs
}

func (s *dirSource) forward() {
	defer close(s.events)
	for {
		select {
		case <-s.done:
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					for _, dir := range collectDirs(event.Name) {
						_ = s.watcher.Add(dir)
					}
				}
			}
			select {
			case s.events <- []string{event.Name}:
			case <-s.done:
				return
			}
		case <-s.watcher.Errors:
		}
	}
}

func (s *dirSource) Events() <-chan []string { return s.events }

func (s *dirSource) Unwatched() []string { return s.unwatched }

func (s *dirSource) Close() error {
	close(s.done)
	return s.watcher.Close()
}
