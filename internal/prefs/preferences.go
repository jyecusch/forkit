// Package prefs persists user preferences and session state as JSON files in
// the OS config directory and publishes them to the frontend.
package prefs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/schema"
)

// CurrentVersion is the preferences file format this build reads and writes.
const CurrentVersion = 1

const preferencesID = "user"

// Defaults returns the preferences used for anything a file does not set.
func Defaults() model.Preferences {
	return model.Preferences{
		ID:      preferencesID,
		Version: CurrentVersion,
		Appearance: model.AppearancePreferences{
			Appearance: model.AppearanceSystem,
			LightTheme: model.LightThemeTokyoNightDay,
			DarkTheme:  model.DarkThemeTokyoNight,
			FontSize:   13,
			DateFormat: model.DateFormatRelative,
		},
		Graph: model.GraphPreferences{
			Order:              model.GraphOrderTopo,
			ShowRemoteBranches: true,
			ShowTags:           true,
			DimmedOpacity:      0.4,
		},
		Diff:      model.DiffPreferences{},
		Git:       model.GitPreferences{MaintainCommitGraph: true},
		Behaviour: model.BehaviourPreferences{DirtyCheckout: model.DirtyCheckoutAsk},
		Telemetry: model.TelemetryPreferences{Mode: model.TelemetryModeLocal},
	}
}

// Store owns the preferences file.
type Store struct {
	path      string
	channel   synchub.Channel[model.Preferences]
	validator *jsonschema.Schema
	logger    *slog.Logger

	// mu guards current and listeners. notifyMu keeps listeners seeing
	// changes in order; it is taken before mu is released, and listeners run
	// without mu so they may call the store.
	mu        sync.Mutex
	notifyMu  sync.Mutex
	current   model.Preferences
	listeners []func(context.Context, model.Preferences)
}

// InvalidPreferenceError is a change the schema does not allow, or a path
// that names no preference.
type InvalidPreferenceError struct{ Err error }

func (e *InvalidPreferenceError) Error() string { return e.Err.Error() }
func (e *InvalidPreferenceError) Unwrap() error { return e.Err }

// OpenStore loads preferences from dir, falling back to defaults when the
// file is missing or invalid, and publishes them.
func OpenStore(ctx context.Context, dir string, channel synchub.Channel[model.Preferences], logger *slog.Logger) (*Store, error) {
	validator, err := compileValidator()
	if err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "preferences.json"), channel: channel, validator: validator, logger: logger}
	s.current = s.load()
	return s, s.channel.Publish(ctx, preferencesID, []model.Preferences{s.current})
}

func compileValidator() (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schema.JSON))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("forkit.schema.json", doc); err != nil {
		return nil, err
	}
	return compiler.Compile("forkit.schema.json#/$defs/Preferences")
}

// OnChange registers listen to be called, in order, with the new
// preferences after every change, including hand edits picked up by Watch.
func (s *Store) OnChange(listen func(context.Context, model.Preferences)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners = append(s.listeners, listen)
}

// Get returns the current preferences.
func (s *Store) Get() model.Preferences {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

// Set changes the preference at a dot-separated path such as
// "graph.dimmedOpacity", rejecting values the schema does not allow.
func (s *Store) Set(ctx context.Context, path string, value any) error {
	s.mu.Lock()
	tree, err := toTree(s.current)
	if err == nil {
		err = setPath(tree, path, value)
	}
	var next model.Preferences
	if err == nil {
		next, err = s.decode(tree)
	}
	if err != nil {
		s.mu.Unlock()
		return &InvalidPreferenceError{err}
	}
	if err := writeJSONAtomic(s.path, next); err != nil {
		s.mu.Unlock()
		return err
	}
	return s.replaceLocked(ctx, next)
}

// Reset restores the default value at path.
func (s *Store) Reset(ctx context.Context, path string) error {
	defaults, err := toTree(Defaults())
	if err != nil {
		return err
	}
	value, err := getPath(defaults, path)
	if err != nil {
		return &InvalidPreferenceError{err}
	}
	return s.Set(ctx, path, value)
}

// replaceLocked installs next, publishes it and notifies listeners. It is
// called with s.mu held and releases it.
func (s *Store) replaceLocked(ctx context.Context, next model.Preferences) error {
	if next == s.current {
		s.mu.Unlock()
		return nil
	}
	s.current = next
	listeners := slices.Clone(s.listeners)
	err := s.channel.Publish(ctx, preferencesID, []model.Preferences{next})
	s.notifyMu.Lock()
	defer s.notifyMu.Unlock()
	s.mu.Unlock()
	for _, listen := range listeners {
		listen(ctx, next)
	}
	return err
}

// Watch reloads the file when it is edited by hand until ctx ends.
func (s *Store) Watch(ctx context.Context) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := watcher.Add(filepath.Dir(s.path)); err != nil {
		watcher.Close()
		return err
	}
	go func() {
		defer watcher.Close()
		var reload <-chan time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case event := <-watcher.Events:
				if filepath.Clean(event.Name) == s.path {
					reload = time.After(50 * time.Millisecond)
				}
			case err := <-watcher.Errors:
				s.logger.WarnContext(ctx, "watching preferences failed", "error", err)
			case <-reload:
				s.reload(ctx)
			}
		}
	}()
	return nil
}

func (s *Store) reload(ctx context.Context) {
	s.mu.Lock()
	if err := s.replaceLocked(ctx, s.load()); err != nil {
		s.logger.ErrorContext(ctx, "publishing preferences failed", "error", err)
	}
}

// load reads the file layered over the defaults, so a file that only sets a
// few keys keeps defaults for the rest.
func (s *Store) load() model.Preferences {
	prefs, err := s.readFile()
	switch {
	case errors.Is(err, os.ErrNotExist):
		return Defaults()
	case err != nil:
		s.logger.Warn("ignoring invalid preferences file, using defaults", "path", s.path, "error", err)
		return Defaults()
	}
	return prefs
}

func (s *Store) readFile() (model.Preferences, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return model.Preferences{}, err
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil {
		return model.Preferences{}, err
	}
	if version, _ := file["version"].(float64); version != CurrentVersion {
		return model.Preferences{}, fmt.Errorf("unsupported preferences version %v", file["version"])
	}
	migrateTheme(file)
	tree, err := toTree(Defaults())
	if err != nil {
		return model.Preferences{}, err
	}
	mergeTrees(tree, file)
	return s.decode(tree)
}

func (s *Store) decode(tree map[string]any) (model.Preferences, error) {
	encoded, err := json.Marshal(tree)
	if err != nil {
		return model.Preferences{}, err
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		return model.Preferences{}, err
	}
	if err := s.validator.Validate(instance); err != nil {
		return model.Preferences{}, err
	}
	var prefs model.Preferences
	err = json.Unmarshal(encoded, &prefs)
	return prefs, err
}

func toTree(v any) (map[string]any, error) {
	encoded, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var tree map[string]any
	return tree, json.Unmarshal(encoded, &tree)
}

func mergeTrees(base, overlay map[string]any) {
	for key, value := range overlay {
		baseChild, baseIsTree := base[key].(map[string]any)
		overlayChild, overlayIsTree := value.(map[string]any)
		if baseIsTree && overlayIsTree {
			mergeTrees(baseChild, overlayChild)
			continue
		}
		base[key] = value
	}
}

func setPath(tree map[string]any, path string, value any) error {
	parent, leaf, err := walkPath(tree, path)
	if err != nil {
		return err
	}
	parent[leaf] = value
	return nil
}

func getPath(tree map[string]any, path string) (any, error) {
	parent, leaf, err := walkPath(tree, path)
	if err != nil {
		return nil, err
	}
	return parent[leaf], nil
}

func walkPath(tree map[string]any, path string) (map[string]any, string, error) {
	keys := strings.Split(path, ".")
	if len(keys) < 2 {
		return nil, "", fmt.Errorf("unknown preference %q", path)
	}
	parent := tree
	for _, key := range keys[:len(keys)-1] {
		child, ok := parent[key].(map[string]any)
		if !ok {
			return nil, "", fmt.Errorf("unknown preference %q", path)
		}
		parent = child
	}
	leaf := keys[len(keys)-1]
	if _, ok := parent[leaf]; !ok {
		return nil, "", fmt.Errorf("unknown preference %q", path)
	}
	return parent, leaf, nil
}

// migrateTheme rewrites appearance.theme, which named one theme or "system",
// as the appearance that replaced it, so older files still load.
func migrateTheme(file map[string]any) {
	appearance, _ := file["appearance"].(map[string]any)
	theme, ok := appearance["theme"].(string)
	if !ok {
		return
	}
	delete(appearance, "theme")
	switch theme {
	case "tokyo-night":
		appearance["appearance"] = string(model.AppearanceDark)
	case "tokyo-night-day":
		appearance["appearance"] = string(model.AppearanceLight)
	default:
		appearance["appearance"] = string(model.AppearanceSystem)
	}
}
