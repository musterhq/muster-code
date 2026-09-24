# Muster Code

Private. The standalone, Codex-first coding environment around muster: the reference IDE as the bar, every VS Code feature, your Codex threads pinned, the board in the editor.

## Run Muster Agent on another Mac

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
npm run build && node scripts/package-preview.mjs   # -> release/Muster Agent Preview.app
```

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

## Shape

- `product/` — the distribution overlay (branding, Open VSX gallery, Muster as the default chat agent, proposed-API grants).
- `packages/builtin/` — the built-in Muster layer: default chat participant, Codex thread sessions, model provider, threads view, board, live diff, inline completions. Bundled into the app as `muster.muster-code`.
- `packages/agent-app/` — Muster Agent, the standalone Electron agent app (see the section above).
- `scripts/assemble.sh` — builds `dist/Muster Code.app` from a prebuilt Code-OSS binary + overlay + built-in layer. No VS Code compile.
- Engine: `@musterhq/core` (the open-source muster) linked from the sibling checkout.

## Build

```
pnpm install
pnpm assemble          # → dist/Muster Code.app
open "dist/Muster Code.app"
```

Dev launch (isolated profile): `MUSTER_CODE_DEV_SOCK=/tmp/mc-dev.sock "dist/Muster Code.app/Contents/MacOS/Muster Code" --user-data-dir /tmp/mc-udd /tmp/mc-sample`

Base: Code-OSS 1.126 (Electron 42, Node 24 with node:sqlite), from the VSCodium release binaries.
