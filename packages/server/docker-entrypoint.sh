#!/bin/sh
# First run: initialize when MUSTER_SERVER_OWNER_PASSWORD (or a mounted file in MUSTER_SERVER_OWNER_PASSWORD_FILE) is provided.
# `start` binds 0.0.0.0 inside the container (the published port decides who can reach it) and needs the names people use.
set -e
if [ "$1" = "start" ]; then
  if [ ! -f "$MUSTER_SERVER_DATA_DIR/server.json" ]; then
    if [ -n "$MUSTER_SERVER_OWNER_PASSWORD_FILE" ]; then MUSTER_SERVER_OWNER_PASSWORD="$(cat "$MUSTER_SERVER_OWNER_PASSWORD_FILE")"; export MUSTER_SERVER_OWNER_PASSWORD; fi
    if [ -z "$MUSTER_SERVER_OWNER_PASSWORD" ]; then
      echo "muster-server: not initialized. Set MUSTER_SERVER_OWNER_PASSWORD (or _FILE) for the first start, or run: docker compose run --rm muster init" >&2
      exit 64
    fi
    muster-server init --username "${MUSTER_SERVER_OWNER:-admin}" --host 0.0.0.0 --allowed-host "${MUSTER_SERVER_ALLOWED_HOSTS:-localhost}" \
      ${MUSTER_SERVER_PUBLIC_URL:+--public-url "$MUSTER_SERVER_PUBLIC_URL"} ${MUSTER_SERVER_TRUST_PROXY:+--trust-proxy}
    unset MUSTER_SERVER_OWNER_PASSWORD
  fi
  shift
  exec muster-server start --host 0.0.0.0 --port 7470 --allowed-host "${MUSTER_SERVER_ALLOWED_HOSTS:-localhost}" \
    ${MUSTER_SERVER_PUBLIC_URL:+--public-url "$MUSTER_SERVER_PUBLIC_URL"} ${MUSTER_SERVER_TRUST_PROXY:+--trust-proxy} "$@"
fi
exec muster-server "$@"
