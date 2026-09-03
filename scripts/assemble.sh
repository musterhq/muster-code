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
plist_set() { python3 "$ROOT/scripts/plist-set.py" "$@"; }
plist_set "$APP/Contents/Info.plist" CFBundleName="Muster Code" CFBundleDisplayName="Muster Code" CFBundleIdentifier=dev.themuster.code CFBundleExecutable="Muster Code"
mv "$APP/Contents/MacOS/VSCodium" "$APP/Contents/MacOS/Muster Code"
# Electron derives helper-app names from the main executable name: rename the
# main binary AND every helper consistently, or the app cannot find its helpers.
for H in "$APP"/Contents/Frameworks/VSCodium\ Helper*.app; do
  suffix="${H##*/VSCodium Helper}"; suffix="${suffix%.app}"
  NEW="$APP/Contents/Frameworks/Muster Code Helper${suffix}.app"
  mv "$H" "$NEW"
  mv "$NEW/Contents/MacOS/VSCodium Helper${suffix}" "$NEW/Contents/MacOS/Muster Code Helper${suffix}"
  ident="dev.themuster.code.helper$(echo "${suffix}" | tr -d ' ()' | tr '[:upper:]' '[:lower:]')"
  plist_set "$NEW/Contents/Info.plist" CFBundleExecutable="Muster Code Helper${suffix}" CFBundleName="Muster Code Helper${suffix}" CFBundleDisplayName="Muster Code Helper${suffix}" CFBundleIdentifier="$ident"
done

# The CLI launchers hardcode the old executable name.
sed -i '' 's#/MacOS/VSCodium#/MacOS/Muster Code#g' "$RES/bin/codium" "$RES/bin/codium-tunnel" 2>/dev/null || true
mv "$RES/bin/codium" "$RES/bin/muster-code" 2>/dev/null || true
mv "$RES/bin/codium-tunnel" "$RES/bin/muster-code-tunnel" 2>/dev/null || true

echo "▸ installing the built-in Muster layer + theme"
pnpm --filter @muster-code/builtin build >/dev/null
pnpm --filter @muster-code/theme build >/dev/null
rm -rf "$RES/extensions/muster.muster-code" "$RES/extensions/muster.theme-muster"
cp -R "$ROOT/packages/builtin/dist-ext" "$RES/extensions/muster.muster-code"
cp -R "$ROOT/packages/theme/dist-ext" "$RES/extensions/muster.theme-muster"

echo "▸ patching the workbench"
python3 "$ROOT/scripts/patch-workbench.py" "$RES/out/vs/workbench/workbench.desktop.main.js" "$ROOT/product/muster-inline-diff.js" "$RES/product.json" "$ROOT/product/muster-browser-main.js"

echo "▸ applying the workbench skin"
cat "$ROOT/product/muster-workbench.css" >> "$RES/out/vs/workbench/workbench.desktop.main.css"

echo "▸ signing (ad-hoc, local use)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

echo "✓ $APP"
echo "  run: open \"$APP\"   (dev: \"$APP/Contents/MacOS/Muster Code\" --user-data-dir /tmp/mc-udd)"
