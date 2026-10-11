package prefs_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/synchub"
)

type nopEmitter struct{}

func (nopEmitter) Emit(string, any) {}

func openStore(t *testing.T, dir string) *prefs.Store {
	t.Helper()
	hub := synchub.New(nopEmitter{}, noop.NewTracerProvider().Tracer(""))
	channel := synchub.NewChannel(hub, "preferences", func(p model.Preferences) string { return p.ID })
	store, err := prefs.OpenStore(context.Background(), dir, channel, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func writeFile(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "preferences.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPartialFileKeepsDefaultsForMissingKeys(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{"version": 1, "graph": {"showTags": false}}`)

	got := openStore(t, dir).Get()
	if got.Graph.ShowTags {
		t.Error("showTags from the file was not applied")
	}
	if got.Graph.DimmedOpacity != prefs.Defaults().Graph.DimmedOpacity {
		t.Error("missing dimmedOpacity did not fall back to the default")
	}
}

func TestInvalidFileFallsBackToDefaults(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{"version": 1, "appearance": {"fontSize": 99}}`)

	if got := openStore(t, dir).Get(); got != prefs.Defaults() {
		t.Errorf("got %+v, want defaults", got)
	}
}

func TestSetValidatesAndPersists(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store := openStore(t, dir)

	if err := store.Set(ctx, "graph.dimmedOpacity", 5.0); err == nil {
		t.Error("out-of-range value was accepted")
	}
	if err := store.Set(ctx, "graph.nope", true); err == nil {
		t.Error("unknown key was accepted")
	}
	if err := store.Set(ctx, "appearance.theme", "tokyo-night-day"); err != nil {
		t.Fatal(err)
	}

	if got := openStore(t, dir).Get().Appearance.Theme; got != model.ThemeTokyoNightDay {
		t.Errorf("reopened theme = %q", got)
	}
}

func TestResetRestoresDefault(t *testing.T) {
	ctx := context.Background()
	store := openStore(t, t.TempDir())
	_ = store.Set(ctx, "graph.showTags", false)

	if err := store.Reset(ctx, "graph.showTags"); err != nil {
		t.Fatal(err)
	}
	if !store.Get().Graph.ShowTags {
		t.Error("showTags was not reset")
	}
}

func TestWatchPicksUpHandEdits(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	store := openStore(t, dir)
	if err := store.Watch(ctx); err != nil {
		t.Fatal(err)
	}

	writeFile(t, dir, `{"version": 1, "appearance": {"fontSize": 16}}`)

	deadline := time.Now().Add(2 * time.Second)
	for store.Get().Appearance.FontSize != 16 {
		if time.Now().After(deadline) {
			t.Fatal("hand edit was not picked up")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
