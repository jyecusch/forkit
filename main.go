package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"github.com/jyecusch/forkit/internal/app"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	forkit := app.New(version)
	err := wails.Run(&options.App{
		Title:            "Forkit",
		Width:            1440,
		Height:           900,
		MinWidth:         900,
		MinHeight:        560,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 26, G: 27, B: 38, A: 255},
		OnStartup:        forkit.Startup,
		OnShutdown:       forkit.Shutdown,
		Bind:             forkit.Server.Services(),
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
