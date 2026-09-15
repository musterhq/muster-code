#!/bin/sh
set -eu
unset NODE_TEST_CONTEXT

# Profiles stay in the owner's ~/.codex directory. This launcher deliberately
# never reads, copies, or logs their contents or credentials.
exec "${MUSTER_PROVIDER_NODE:-node}" "$(dirname "$0")/codex-profile.cjs" hybrow-gateway "$@"
