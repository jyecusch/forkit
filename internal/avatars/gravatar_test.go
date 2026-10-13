package avatars

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// png is the start of a PNG file, enough for its type to be recognised.
var png = []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 24))

type fakeGravatar struct {
	*Gravatar
	requests atomic.Int32
	// up is false while Gravatar cannot be reached.
	up atomic.Bool
}

// newFakeGravatar serves a picture for ada@example.com and none for anyone else.
func newFakeGravatar(t *testing.T) *fakeGravatar {
	t.Helper()
	f := &fakeGravatar{}
	f.up.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		switch {
		case !f.up.Load():
			w.WriteHeader(http.StatusBadGateway)
		case strings.HasSuffix(r.URL.Path, hashEmail("ada@example.com")):
			_, _ = w.Write(png)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	f.Gravatar = NewGravatar(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	f.baseURL = server.URL + "/avatar/"
	return f
}

// age makes the answer kept for email look fetched long ago.
func (f *fakeGravatar) age(t *testing.T, email string, by time.Duration) {
	t.Helper()
	path := filepath.Join(f.dir, hashEmail(email))
	for _, file := range []string{path, path + missingSuffix} {
		if _, err := os.Stat(file); err == nil {
			when := time.Now().Add(-by)
			if err := os.Chtimes(file, when, when); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestPicturesAreKeptAndFetchedAgainWhenStale(t *testing.T) {
	ctx := context.Background()
	f := newFakeGravatar(t)

	// Gravatar's key ignores case and surrounding space.
	picture := f.Picture(ctx, " Ada@Example.com ")
	if !strings.HasPrefix(picture, "data:image/png;base64,") {
		t.Fatalf("picture = %.40q, want a PNG data URL", picture)
	}
	if f.Picture(ctx, "ada@example.com") != picture || f.requests.Load() != 1 {
		t.Errorf("a kept picture was fetched again (%d requests)", f.requests.Load())
	}

	f.age(t, "ada@example.com", foundFor+time.Hour)
	f.Picture(ctx, "ada@example.com")
	if f.requests.Load() != 2 {
		t.Errorf("a week-old picture was not fetched again (%d requests)", f.requests.Load())
	}
}

func TestMissingPicturesAreRememberedForADay(t *testing.T) {
	ctx := context.Background()
	f := newFakeGravatar(t)

	if picture := f.Picture(ctx, "bo@example.com"); picture != "" {
		t.Fatalf("picture = %.40q, want none", picture)
	}
	f.Picture(ctx, "bo@example.com")
	if f.requests.Load() != 1 {
		t.Errorf("Gravatar was asked again about an email it has no picture for (%d requests)", f.requests.Load())
	}

	f.age(t, "bo@example.com", missingFor+time.Hour)
	f.Picture(ctx, "bo@example.com")
	if f.requests.Load() != 2 {
		t.Errorf("a day-old answer was not checked again (%d requests)", f.requests.Load())
	}
}

func TestAKeptPictureIsUsedWhileGravatarIsDown(t *testing.T) {
	ctx := context.Background()
	f := newFakeGravatar(t)
	picture := f.Picture(ctx, "ada@example.com")
	f.age(t, "ada@example.com", foundFor+time.Hour)
	f.up.Store(false)

	if got := f.Picture(ctx, "ada@example.com"); got != picture {
		t.Error("the kept picture was not used while Gravatar was down")
	}
	if got := f.Picture(ctx, "bo@example.com"); got != "" {
		t.Error("an email never fetched has a picture while Gravatar is down")
	}
	f.up.Store(true)
	if f.Picture(ctx, "bo@example.com"); f.requests.Load() != 4 {
		t.Errorf("a failed fetch was remembered as no picture (%d requests)", f.requests.Load())
	}
}
