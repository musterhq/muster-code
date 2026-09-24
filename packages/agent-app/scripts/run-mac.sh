#!/usr/bin/env bash
# Build and launch Muster Agent from a fresh clone on macOS.
#   ./packages/agent-app/scripts/run-mac.sh            # from the repo root, or
#   ./scripts/run-mac.sh                               # from packages/agent-app
# Checks prerequisites, installs exact dependencies (npm ci), builds, and starts the app.
# Set MUSTER_SKIP_INSTALL=1 to reuse an existing node_modules.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED_NODE_MAJOR="$(tr -dc '0-9' < "$APP_DIR/.nvmrc")"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# 1. macOS
[[ "$(uname -s)" == "Darwin" ]] || fail "Muster Agent's desktop app is macOS-only (found $(uname -s))."
macos_major="$(sw_vers -productVersion | cut -d. -f1)"
if (( macos_major < 14 )); then
  printf 'Warning: macOS %s detected; Muster Agent is tested on macOS 14 (Sonoma) and later.\n' "$(sw_vers -productVersion)"
fi
say "macOS $(sw_vers -productVersion) on $(uname -m)"

# 2. git
command -v git >/dev/null 2>&1 || fail "git is not installed. Run: xcode-select --install"

# 3. Node.js 24 (try to switch automatically with a version manager if the active one is wrong)
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [[ "$(node_major)" != "$REQUIRED_NODE_MAJOR" ]]; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    say "Switching to Node $REQUIRED_NODE_MAJOR with nvm"
    set +u  # nvm.sh is not nounset-safe
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    { nvm install "$REQUIRED_NODE_MAJOR" && nvm use "$REQUIRED_NODE_MAJOR"; } >/dev/null 2>&1 || true
    set -u
  elif command -v fnm >/dev/null 2>&1; then
    say "Switching to Node $REQUIRED_NODE_MAJOR with fnm"
    eval "$(fnm env)"; fnm use --install-if-missing "$REQUIRED_NODE_MAJOR" >/dev/null || true
  elif command -v mise >/dev/null 2>&1; then
    say "Switching to Node $REQUIRED_NODE_MAJOR with mise"
    mise install "node@$REQUIRED_NODE_MAJOR" >/dev/null && eval "$(mise env -s bash "node@$REQUIRED_NODE_MAJOR")" || true
  fi
fi
if [[ "$(node_major)" != "$REQUIRED_NODE_MAJOR" ]]; then
  found="$(command -v node >/dev/null 2>&1 && node -v || echo 'none')"
  fail "Node.js $REQUIRED_NODE_MAJOR.x is required (found: $found). Install it with one of:
    nvm:      nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR
    fnm:      fnm install $REQUIRED_NODE_MAJOR && fnm use $REQUIRED_NODE_MAJOR
    mise:     mise use -g node@$REQUIRED_NODE_MAJOR
    Homebrew: brew install node@$REQUIRED_NODE_MAJOR && brew link --overwrite node@$REQUIRED_NODE_MAJOR
  then re-run this script."
fi
say "Node $(node -v), npm $(npm -v)"

# 4. Xcode Command Line Tools (only needed to rebuild node-pty; prebuilt binaries are the fallback)
if ! xcode-select -p >/dev/null 2>&1; then
  printf 'Warning: Xcode Command Line Tools not found. The terminal falls back to node-pty'"'"'s prebuilt binary.\n'
  printf '         For a native rebuild run: xcode-select --install && npm run rebuild:native\n'
fi

cd "$APP_DIR"

# 5. Dependencies
if [[ -n "${MUSTER_SKIP_INSTALL:-}" && -d node_modules ]]; then
  say "MUSTER_SKIP_INSTALL set; reusing node_modules"
else
  say "Installing dependencies (npm ci; first run downloads Electron, about 100 MB)"
  npm ci
fi

# 6. Build and launch
say "Building and starting Muster Agent"
exec npm start
