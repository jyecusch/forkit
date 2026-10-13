package prefs_test

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/synchub"
)

func openSession(t *testing.T, dir string) *prefs.SessionStore {
	t.Helper()
	hub := synchub.New(nopEmitter{}, noop.NewTracerProvider().Tracer(""))
	channel := synchub.NewChannel(hub, "session", func(s model.Session) string { return s.ID })
	store, err := prefs.OpenSessionStore(context.Background(), dir, channel, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestLayoutSizesAreKeptAcrossRestarts(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store := openSession(t, dir)
	if err := store.Update(ctx, func(s *model.Session) { s.Layout = map[string]float64{"sidebar": 280, "staged": 0.3} }); err != nil {
		t.Fatal(err)
	}
	earlier := store.Get()
	if err := store.Update(ctx, func(s *model.Session) { s.Layout["sidebar"] = 300 }); err != nil {
		t.Fatal(err)
	}
	if earlier.Layout["sidebar"] != 280 {
		t.Error("an update changed an earlier copy of the session")
	}
	if err := store.Update(ctx, func(s *model.Session) { s.Layout["sidebar"] = 280 }); err != nil {
		t.Fatal(err)
	}

	got := openSession(t, dir).Get().Layout
	if got["sidebar"] != 280 || got["staged"] != 0.3 {
		t.Errorf("layout after reopening = %v", got)
	}
}
