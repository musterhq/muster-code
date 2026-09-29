#!/bin/sh
# Muster Agent launcher (Linux). afterPack renames Electron's binary to muster-agent.bin and installs this in its place,
# so the deb, the AppImage and the tar.gz all start through it.
#
# Chromium's sandbox needs either a root-owned setuid chrome-sandbox or unprivileged user namespaces. An AppImage or an
# unpacked tarball cannot be setuid, and Ubuntu 23.10+ (AppArmor) and some hardened kernels block user namespaces, so
# Electron aborts with "The SUID sandbox helper binary was found, but is not configured correctly". Only in that case
# this adds --no-sandbox (with a notice on stderr); otherwise the sandbox stays on.
#   MUSTER_NO_SANDBOX=1  always add --no-sandbox        MUSTER_NO_SANDBOX=0  never add it
# MUSTER_PROC_ROOT and MUSTER_APPARMOR_DIR exist for tests.
self=$(readlink -f "$0" 2>/dev/null || echo "$0")
dir=$(dirname "$self")
bin="$dir/muster-agent.bin"
proc=${MUSTER_PROC_ROOT:-/proc}
apparmor=${MUSTER_APPARMOR_DIR:-/etc/apparmor.d}

value() { cat "$1" 2>/dev/null | tr -d '[:space:]'; }

sandbox_usable() {
  # A setuid-root chrome-sandbox (the deb installs it that way where user namespaces are unavailable).
  if [ -u "$dir/chrome-sandbox" ] && [ "$(stat -c %u "$dir/chrome-sandbox" 2>/dev/null)" = 0 ]; then return 0; fi
  # No unprivileged user namespaces: Debian's switch, a zero limit, or AppArmor's restriction (Ubuntu 23.10+).
  # The deb ships an AppArmor profile that grants this app the userns permission.
  [ "$(value "$proc/sys/kernel/unprivileged_userns_clone")" = 0 ] && return 1
  [ "$(value "$proc/sys/user/max_user_namespaces")" = 0 ] && return 1
  if [ "$(value "$proc/sys/kernel/apparmor_restrict_unprivileged_userns")" = 1 ] && [ ! -f "$apparmor/muster-agent" ]; then return 1; fi
  return 0
}

case "${MUSTER_NO_SANDBOX:-}" in
  1) add=1 ;;
  0) add=0 ;;
  *) case " $* " in *" --no-sandbox "*) add=0 ;; *) if sandbox_usable; then add=0; else add=1; fi ;; esac ;;
esac

if [ "$add" = 1 ]; then
  echo "muster-agent: user namespaces are restricted here and chrome-sandbox is not setuid, starting with --no-sandbox. Install the .deb (it adds an AppArmor profile) to keep the sandbox." >&2
  exec "$bin" --no-sandbox "$@"
fi
exec "$bin" "$@"
