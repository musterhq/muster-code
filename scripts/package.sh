#!/bin/zsh
# Package "Muster Code.app" for distribution: assemble → sign (Developer ID, hardened runtime) → zip →
# notarize + staple → DMG. Unsigned when no identity is given (local/testing builds only).
#
#   scripts/package.sh                       # unsigned: dist/Muster Code-<version>-arm64.{zip,dmg}
#   MUSTER_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   MUSTER_NOTARY_PROFILE=muster-notary scripts/package.sh      # signed + notarized + stapled
#
# One-time notarization credentials (stored in the keychain, never in the repo):
#   xcrun notarytool store-credentials muster-notary --apple-id you@example.com --team-id TEAMID --password <app-specific password>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"; APP="$DIST/Muster Code.app"
IDENTITY="${MUSTER_SIGN_IDENTITY:-}"; PROFILE="${MUSTER_NOTARY_PROFILE:-}"
[[ "${SKIP_ASSEMBLE:-}" == "1" ]] || zsh "$ROOT/scripts/assemble.sh"
VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")"
ARCH="$(uname -m)"; BASE="Muster Code-$VERSION-$ARCH"
rm -f "$DIST/$BASE.zip" "$DIST/$BASE.dmg"

if [[ -n "$IDENTITY" ]]; then
  echo "▸ signing with $IDENTITY (hardened runtime)"
  ENT="$ROOT/product/entitlements.plist"
  # Inside-out: helpers and frameworks first, the app last. --deep is not reliable for Electron bundles.
  find "$APP/Contents/Frameworks" -type d \( -name "*.app" -o -name "*.framework" -o -name "*.xpc" \) -depth | while read -r item; do
    codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$IDENTITY" "$item"
  done
  find "$APP/Contents" -type f \( -name "*.dylib" -o -name "*.node" -o -perm -u+x \) ! -path "*/Frameworks/*.app/*" ! -path "*.framework/*" -print0 | xargs -0 -I{} codesign --force --options runtime --timestamp --sign "$IDENTITY" "{}" 2>/dev/null || true
  codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  spctl --assess --type execute --verbose=2 "$APP" || echo "  (spctl assessment fails until notarized)"
else
  echo "▸ no MUSTER_SIGN_IDENTITY: leaving the ad-hoc signature (Gatekeeper will block this on other Macs)"
fi

echo "▸ zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/$BASE.zip"

if [[ -n "$IDENTITY" && -n "$PROFILE" ]]; then
  echo "▸ notarizing (this takes a few minutes)"
  xcrun notarytool submit "$DIST/$BASE.zip" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$DIST/$BASE.zip"; ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/$BASE.zip"
fi

echo "▸ dmg"
STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Muster Code" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DIST/$BASE.dmg"
rm -rf "$STAGE"
[[ -n "$IDENTITY" ]] && codesign --force --timestamp --sign "$IDENTITY" "$DIST/$BASE.dmg"
[[ -n "$IDENTITY" && -n "$PROFILE" ]] && { xcrun notarytool submit "$DIST/$BASE.dmg" --keychain-profile "$PROFILE" --wait; xcrun stapler staple "$DIST/$BASE.dmg"; }
ls -lh "$DIST/$BASE.zip" "$DIST/$BASE.dmg" | awk '{print "  " $5 "\t" $9 " " $10 " " $11}'
echo "✓ $BASE"
