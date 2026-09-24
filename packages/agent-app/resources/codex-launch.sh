#!/bin/sh
set -eu
unset NODE_TEST_CONTEXT

# Generic Codex route: MUSTER_CODEX_PROFILE names <CODEX_HOME>/<profile>.config.toml, or
# MUSTER_CODEX_PROVIDER names a [model_providers.<id>] table in the user's own config.toml.
# Profiles stay in the owner's Codex home. This launcher never reads, copies, or logs
# credentials. MUSTER_PROVIDER_NODE may be Electron itself (with ELECTRON_RUN_AS_NODE=1).
exec "${MUSTER_PROVIDER_NODE:-node}" "$(dirname "$0")/codex-profile.cjs" "$@"
