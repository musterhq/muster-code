#!/bin/zsh
# Launch a disposable copy of a staged Muster Code app without rewriting it.
# This script never edits or terminates the source/installed app and refuses to
# overwrite an existing QA bundle. It is intentionally macOS-only.
set -euo pipefail
SCRIPT_NAME="$0"

usage() {
  echo "Usage: $SCRIPT_NAME <staged-app.app> <disposable-workspace> <qa-user-data-dir> [qa-app.app]" >&2
  echo "Example: $SCRIPT_NAME 'dist/verified/Muster Code.app' /tmp/muster-qa-workspace /tmp/muster-qa-profile '/tmp/Muster Code QA.app'" >&2
  exit 2
}

[[ $# -ge 3 && $# -le 4 ]] || usage
SOURCE_APP="${1:A}"
QA_WORKSPACE="${2:a}"
QA_PROFILE="${3:a}"
if [[ $# -eq 4 ]]; then QA_APP="${4:a}"; else QA_APP="${SOURCE_APP:h}/Muster Code QA.app"; fi

[[ "${SOURCE_APP:t}" == *.app ]] || { echo "Source must be an app bundle: $SOURCE_APP" >&2; exit 2; }
[[ -d "$SOURCE_APP/Contents/MacOS" && -x "$SOURCE_APP/Contents/MacOS/Muster Code" ]] || { echo "Source app is not a staged Muster Code bundle: $SOURCE_APP" >&2; exit 2; }
[[ -d "$QA_WORKSPACE" ]] || { echo "Disposable workspace must already exist: $QA_WORKSPACE" >&2; exit 2; }
[[ "$QA_WORKSPACE" != "/" && "$QA_PROFILE" != "/" ]] || { echo "Refusing workspace/profile root paths." >&2; exit 2; }
[[ "$QA_APP" != "$SOURCE_APP" ]] || { echo "QA destination must differ from source app." >&2; exit 2; }
[[ ! -e "$QA_APP" ]] || { echo "Refusing to overwrite existing QA app: $QA_APP" >&2; exit 2; }

# Use physical paths only for safety comparisons. The original absolute
# workspace spelling above is passed to the CLI so provider cwd identity stays
# aligned with the operator's explicit QA workspace path.
canonical_existing() { if [[ -e "$1" ]]; then realpath "$1"; else print -r -- "$1"; fi }
CANONICAL_WORKSPACE="$(canonical_existing "$QA_WORKSPACE")"
CANONICAL_PROFILE="$(canonical_existing "$QA_PROFILE")"
[[ "$CANONICAL_WORKSPACE" != "/" && "$CANONICAL_PROFILE" != "/" ]] || { echo "Refusing workspace/profile paths that resolve to root." >&2; exit 2; }
[[ ! -e "$QA_PROFILE" ]] || { echo "Refusing to reuse an existing QA profile: $QA_PROFILE" >&2; exit 2; }

command -v ditto >/dev/null || { echo "ditto is required." >&2; exit 2; }
command -v codesign >/dev/null || { echo "codesign is required." >&2; exit 2; }
command -v cmp >/dev/null || { echo "cmp is required." >&2; exit 2; }

echo "▸ copying staged app to $QA_APP"
mkdir -p "${QA_APP:h}"
ditto "$SOURCE_APP" "$QA_APP"

# Keep the staged app's product/bundle identity and signatures intact. This
# checkpoint prevents launcher changes from silently changing singleton
# behavior or invalidating nested Electron signatures.
assert_identical() {
  local rel="$1"
  [[ -f "$SOURCE_APP/$rel" && -f "$QA_APP/$rel" ]] || { echo "missing copied checkpoint: $rel" >&2; exit 1; }
  cmp -s "$SOURCE_APP/$rel" "$QA_APP/$rel" || { echo "copied checkpoint differs: $rel" >&2; exit 1; }
}
for REL in \
  Contents/Info.plist \
  Contents/Resources/app/product.json \
  Contents/Resources/app/bin/muster-code \
  Contents/MacOS/Muster\ Code \
  Contents/_CodeSignature/CodeResources \
  Contents/CodeResources; do
  assert_identical "$REL"
done
for HELPER in "$SOURCE_APP"/Contents/Frameworks/Muster\ Code\ Helper*.app; do
  [[ -d "$HELPER" ]] || continue
  HELPER_REL="${HELPER#$SOURCE_APP/}"
  HELPER_NAME="${HELPER:t}"
  HELPER_NAME="${HELPER_NAME%.app}"
  assert_identical "$HELPER_REL/Contents/Info.plist"
  assert_identical "$HELPER_REL/Contents/MacOS/$HELPER_NAME"
  assert_identical "$HELPER_REL/Contents/_CodeSignature/CodeResources"
done
codesign --verify --deep --strict "$QA_APP" >/dev/null 2>&1 || { echo "copied QA app failed signature verification" >&2; exit 1; }

CLI="$QA_APP/Contents/Resources/app/bin/muster-code"
[[ -x "$CLI" ]] || { echo "QA app has no real CLI launcher: $CLI" >&2; exit 1; }
if [[ "${MUSTER_QA_VALIDATE_ONLY:-0}" == "1" ]]; then
  echo "✓ copied QA checkpoints validated; not launching (MUSTER_QA_VALIDATE_ONLY=1)"
  exit 0
fi
mkdir -p "$QA_PROFILE"

echo "✓ QA bundle: $QA_APP"
echo "  bundle identity: preserved from staged app"
echo "  profile:   $QA_PROFILE"
echo "  workspace: $QA_WORKSPACE"
echo "  launching via: $CLI"
# --new-window and the fresh profile/workspace keep this disposable invocation
# scoped to its explicit paths while preserving the provider's product identity.
exec "$CLI" --new-window --user-data-dir "$QA_PROFILE" "$QA_WORKSPACE"
