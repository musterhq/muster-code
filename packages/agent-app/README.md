<div align="center">

# Muster Agent

**The agentic development client that remembers.**

Coding agents in your folders, with long-term memory, sandboxed computers and the providers you
already have. Native macOS app, built on Electron.

[![Latest release](https://img.shields.io/github/v/release/musterhq/muster-code?filter=agent-v*&label=release&color=2f6feb)](https://github.com/musterhq/muster-code/releases/latest)
[![macOS 14+ · Apple silicon](https://img.shields.io/badge/macOS-14%2B%20·%20Apple%20silicon-111?logo=apple)](https://github.com/musterhq/muster-code/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/musterhq/muster-code?style=flat&color=f5c518)](https://github.com/musterhq/muster-code/stargazers)

### [⬇ Download for macOS (Apple silicon)](https://github.com/musterhq/muster-code/releases/latest)

<sub><code>Muster-Agent-&lt;version&gt;-arm64.dmg</code> from the latest release · Intel Macs: <a href="#run-muster-agent-on-another-mac-from-source">run from a clone</a></sub>

<br/>

<img src="../../docs/images/muster-agent-hero.png" alt="Muster Agent: a chat with an agent on the left and the live diff of its edits on the right" width="100%"/>

<sub>A chat on the left and the live diff of the agent's edit on the right. Undo any change before you keep it.</sub>

</div>

This package is `@muster/agent-app`, the Muster Agent desktop app. It is plain Electron, with no
Code-OSS and no editor extension host. The product overview is in the
[repository README](../../README.md). This page is the short pitch plus developer notes.

## Why Muster Agent

- **Memory.** Personal and per-folder memory backed by the Hindsight memory engine. A recall preview
  in the composer shows which notes the next turn will use. Auto-save after runs is *Never*, *Ask
  after runs* or *Save after completed runs*.
- **Sandboxing.** Docker-backed scoped computers per chat or per folder: no network unless you allow
  egress, 512 MiB / 1 CPU / 256 processes by default, allowlisted environment and tools.
- **Your providers.** Detected on first launch, with no second sign-in: your ChatGPT and Claude
  CLI sign-ins, OpenAI-compatible gateways from your local agent CLI config, ten well-known API-key
  environment variables, Ollama and LM Studio, or any custom OpenAI-compatible endpoint.
- **Built for low RAM.** Virtualized chat, tool-output and git-history lists. Incremental Markdown
  streaming. Screens that load on first use. One terminal emulator per shell, moved rather than
  rebuilt. Bounded command output. Diff and highlight workers that shut down when idle.
- **A full workbench.** Live diffs with Keep/Undo, an integrated terminal, a built-in browser, a git
  tab with history and compare, parallel chats, skills, plugins and MCP, automations, import of
  past agent sessions, and Spotlight search.

## Tour

What each part of the app looks like, and what to look for. The screenshots use a made-up project,
*taskboard*, a small TypeScript API and web board.

<table>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-timeline.png" alt="One turn, opened up"/><br/><b>One turn, opened up.</b> The agent's reasoning, the files it read and searched, each edit with its +/- counts, and the test run with its output and exit code.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-inline-diff.png" alt="Inline diffs in the chat"/><br/><b>Inline diffs in the chat.</b> Each edited file shows as a diff in the conversation. Keep or Undo one change, or the whole file.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-memory.png" alt="Memory"/><br/><b>Memory.</b> Personal and folder notes with where they came from, a note suggested by the last run to keep or dismiss, and search.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-recall.png" alt="Recall preview"/><br/><b>Recall preview.</b> Before you send, the composer lists the notes the next turn will recall for this draft; remove any you don’t want in this chat.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-providers.png" alt="Accounts and providers"/><br/><b>Accounts and providers.</b> Found on first launch and ready for chats, each with its endpoint, model catalog and a health check.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-providers-local.png" alt="Local model servers"/><br/><b>Local model servers.</b> Ollama and LM Studio on this Mac, next to API keys from your environment.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-model-picker.png" alt="Model picker"/><br/><b>Model picker.</b> Every ready provider's models with context size, image support and reasoning level, switchable per chat.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-sandbox.png" alt="A scoped computer"/><br/><b>A scoped computer.</b> A disposable Linux container with no network, live memory, CPU and process use against its limits, services, command history and files.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-environment-menu.png" alt="Where a chat runs"/><br/><b>Where a chat runs.</b> This Mac, a sandbox, or a new worktree so a parallel chat doesn't touch your checkout.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-terminal.png" alt="Terminal panel"/><br/><b>Terminal panel.</b> Real shells under the chat, one tab per shell, with the dev server and the test run side by side.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-git-changes.png" alt="Git changes"/><br/><b>Git changes.</b> Uncommitted files colour-coded by status, with the chat that changed each one, and the commit box.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-git-history.png" alt="Git history"/><br/><b>Git history.</b> The commit graph with branches, tags and remotes. Pick a commit to see its message and files.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-projects.png" alt="Projects"/><br/><b>Projects.</b> Tasks with owners, priorities and dependencies. Ready tasks go to agents in parallel, and you verify the results.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-spotlight.png" alt="Spotlight search"/><br/><b>Spotlight search.</b> ⌘K finds chats, message text and files from anywhere in the app.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-skills.png" alt="Skills and plugins"/><br/><b>Skills and plugins.</b> Local skills by scope, each switched on or off. Plugins and MCP servers have their own tabs.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-automations.png" alt="Automations"/><br/><b>Automations.</b> Runs on a schedule, when a repository event such as a failed check happens, or when files change.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-updates.png" alt="Updates"/><br/><b>Updates.</b> A new version downloads in the background. Update and relaunch installs it; the same button sits at the bottom of the sidebar.</td>
<td width="50%" valign="top"><img src="../../docs/images/muster-agent-hero-light.png" alt="Light theme"/><br/><b>Light theme.</b> Every screen follows the macOS appearance, or pick light or dark in Settings.</td>
</tr>
</table>

To regenerate these screenshots, run `npm run shots` (see [Screenshots](#screenshots)).

## Install

1. Download the newest `Muster-Agent-<version>-arm64.dmg` from
   [the latest release](https://github.com/musterhq/muster-code/releases/latest) (all releases are
   [tagged `agent-v…`](https://github.com/musterhq/muster-code/releases?q=agent-v)). A `.zip` of the
   same app is attached too, and `SHA256SUMS` lets you check the download
   (`shasum -a 256 -c SHA256SUMS --ignore-missing`).
2. Open the disk image and drag **Muster Agent** onto **Applications**.
3. First open. Builds are signed with the self-signed "Muster Agent Self-Signed" identity: the identity
   stays the same from one release to the next, so macOS keeps the permissions you grant (Screen
   Recording, Accessibility) across updates, but the app is not notarized by Apple. macOS therefore
   blocks the first launch: right-click **Muster Agent** in Applications and choose **Open**, then
   **Open** again (on recent macOS: System Settings > Privacy & Security > **Open Anyway**). Or clear
   the quarantine flag once in Terminal:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Muster Agent.app"
   ```

4. Updates: the app checks GitHub Releases, verifies the download against its published SHA-256 and
   code signature, and accepts it only if it is signed by the same identity. The update installs
   when you restart.

What it needs: macOS 14 (Sonoma) or later and a model provider. The download is Apple silicon only
for now; Intel Macs run from a clone (below). Docker Desktop (sandboxes) is optional.

## Run Muster Agent on another Mac (from source)

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

### One command

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code \
  && cd packages/agent-app && npm ci && npm start
```

Or let the helper check prerequisites first (macOS, Node 24 with an nvm/fnm/mise switch if one is
installed, git, Xcode tools), then run `npm ci` and `npm start`:

```sh
git clone https://github.com/musterhq/muster-code.git && cd muster-code \
  && ./packages/agent-app/scripts/run-mac.sh
```

`npm ci` installs the exact locked dependencies, downloads Electron (about 100 MB), and its
`postinstall` step rebuilds node-pty for Electron. After that, `npm start` builds `dist/` and opens
the app; later runs only need `npm start` from `packages/agent-app`.

### First launch

Muster Agent looks for providers you are already signed in to on that Mac and uses them directly.
If it finds none, it opens guided setup to sign in or add one. Settings and chats live in
`~/Library/Application Support/Muster Agent`; pass `--user-data-dir=/some/dir` (for example
`npx electron . --user-data-dir=/tmp/muster-test`) to run an isolated profile.

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
npm run test:renderer   # renderer tests (scripts/test-renderer.mjs)
npm run rebuild:native  # rebuild node-pty for Electron (needs Xcode CLT)
npm run vendor:sync  # refresh vendor/ from MUSTER_* checkouts
npm run package      # release build: release-dist/Muster-Agent-<version>-<arch>.zip/.dmg + SHA256SUMS
npm run shots        # regenerate the README screenshots in docs/images
```

## Screenshots

`npm run shots` rebuilds the renderer into a temporary folder, loads it in headless Google Chrome
with a fictional preload bridge, and saves each screen to `docs/images/muster-agent-<name>.png`.
Nothing launches Electron or touches your chats: every chat, file, memory and provider shown comes
from `scripts/readme-shots/fixtures.js` (the made-up *taskboard* project), and `mock.js` answers
the renderer's commands from it. `scripts/readme-shots/shots.mjs` lists the shots and how each
screen is reached. Run one or a few with `npm run shots -- hero memory`. Set `CHROME` if Chrome is
not in `/Applications`.

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
