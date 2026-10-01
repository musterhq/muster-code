# Muster Server image. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t muster-server .
# Data (database, secret key, runtime state) lives in /data; mount a volume there and back it up.
FROM node:24-bookworm-slim AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 MUSTER_SKIP_NATIVE_REBUILD=1 NODE_OPTIONS=--max-old-space-size=4096
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY packages/agent-app/package.json packages/agent-app/package-lock.json packages/agent-app/.nvmrc packages/agent-app/
COPY packages/agent-app/scripts packages/agent-app/scripts
RUN cd packages/agent-app && npm ci --no-audit --no-fund
COPY packages/server/package.json packages/server/package-lock.json packages/server/
RUN cd packages/server && npm ci --no-audit --no-fund
COPY packages/agent-app packages/agent-app
COPY packages/server packages/server
RUN cd packages/agent-app && npm run build && cd ../server && npm run build

FROM node:24-bookworm-slim
# git: the agent runtime reads repositories (review baselines, diffs). tini: clean signal handling for the server process.
RUN apt-get update && apt-get install -y --no-install-recommends git tini ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 muster && mkdir -p /data && chown muster:muster /data
COPY --from=build /src/packages/server/dist /opt/muster-server/dist
COPY --from=build /src/packages/server/bin /opt/muster-server/bin
COPY packages/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /opt/muster-server/bin/muster-server && ln -s /opt/muster-server/bin/muster-server /usr/local/bin/muster-server
USER muster
ENV MUSTER_SERVER_DATA_DIR=/data HOME=/home/muster
VOLUME ["/data"]
EXPOSE 7470
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:7470/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["start"]
