#!/usr/bin/env bash
# Checks an installed Muster Agent .deb the way a desktop sees it (#317): package state, desktop entry and its muster://
# handler registration, every hicolor icon, chrome-sandbox permissions that match the kernel, the app.asar layout and
# what the postinst set up. Run after `apt-get install ./Muster-Agent-*.deb`; `--remove` then removes it and checks
# that nothing is left behind.
#   sudo-capable shell: bash scripts/test-linux-install.sh [--remove]
set -euo pipefail
fail() { echo "INSTALL CHECK FAIL: $*" >&2; exit 1; }
sudo_() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
opt="/opt/Muster Agent"
desktop=/usr/share/applications/muster-agent.desktop

if [ "${1:-}" = --remove ]; then
  sudo_ apt-get remove -y muster-agent
  [ ! -e "$opt/muster-agent" ] || fail "$opt is still there after apt-get remove"
  [ ! -e "$desktop" ] || fail "the desktop entry is still there"
  [ ! -e /usr/bin/muster-agent ] || fail "/usr/bin/muster-agent is still there"
  ! grep -qs 'muster-agent.desktop' /usr/share/applications/mimeinfo.cache || fail "mimeinfo.cache still names muster-agent.desktop"
  echo "REMOVE CHECK OK"; exit 0
fi

dpkg -s muster-agent | grep -q '^Status: install ok installed' || fail "dpkg does not list muster-agent as installed"
[ -f /var/lib/dpkg/info/muster-agent.list ] || fail "no dpkg record (the updater uses it to recognise a deb install)"
[ "$(readlink -f /usr/bin/muster-agent)" = "$opt/muster-agent" ] || fail "/usr/bin/muster-agent does not lead to $opt/muster-agent"

[ -f "$desktop" ] || fail "no $desktop"
grep -q '^MimeType=.*x-scheme-handler/muster;' "$desktop" || fail "desktop entry lacks x-scheme-handler/muster"
if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$desktop" || fail "desktop-file-validate"; fi
# postinst ran update-desktop-database: the scheme resolves to our entry without any user action.
grep -q '^x-scheme-handler/muster=.*muster-agent.desktop' /usr/share/applications/mimeinfo.cache || fail "mimeinfo.cache does not map x-scheme-handler/muster"
if command -v xdg-mime >/dev/null; then echo "xdg-mime default for muster://: $(XDG_CURRENT_DESKTOP= xdg-mime query default x-scheme-handler/muster || true)"; fi

for size in 16 24 32 48 64 128 256 512; do
  [ -f "/usr/share/icons/hicolor/${size}x${size}/apps/muster-agent.png" ] || fail "no ${size}x${size} icon"
done

sandbox="$opt/chrome-sandbox"
[ "$(stat -c %U "$sandbox")" = root ] || fail "chrome-sandbox is not owned by root"
mode=$(stat -c %a "$sandbox")
# postinst (as root): setuid only where the kernel has no working user namespaces. Same probe, also as root.
if [ -L /proc/self/ns/user ] && sudo_ unshare --user true 2>/dev/null; then want=755; else want=4755; fi
[ "$mode" = "$want" ] || fail "chrome-sandbox mode $mode, expected $want for this kernel"
echo "chrome-sandbox: $mode (user namespaces $([ "$want" = 755 ] && echo usable || echo unavailable))"

[ -f "$opt/resources/app.asar" ] || fail "no resources/app.asar"
[ ! -d "$opt/resources/app" ] || fail "resources/app still holds loose files"
u="$opt/resources/app.asar.unpacked"
find "$u/node_modules/node-pty" -name pty.node 2>/dev/null | grep -q . || fail "node-pty's native addon is not unpacked"
[ -x "$u/dist/runtime/resources/codex-launch.sh" ] || fail "the Codex launcher is not an unpacked executable"
[ -f "$u/dist/main/browser-mcp.cjs" ] || fail "browser-mcp.cjs is not unpacked"
echo "installed files: $(find "$opt" -type f | wc -l)"
if command -v apparmor_status >/dev/null && apparmor_status --enabled 2>/dev/null; then [ -f /etc/apparmor.d/muster-agent ] || fail "AppArmor is on but the profile was not installed"; fi
echo "INSTALL CHECK OK"
