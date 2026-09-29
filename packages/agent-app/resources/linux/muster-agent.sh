#!/bin/sh
# Muster Agent launcher (Linux). afterPack renames Electron's binary to muster-agent.bin and installs this in its place,
# so the deb, the AppImage and the tar.gz all start through it.
#
# Chromium's sandbox needs either a root-owned setuid chrome-sandbox or unprivileged user namespaces. An AppImage or an
# unpacked tarball cannot be setuid, and Ubuntu 23.10+ (AppArmor) and some hardened kernels block user namespaces, so
# Electron aborts with "The SUID sandbox helper binary was found, but is not configured correctly". Only in that case
# this adds --no-sandbox (with a notice on stderr); otherwise the sandbox stays on.
#   MUSTER_NO_SANDBOX=1  always add --no-sandbox        MUSTER_NO_SANDBOX=0  never add it
# MUSTER_PROC_ROOT, MUSTER_APPARMOR_DIR, MUSTER_PROFILE_TARGET and MUSTER_UNSHARE exist for tests.
self=$(readlink -f "$0" 2>/dev/null || echo "$0")
dir=$(dirname "$self")
bin="$dir/muster-agent.bin"
proc=${MUSTER_PROC_ROOT:-/proc}
apparmor=${MUSTER_APPARMOR_DIR:-/etc/apparmor.d}
# The path the deb's AppArmor profile attaches to.
profile_target=${MUSTER_PROFILE_TARGET:-/opt/Muster Agent/muster-agent}
unshare=${MUSTER_UNSHARE:-unshare}

value() { cat "$1" 2>/dev/null | tr -d '[:space:]'; }

sandbox_usable() {
  # A setuid-root chrome-sandbox (the deb installs it that way where user namespaces are unavailable).
  if [ -u "$dir/chrome-sandbox" ] && [ "$(stat -c %u "$dir/chrome-sandbox" 2>/dev/null)" = 0 ]; then return 0; fi
  # Fast negatives: no unprivileged user namespaces (Debian's switch, a zero limit).
  [ "$(value "$proc/sys/kernel/unprivileged_userns_clone")" = 0 ] && return 1
  [ "$(value "$proc/sys/user/max_user_namespaces")" = 0 ] && return 1
  # AppArmor restriction (Ubuntu 23.10+). The deb's profile attaches only to the installed path, so a profile file alone
  # proves nothing: a tarball or AppImage on a machine that also has the deb is still confined.
  if [ "$(value "$proc/sys/kernel/apparmor_restrict_unprivileged_userns")" = 1 ]; then
    if [ -f "$apparmor/muster-agent" ] && [ "$self" = "$profile_target" ]; then return 0; fi
    return 1
  fi
  # Measure it: the same probe electron-builder's AppRun uses. Catches seccomp (Docker), Flatpak/toolbox, SELinux, exhausted
  # namespace limits. Without unshare the sysctls above are all there is to go on, and unknown means keep the sandbox.
  if command -v "$unshare" >/dev/null 2>&1; then "$unshare" -Ur true >/dev/null 2>&1; return $?; fi
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
