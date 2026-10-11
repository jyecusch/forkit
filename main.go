package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	err := wails.Run(&options.App{
		Title:            "Forkit",
		Width:            1440,
		Height:           900,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 26, G: 27, B: 38, A: 255},
	})
	if err != nil {
		log.Fatal(err)
	}
}
