#!/bin/zsh
# Assemble "Muster Code.app" from a prebuilt Code-OSS binary (VSCodium release)
# + the Muster product overlay + the built-in Muster layer. No VS Code compile.
#
#   scripts/assemble.sh            # uses cached base zip if present
#   BASE_TAG=1.126.04524 scripts/assemble.sh
#
# Output: dist/Muster Code.app (ad-hoc signed for local use; Developer ID
# signing + notarization is a separate, keyed step: scripts/sign.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_TAG="${BASE_TAG:-1.126.04524}"
CACHE="$ROOT/.cache"
DIST="$ROOT/dist"
APP="$DIST/Muster Code.app"
ZIP="$CACHE/VSCodium-darwin-arm64-$BASE_TAG.zip"

mkdir -p "$CACHE" "$DIST"
if [[ ! -f "$ZIP" ]]; then
  echo "▸ fetching Code-OSS base $BASE_TAG"
  curl -sL -o "$ZIP" "https://github.com/VSCodium/vscodium/releases/download/$BASE_TAG/VSCodium-darwin-arm64-$BASE_TAG.zip"
fi

echo "▸ unpacking base"
rm -rf "$APP" "$DIST/VSCodium.app"
unzip -q "$ZIP" -d "$DIST"
mv "$DIST/VSCodium.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

RES="$APP/Contents/Resources/app"

echo "▸ applying product overlay"
node "$ROOT/scripts/overlay-product.mjs" "$RES/product.json" "$ROOT/product/product.overlay.json"

echo "▸ branding"
cp "$ROOT/product/Muster Code.icns" "$APP/Contents/Resources/Codium.icns" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName Muster Code" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Muster Code" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier dev.themuster.code" "$APP/Contents/Info.plist"

echo "▸ installing the built-in Muster layer"
pnpm --filter @muster-code/builtin build >/dev/null
rm -rf "$RES/extensions/muster.muster-code"
cp -R "$ROOT/packages/builtin/dist-ext" "$RES/extensions/muster.muster-code"

echo "▸ signing (ad-hoc, local use)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

echo "✓ $APP"
