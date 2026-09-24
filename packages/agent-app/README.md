# @muster/agent-app

Standalone Muster Code agent desktop app. Plain Electron — no Code-OSS, no
VS Code extension host.

## Download Muster Agent

1. Open the [Muster Agent releases](https://github.com/musterhq/muster-code/releases?q=agent-v) and pick the
   newest `Muster Agent <version>` (while the repository is private you need a GitHub account with access).
2. Download the file for your Mac (Apple menu > About This Mac shows the chip):
   - Apple silicon (M1 and later): `Muster-Agent-<version>-arm64.dmg`
   - Intel: `Muster-Agent-<version>-x64.dmg`

   A `.zip` of the same app is attached too, and `SHA256SUMS` lets you check the download
   (`shasum -a 256 -c SHA256SUMS --ignore-missing`).
3. Open the disk image and drag **Muster Agent** onto **Applications**.
4. First open. Builds are signed with the self-signed "Muster Agent Self-Signed" identity: the identity
   stays the same from one release to the next, so macOS keeps the permissions you grant (Screen
   Recording, Accessibility) across updates, but the app is not notarized by Apple. macOS therefore
   blocks the first launch: right-click **Muster Agent** in Applications and choose **Open**, then
   **Open** again (on recent macOS: System Settings > Privacy & Security > **Open Anyway**). Or clear
   the quarantine flag once in Terminal:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Muster Agent.app"
   ```

What it needs: macOS 14 (Sonoma) or later and a model provider sign-in. On first run Muster Agent
detects the providers already signed in on your Mac (Codex, Claude Code, OpenCode, or a configured
gateway) and uses them; if it finds none, guided setup walks you through adding one. Docker Desktop
(sandboxes) is optional.

## Build and run Muster Agent from source

A fresh clone builds and runs with no sibling checkouts and no environment variables: the few
Muster core sources the app bundles are vendored in `packages/agent-app/vendor/` (see its README).

### Prerequisites

- macOS 14 (Sonoma) or later. Apple silicon and Intel both work: npm installs the matching Electron
  build and node-pty is compiled for the local architecture.
- Node.js 24 (pinned in `packages/agent-app/.nvmrc` and `.node-version`, so `nvm use`, `fnm use` or
  `mise` pick it up), with the npm that ships with it.
- git.
- Xcode Command Line Tools (`xcode-select --install`), used to compile node-pty for the integrated
  terminal. Without them the install still succeeds and falls back to node-pty's prebuilt binary.
- GitHub access to `musterhq/muster-code`. The repository is private, so the other Mac must be signed
  in to an account with access (`gh auth login`, an SSH key, or a credential helper) before cloning.

### One command

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code \
  && git checkout claude/muster-agent-completion-20260924 \
  && cd packages/agent-app && npm ci && npm start
```

Or let the helper check prerequisites first (macOS, Node 24 with an nvm/fnm/mise switch if one is
installed, git, Xcode tools), then run `npm ci` and `npm start`:

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code \
  && git checkout claude/muster-agent-completion-20260924 \
  && ./packages/agent-app/scripts/run-mac.sh
```

`npm ci` installs the exact locked dependencies, downloads Electron (about 100 MB), and its
`postinstall` step rebuilds node-pty for Electron. After that, `npm start` builds `dist/` and opens
the app; later runs only need `npm start` from `packages/agent-app`.

### First launch

Muster Agent looks for providers you are already signed in to on that Mac (Codex, Claude Code,
OpenCode, or a configured gateway) and uses them directly. If it finds none, it opens guided setup
to sign in or add one. Settings and chats live in `~/Library/Application Support/Muster Agent`;
pass `--user-data-dir=/some/dir` (for example `npx electron . --user-data-dir=/tmp/muster-test`) to
run an isolated profile.

### Optional capabilities

- Sandboxes: install and start Docker Desktop. Without it, sandboxed runs are unavailable and the
  rest of the app works normally.
- Computer use: grant Screen Recording and Accessibility in System Settings > Privacy & Security
  when macOS prompts (for a dev run the permission is attributed to Electron or your terminal).

### Build a local .app

```sh
cd packages/agent-app
npm run build && node scripts/package-preview.mjs   # -> release/Muster Agent Preview.app (dev preview)
node scripts/package-release.mjs                    # -> release-dist/Muster Agent.app, Muster-Agent-<version>-<arch>.zip/.dmg, SHA256SUMS
```

`package-release.mjs` makes the distributable build for this Mac's architecture: a clean production
build, the bundle renamed to Muster Agent (`dev.themuster.agent`, version from `package.json`, app
icon from `resources/icon.icns`), only built files inside, then the zip, disk image and checksums.
Releases are published by `.github/workflows/agent-app-release.yml` when an `agent-v<version>` tag is
pushed; see `docs/RELEASE.md`.

Without `MUSTER_SIGN_IDENTITY` the bundle is ad hoc signed, so Gatekeeper blocks a copy moved to
another Mac: right-click the app and choose Open the first time, or clear the quarantine flag with
`xattr -dr com.apple.quarantine "Muster Agent Preview.app"`. Developer ID signing and notarization
are covered in `packages/agent-app/docs/RELEASE.md`.

### Troubleshooting

- Wrong Node version (`EBADENGINE` warning, or build errors): run `nvm use` / `fnm use` in
  `packages/agent-app`, or install Node 24, then `rm -rf node_modules && npm ci`.
- The terminal pane fails to start, or `postinstall` printed a node-pty warning: install Xcode
  Command Line Tools, then `npm run rebuild:native`. Set `MUSTER_SKIP_NATIVE_REBUILD=1` to skip the
  rebuild during `npm ci` (for example on CI).
- Electron download failed during install: re-run `npm ci`, or just `npm start` (Electron retries the
  download on first launch).
- Contributors with their own Muster core checkouts can override the vendored sources with
  `MUSTER_CORE_CLIENT_ENTRY`, `MUSTER_RUNTIME_SOURCE_ROOT` and `MUSTER_SANDBOX_SOURCE_ROOT`; the
  build log prints which source each bundle used. `npm run vendor:sync` refreshes `vendor/` from them.

## Layout

- `src/main/` — Electron main process: window lifecycle, native menu,
  geometry persistence, IPC bridge, agent-service loader.
- `src/preload/` — minimal typed bridge exposing `window.muster`
  (`invoke(command, input)` + `subscribe(listener)` with cleanup).
- `src/shared/protocol.ts` — command/event contract (parent-owned; request
  changes upstream, do not edit here).
- `src/renderer/` — React renderer entry (`main.tsx`, `index.html`),
  owned by the frontend worktree.
- `src/runtime/service.ts` — agent runtime worker
  (`createAgentService({ dataDir, onEvent })`), owned by the runtime
  worktree. Main falls back to a stub service that rejects commands with a
  clear error when the runtime is absent from this worktree.
- `scripts/build.mjs` — esbuild bundling for main/preload/renderer and the
  Muster core bundles (env var override, else `vendor/`).
- `vendor/` — vendored Muster core sources with provenance
  (`vendor/README.md`, `vendor/SOURCES.json`); refreshed by
  `scripts/vendor-sync.mjs`.
- `scripts/postinstall.mjs` — fetches Electron and rebuilds node-pty for it.
- `scripts/run-mac.sh` — prerequisite check + `npm ci` + `npm start`.
- `tests/` — `node --test` unit tests (window geometry clamp, command
  guard).

## Commands

```sh
npm ci               # exact locked deps; postinstall rebuilds node-pty for Electron
npm run build        # bundle main + preload (+ renderer when present)
npm start            # build then launch Electron
npm run dev          # rebuild on change
npm run typecheck    # tsc --noEmit
npm test             # node --test 'tests/*.test.ts'
npm run rebuild:native  # rebuild node-pty for Electron (needs Xcode CLT)
npm run vendor:sync  # refresh vendor/ from MUSTER_* checkouts
npm run package      # release build: release-dist/Muster-Agent-<version>-<arch>.zip/.dmg + SHA256SUMS
```

## Security model

- `BrowserWindow` with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`.
- IPC handlers validate sender frame/webContents and reject unknown command
  names; arbitrary method invocation is refused.
- `setWindowOpenHandler` denies popups; navigation outside the app bundle
  is blocked. External URLs open only through explicit allowlisted menu
  actions.

## Windowing (macOS)

Sidebar vibrancy (`vibrancy: 'sidebar'`) with opaque content panes,
`hiddenInset` title bar with drag regions, and an opaque fallback when the
OS prefers reduced transparency (`nativeTheme.prefersReducedTransparency`).
Window geometry is persisted to `userData/window-state.json`, clamped to
visible displays on restore. Second launch focuses the existing instance.

App quit disposes the agent service explicitly so long-running work is not
silently cancelled; in-progress runs prompt before quitting.
