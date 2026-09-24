# Vendored Muster core sources

`scripts/build.mjs` bundles a few TypeScript modules from the Muster core (github.com/Dkm0315/muster,
MIT licensed, see each directory's `LICENSE` and `licenses/muster-core-MIT.txt`). They are vendored
here so a fresh clone builds with `npm ci && npm start`: no sibling checkouts, no env vars.

Resolution order in `scripts/build.mjs`, per group: the env var if it is set, otherwise `vendor/<group>`.
The layout under each group mirrors the source checkout (`packages/core/src/...`), so relative imports
are unchanged and a group directory is a drop-in for the checkout root.

Do not edit these files by hand. Fix them upstream, then refresh the snapshot:

```sh
MUSTER_CORE_CLIENT_ENTRY=/path/to/core/packages/core/src/codex-app-server.ts \
MUSTER_RUNTIME_SOURCE_ROOT=/path/to/muster \
MUSTER_SANDBOX_SOURCE_ROOT=/path/to/scoped-checkout \
npm run vendor:sync
```

Only groups whose env var is set are refreshed. The file list is computed by esbuild from each entry's
transitive imports. Exact hashes are in `SOURCES.json`.

| Directory | Override env var | Origin | Synced | Files |
| --- | --- | --- | --- | --- |
| `vendor/muster-core` | `MUSTER_CORE_CLIENT_ENTRY` | local checkout, not a git repository (`/private/tmp/muster-core-pr97-integration-20260922`) | 2026-09-24 | `packages/core/src/codex-app-server.ts` |
| `vendor/muster-runtime` | `MUSTER_RUNTIME_SOURCE_ROOT` | https://github.com/Dkm0315/muster.git<br>branch `cursor/hindsight-scheduler-foundation`<br>commit `9a567c908d429cd887a83f961febe1078ceabd8f` | 2026-09-24 | `packages/core/src/config.ts`<br>`packages/core/src/hindsight.ts`<br>`packages/core/src/memory.ts`<br>`packages/core/src/profiles.ts`<br>`packages/core/src/providers-catalog.ts`<br>`packages/core/src/store.ts` |
| `vendor/muster-sandbox` | `MUSTER_SANDBOX_SOURCE_ROOT` | https://github.com/Dkm0315/muster.git<br>branch `(detached HEAD)`<br>commit `215b8d3ec53b3762b8fe53f67af15f4c5b31f998`<br>**plus uncommitted changes:** `packages/core/src/local-docker-sandbox.ts`, `packages/core/src/scoped-runtime.ts` | 2026-09-24 | `packages/core/src/agent-graph.ts`<br>`packages/core/src/config.ts`<br>`packages/core/src/local-docker-sandbox.ts`<br>`packages/core/src/memory.ts`<br>`packages/core/src/profiles.ts`<br>`packages/core/src/providers-catalog.ts`<br>`packages/core/src/scoped-runtime.ts`<br>`packages/core/src/store.ts` |

Group purposes:

- `muster-core`: Lifecycle-aware Codex app-server client (CODEX_RUN_LIFECYCLE_VERSION=1, steerActiveCodexTurn) -> dist/runtime/core-client.cjs
- `muster-runtime`: Memory and Hindsight stores -> dist/runtime/core-memory.cjs, core-hindsight.cjs
- `muster-sandbox`: Local Docker sandbox and scoped runtime -> dist/runtime/scoped-computer-core.cjs
