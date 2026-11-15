#!/usr/bin/env bash
# #876: install apt packages on a CI Ubuntu machine or container, moving to another mirror when one fails.
# A runner's mirror can stop resolving, serve a package list without a package ("Unable to locate package xvfb") or stall.
# Each attempt points the Ubuntu sources at one mirror, refreshes the lists and installs, with a time limit; a failed
# attempt moves to the next mirror, and the whole list is tried twice. The step fails, with apt's error, only if all do.
#
# Usage: ci-apt-install.sh <package or ./file.deb>...
# Environment (for tests): APT_ETC (default /etc/apt), APT_MIRRORS (space separated), APT_RETRY_PAUSE (seconds),
# APT_SUDO=none (never use sudo).
set -o pipefail
[ $# -gt 0 ] || { echo "usage: $0 <package>..." >&2; exit 2; }
etc="${APT_ETC:-/etc/apt}"
mirrors="${APT_MIRRORS:-http://mirrors.edge.kernel.org/ubuntu/ http://azure.archive.ubuntu.com/ubuntu/ http://archive.ubuntu.com/ubuntu/}"
pause="${APT_RETRY_PAUSE:-10}"
as_root=()
[ "$(id -u)" = 0 ] || [ "${APT_SUDO:-}" = none ] || ! command -v sudo >/dev/null 2>&1 || as_root=(sudo)
limit=()
command -v timeout >/dev/null 2>&1 && limit=(timeout 600)
apt=("${as_root[@]}" "${limit[@]}" env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30)

# Every Ubuntu archive and security source (deb822 and one-line forms, including the runner's mirror+file list) -> $1.
point_at() {
  local mirror="$1" file
  for file in "$etc/sources.list.d/ubuntu.sources" "$etc/sources.list"; do
    [ -f "$file" ] || continue
    "${as_root[@]}" sed -i.bak -E \
      -e "s#^URIs:.*#URIs: ${mirror}#" \
      -e "s#^(deb(-src)?( \[[^]]*\])?) (https?://[^ ]*/ubuntu/?|mirror\+file:[^ ]*) #\1 ${mirror} #" "$file"
    "${as_root[@]}" rm -f "$file.bak"
  done
}

for round in 1 2; do
  for mirror in $mirrors; do
    echo "::group::apt from ${mirror} (round ${round})"
    point_at "$mirror"
    if "${apt[@]}" update && "${apt[@]}" install -y --no-install-recommends "$@"; then echo "::endgroup::"; exit 0; fi
    echo "::endgroup::"
    echo "apt failed with ${mirror}; trying the next mirror" >&2
    sleep "$pause"
  done
done
echo "apt could not install $* from any mirror" >&2
exit 1
