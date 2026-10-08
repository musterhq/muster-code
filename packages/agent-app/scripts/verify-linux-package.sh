#!/usr/bin/env bash
# Checks the Linux artifacts in release-dist/ for what a desktop needs: the .desktop entry (name, icon, WM class, URL
# scheme), the sandbox-aware launcher, the deb's AppArmor profile and dependencies, and the tar.gz layout.
set -euo pipefail
cd "$(dirname "$0")/../release-dist"
fail() { echo "PACKAGE CHECK FAIL: $*" >&2; exit 1; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

deb=$(ls Muster-Agent-*-linux-amd64.deb) || fail "no .deb"
dpkg-deb -x "$deb" "$work/deb"; dpkg-deb -I "$deb" > "$work/deb-info"
desktop="$work/deb/usr/share/applications/muster-agent.desktop"
[ -f "$desktop" ] || fail "deb has no muster-agent.desktop"
cat "$desktop"
grep -qx 'Name=Muster Agent' "$desktop" || fail "desktop Name"
grep -qx 'Icon=muster-agent' "$desktop" || fail "desktop Icon"
grep -qx 'StartupWMClass=muster-agent' "$desktop" || fail "StartupWMClass must match Electron's desktopName (muster-agent)"
grep -q '^MimeType=.*x-scheme-handler/muster;' "$desktop" || fail "desktop MimeType lacks x-scheme-handler/muster"
grep -q '^Categories=.*Development' "$desktop" || fail "desktop Categories"
grep -q '^Exec=.*muster-agent.* %U' "$desktop" || fail "desktop Exec"
! grep -q -- '--no-sandbox' "$desktop" || fail "deb Exec must not hard-code --no-sandbox"
for size in 16 24 32 48 64 128 256 512; do [ -f "$work/deb/usr/share/icons/hicolor/${size}x${size}/apps/muster-agent.png" ] || fail "deb has no ${size}x${size} icon"; done
[ -f "$work/deb/opt/Muster Agent/resources/app.asar" ] || fail "deb lacks resources/app.asar"
[ ! -d "$work/deb/opt/Muster Agent/resources/app" ] || fail "deb still ships loose resources/app"
[ -x "$work/deb/opt/Muster Agent/resources/app.asar.unpacked/dist/runtime/resources/codex-launch.sh" ] || fail "deb lacks the unpacked Codex launcher"
head -1 "$work/deb/opt/Muster Agent/muster-agent" | grep -q '^#!/bin/sh' || fail "deb launcher is not the sandbox-aware wrapper"
[ -x "$work/deb/opt/Muster Agent/muster-agent.bin" ] || fail "deb lacks muster-agent.bin"
[ -f "$work/deb/opt/Muster Agent/resources/apparmor-profile" ] || fail "deb lacks the AppArmor profile"
for dep in libsecret-1-0 libnss3 libgtk-3-0 xdg-utils; do grep -q "$dep" "$work/deb-info" || fail "deb Depends lacks $dep"; done

tgz=$(ls Muster-Agent-*-linux-x64.tar.gz) || fail "no .tar.gz"
tar -tzf "$tgz" > "$work/tar-list"
grep -Eq '(^|/)muster-agent$' "$work/tar-list" || fail "tar.gz lacks muster-agent"
grep -Eq '(^|/)muster-agent\.bin$' "$work/tar-list" || fail "tar.gz lacks muster-agent.bin"
grep -Eq '(^|/)chrome-sandbox$' "$work/tar-list" || fail "tar.gz lacks chrome-sandbox"

appimage=$(ls Muster-Agent-*-linux-x86_64.AppImage) || fail "no AppImage"
# Type 2 static runtime: nothing to load from the system, so no libfuse2 (absent on Ubuntu 24.04).
! readelf -d "$appimage" 2>/dev/null | grep -q 'libfuse' || fail "the AppImage runtime links libfuse"
[ -x "$appimage" ] || chmod +x "$appimage"
(cd "$work" && APPIMAGE_EXTRACT_AND_RUN=1 "$OLDPWD/$appimage" --appimage-extract '*.desktop' > /dev/null)
ad=$(ls "$work"/squashfs-root/*.desktop) || fail "AppImage has no .desktop"
cat "$ad"
grep -q '^StartupWMClass=muster-agent$' "$ad" || fail "AppImage StartupWMClass"
! grep -q -- '--no-sandbox' "$ad" || fail "AppImage Exec must not hard-code --no-sandbox"
echo "PACKAGE CHECK OK"
