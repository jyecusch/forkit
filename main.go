package main

import (
	"embed"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
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
		MaxWidth:         maxWindowSize(),
		MaxHeight:        maxWindowSize(),
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 14, G: 14, B: 20, A: 255},
		Menu:             appMenu(),
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

// maxWindowSize lifts the cap Wails puts on Linux windows when no maximum is
// set: the size of the monitor the window opened on, which makes Hyprland
// float it on any larger monitor. Other platforms have no cap without one.
// TODO: Remove this following an upstream fix for Linux window sizing in Wails.
func maxWindowSize() int {
	if runtime.GOOS != "linux" {
		return 0
	}
	return 16384
}

// appMenu gives macOS its standard application and Edit menus, without
// which copy, paste and select-all do not reach text fields. Other platforms
// have no menu bar.
func appMenu() *menu.Menu {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return menu.NewMenuFromItems(menu.AppMenu(), menu.EditMenu())
}
