#!/bin/sh
# Regenerates resources/icon.icns from resources/icon.svg (macOS; needs rsvg-convert from `brew install librsvg`).
# The .icns is committed, so builds and CI never run this.
set -eu
cd "$(dirname "$0")/../resources"
set_dir=$(mktemp -d)/icon.iconset
mkdir -p "$set_dir"
for size in 16 32 128 256 512; do
  rsvg-convert -w $size -h $size icon.svg -o "$set_dir/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) icon.svg -o "$set_dir/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$set_dir" -o icon.icns
echo "wrote $(pwd)/icon.icns"
# Linux hicolor sizes (electron-builder.yml linux.icon): desktops pick the size they need instead of scaling 512 px.
mkdir -p linux/icons
for size in 16 24 32 48 64 128 256 512; do rsvg-convert -w $size -h $size icon.svg -o "linux/icons/${size}x${size}.png"; done
echo "wrote $(pwd)/linux/icons"
