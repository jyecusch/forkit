// Package avatars finds pictures of commit authors, keeping them on disk so
// each is fetched rarely.
package avatars

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	// foundFor and missingFor are how long Gravatar's answers are trusted:
	// a picture is fetched again after a week, and an email without one is
	// asked about again after a day.
	foundFor   = 7 * 24 * time.Hour
	missingFor = 24 * time.Hour
	// pictureSize is the width fetched, enough for the largest avatar on a
	// high-density screen.
	pictureSize  = 96
	fetchTimeout = 10 * time.Second
	// maxPicture bounds how much of a response is read.
	maxPicture = 1 << 20
)

// Gravatar fetches authors' pictures from Gravatar and keeps its answers in
// a directory.
type Gravatar struct {
	dir     string
	baseURL string
	client  *http.Client
	logger  *slog.Logger
	flights singleflight.Group
}

// NewGravatar keeps answers in dir, which is created when first needed.
func NewGravatar(dir string, logger *slog.Logger) *Gravatar {
	return &Gravatar{dir: dir, baseURL: "https://gravatar.com/avatar/", client: &http.Client{Timeout: fetchTimeout}, logger: logger}
}

// Picture returns the picture Gravatar has for email as a data URL, or ""
// when it has none. The disk cache is best-effort, and when Gravatar cannot
// be reached a picture kept from before is used however old. Failures are
// logged rather than returned, since nobody can act on them.
func (g *Gravatar) Picture(ctx context.Context, email string) string {
	key := hashEmail(email)
	// Rows by the same author ask at once; they share one answer.
	picture, _, _ := g.flights.Do(key, func() (any, error) {
		return g.picture(context.WithoutCancel(ctx), key), nil
	})
	return picture.(string)
}

func (g *Gravatar) picture(ctx context.Context, key string) string {
	path := filepath.Join(g.dir, key)
	kept, keptAt := readKept(path)
	if kept != nil && time.Since(keptAt) < foundFor {
		return dataURL(kept)
	}
	if info, err := os.Stat(path + missingSuffix); err == nil && time.Since(info.ModTime()) < missingFor {
		return ""
	}

	fetched, err := g.fetch(ctx, key)
	if err != nil {
		g.logger.WarnContext(ctx, "fetching a Gravatar failed", "error", err)
		if kept != nil {
			return dataURL(kept)
		}
		return ""
	}
	if err := g.remember(path, fetched); err != nil {
		g.logger.WarnContext(ctx, "keeping a Gravatar failed", "error", err)
	}
	if fetched == nil {
		return ""
	}
	return dataURL(fetched)
}

// fetch asks Gravatar for key's picture, which is nil when it has none.
func (g *Gravatar) fetch(ctx context.Context, key string) ([]byte, error) {
	url := fmt.Sprintf("%s%s?s=%d&d=404", g.baseURL, key, pictureSize)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Forkit")
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return io.ReadAll(io.LimitReader(resp.Body, maxPicture))
	case http.StatusNotFound:
		return nil, nil
	}
	return nil, fmt.Errorf("gravatar answered %s", resp.Status)
}

// missingSuffix names the empty file kept when Gravatar has no picture.
const missingSuffix = ".none"

// remember keeps a picture at path, or with nil the fact that there is none.
func (g *Gravatar) remember(path string, picture []byte) error {
	if err := os.MkdirAll(g.dir, 0o755); err != nil {
		return err
	}
	if picture == nil {
		_ = os.Remove(path)
		return os.WriteFile(path+missingSuffix, nil, 0o644)
	}
	_ = os.Remove(path + missingSuffix)
	temp := path + ".tmp"
	if err := os.WriteFile(temp, picture, 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

// readKept returns a kept picture and when it was fetched, or nil when there
// is none that can be read.
func readKept(path string) ([]byte, time.Time) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return nil, time.Time{}
	}
	return data, info.ModTime()
}

// hashEmail is Gravatar's key for an email.
func hashEmail(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}

func dataURL(picture []byte) string {
	return "data:" + http.DetectContentType(picture) + ";base64," + base64.StdEncoding.EncodeToString(picture)
}
