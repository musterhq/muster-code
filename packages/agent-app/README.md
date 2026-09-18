# @muster/agent-app

Standalone Muster Code agent desktop app. Plain Electron — no Code-OSS, no
VS Code extension host.

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
- `scripts/build.mjs` — esbuild bundling for main/preload/renderer.
- `tests/` — `node --test` unit tests (window geometry clamp, command
  guard).

## Commands

```sh
npm install          # isolated; does not touch the repo root lockfile
npm run build        # bundle main + preload (+ renderer when present)
npm start            # build then launch Electron
npm run dev          # rebuild on change
npm run typecheck    # tsc --noEmit
npm test             # node --test 'tests/*.test.ts'
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
