package prefs

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/synchub"
)

const sessionID = "user"

// SessionStore owns the session file: open tabs and per-repo view state. It
// is kept apart from preferences so resetting preferences never closes tabs.
type SessionStore struct {
	path    string
	channel synchub.Channel[model.Session]

	mu      sync.Mutex
	current model.Session
}

// OpenSessionStore loads the session from dir, starting empty when the file
// is missing or unreadable.
func OpenSessionStore(ctx context.Context, dir string, channel synchub.Channel[model.Session], logger *slog.Logger) (*SessionStore, error) {
	s := &SessionStore{path: filepath.Join(dir, "session.json"), channel: channel}
	s.current = model.Session{ID: sessionID}
	raw, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		logger.Warn("ignoring unreadable session file", "path", s.path, "error", err)
	default:
		if err := json.Unmarshal(raw, &s.current); err != nil {
			logger.Warn("ignoring invalid session file", "path", s.path, "error", err)
			s.current = model.Session{ID: sessionID}
		}
	}
	return s, s.channel.Publish(ctx, sessionID, []model.Session{s.current})
}

// Get returns a copy of the current session.
func (s *SessionStore) Get() model.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneSession(s.current)
}

// Update applies change to a copy of the session, then saves and publishes it.
func (s *SessionStore) Update(ctx context.Context, change func(*model.Session)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneSession(s.current)
	change(&next)
	next.ID = sessionID
	if err := writeJSONAtomic(s.path, next); err != nil {
		return err
	}
	s.current = next
	return s.channel.Publish(ctx, sessionID, []model.Session{next})
}

func cloneSession(session model.Session) model.Session {
	session.OpenRepos = slices.Clone(session.OpenRepos)
	session.Layout = maps.Clone(session.Layout)
	return session
}
