// Package app wires the backend together and ties it to the Wails
// application lifecycle.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"go.opentelemetry.io/otel"

	"github.com/jyecusch/forkit/internal/avatars"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/prefs"
	"github.com/jyecusch/forkit/internal/rpc"
	"github.com/jyecusch/forkit/internal/synchub"
	"github.com/jyecusch/forkit/internal/telemetry"
	"github.com/jyecusch/forkit/internal/workspace"
)

// otlpEndpointEnv sends telemetry to a collector during development,
// regardless of preferences.
const otlpEndpointEnv = "FORKIT_OTLP_ENDPOINT"

// App is the running backend.
type App struct {
	Version string
	Server  *rpc.Server

	telemetry *telemetry.Telemetry
	workspace *workspace.Workspace
	cancel    context.CancelFunc
}

// New creates an app whose services can be bound before it starts.
func New(version string) *App {
	return &App{Version: version, Server: rpc.NewServer()}
}

// Startup builds the backend. Wails calls it before the frontend loads.
func (a *App) Startup(wailsCtx context.Context) {
	if err := a.start(wailsCtx); err != nil {
		slog.Error("starting Forkit failed", "error", err)
		runtime.MessageDialog(wailsCtx, runtime.MessageDialogOptions{
			Type:    runtime.ErrorDialog,
			Title:   "Forkit could not start",
			Message: err.Error(),
		})
		runtime.Quit(wailsCtx)
	}
}

func (a *App) start(wailsCtx context.Context) error {
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	configDir, cacheDir, err := appDirs()
	if err != nil {
		return err
	}
	// Spans started before telemetry is configured go to the global
	// provider, which forwards them once it is set below.
	tracer := otel.Tracer("forkit")
	hub := synchub.New(wailsEmitter{wailsCtx}, tracer)
	bootLogger := slog.Default()

	preferences, err := prefs.OpenStore(ctx, configDir, synchub.NewChannel(hub, "preferences", func(p model.Preferences) string { return p.ID }), bootLogger)
	if err != nil {
		return err
	}
	a.telemetry, err = telemetry.Start(ctx, telemetryConfig(preferences.Get(), cacheDir, a.Version))
	if err != nil {
		return err
	}
	otel.SetTracerProvider(a.telemetry.Provider())
	slog.SetDefault(a.telemetry.Logger)
	logger := a.telemetry.Logger

	if err := preferences.Watch(ctx); err != nil {
		logger.Warn("watching preferences failed", "error", err)
	}
	session, err := prefs.OpenSessionStore(ctx, configDir, synchub.NewChannel(hub, "session", func(s model.Session) string { return s.ID }), logger)
	if err != nil {
		return err
	}
	git, err := gitexec.New(ctx, preferences.Get().Git.BinaryPath, tracer)
	if err != nil {
		return err
	}
	a.workspace = workspace.New(git, workspace.NewChannels(hub), preferences, session, tracer, logger)
	a.Server.Start(&rpc.Deps{
		Ctx:       ctx,
		Hub:       hub,
		Workspace: a.workspace,
		Prefs:     preferences,
		Session:   session,
		Telemetry: a.telemetry,
		Gravatar:  avatars.NewGravatar(filepath.Join(cacheDir, "gravatar"), logger),
		Tracer:    tracer,
		ChooseDirectory: func(title string) (string, error) {
			return runtime.OpenDirectoryDialog(wailsCtx, runtime.OpenDialogOptions{Title: title})
		},
	})
	go a.workspace.Restore(ctx)
	logger.Info("Forkit started", "version", a.Version, "git", git.Version().String())
	return nil
}

// Shutdown stops watchers and flushes telemetry. Wails calls it on quit.
func (a *App) Shutdown(context.Context) {
	ctx := context.Background()
	if a.workspace != nil {
		a.workspace.Shutdown(ctx)
	}
	if a.telemetry != nil {
		_ = a.telemetry.Shutdown(ctx)
	}
	if a.cancel != nil {
		a.cancel()
	}
}

func appDirs() (config, cache string, err error) {
	configRoot, err := os.UserConfigDir()
	if err != nil {
		return "", "", fmt.Errorf("finding config directory: %w", err)
	}
	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return "", "", fmt.Errorf("finding cache directory: %w", err)
	}
	config = filepath.Join(configRoot, "Forkit")
	return config, filepath.Join(cacheRoot, "Forkit"), os.MkdirAll(config, 0o755)
}

func telemetryConfig(p model.Preferences, cacheDir, version string) telemetry.Config {
	cfg := telemetry.Config{Dir: filepath.Join(cacheDir, "telemetry"), ServiceVersion: version}
	switch {
	case os.Getenv(otlpEndpointEnv) != "":
		cfg.OTLPEndpoint = os.Getenv(otlpEndpointEnv)
	case p.Telemetry.Mode == model.TelemetryModeOTLP:
		cfg.OTLPEndpoint = p.Telemetry.OTLPEndpoint
	}
	return cfg
}

type wailsEmitter struct{ ctx context.Context }

func (e wailsEmitter) Emit(event string, payload any) {
	runtime.EventsEmit(e.ctx, event, payload)
}
