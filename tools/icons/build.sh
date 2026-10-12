#!/usr/bin/env bash
# Runs inside the icons image with the repository mounted at /work.
set -euo pipefail

brand=/work/assets/brand
out="$brand/generated"
render() { rsvg-convert -w "$2" -h "$2" -o "$3" "$1"; }

python3 /tools/wordmark.py "$brand/forkit-icon.svg" /fonts/SpaceGrotesk-Bold.ttf "$brand/forkit-wordmark.svg"

rm -rf "$out"
mkdir -p "$out/png" "$out/macos" "$out/windows"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# App icon PNGs.
for size in 16 32 64 128 256 512 1024; do
  render "$brand/forkit-icon.svg" "$size" "$out/png/forkit-icon-$size.png"
done

# macOS app icon. Wails builds its own .icns from build/appicon.png, so this
# one is for anything else that wants an .icns.
python3 /tools/pack.py icns "$out/macos/Forkit.icns" "$out"/png/forkit-icon-{16,32,64,128,256,512,1024}.png

# macOS menu bar icons. The "Template" suffix tells macOS to recolour them
# for light and dark menu bars.
for size in 16 18; do
  render "$brand/forkit-tray.svg" "$size" "$out/macos/tray${size}Template.png"
  render "$brand/forkit-tray.svg" "$((size * 2))" "$out/macos/tray${size}Template@2x.png"
done

# Windows: the tile is too busy at small sizes, so 16-48 px use the glyph.
for size in 16 24 32 48; do
  render "$brand/forkit-glyph.svg" "$size" "$work/ico-$size.png"
done
render "$brand/forkit-icon.svg" 256 "$work/ico-256.png"
python3 /tools/pack.py ico "$out/windows/forkit.ico" "$work"/ico-{16,24,32,48,256}.png

# Windows notification area icon: white, for the dark taskbar.
sed 's/#000/#fff/g' "$brand/forkit-tray.svg" > "$work/tray-white.svg"
render "$work/tray-white.svg" 16 "$out/windows/tray-white-16.png"

# Where Wails v2 looks when building.
cp "$out/png/forkit-icon-1024.png" /work/build/appicon.png
mkdir -p /work/build/windows
cp "$out/windows/forkit.ico" /work/build/windows/icon.ico
