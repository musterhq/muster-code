# Browser lane · 13 September 2026

## Scope

MC-301 navigation and diagnostics, MC-302 browser selection/edit/context surfaces, and MC-303 stress and cleanup. Changes are limited to the browser controller/tool bridge, browser main-process overlay, browser-specific tests, and deterministic development fixtures.

## Findings and fixes

- Navigation completion previously returned after `loadURL` accepted a request. The main process now waits for stop/fail events, cancels a superseded waiter, enforces a timeout, and checks the current target URL before accepting a stop event.
- Main-frame failures and subframe request failures are separate. Main-frame failures populate `loadError` and hide the real page view so the editor tab's recoverable error state is visible; subframe failures are retained in bounded `networkErrors` diagnostics.
- Browser state now optionally includes monotonic main-process navigation, back/forward availability, loading/error state, and bounded network errors. Existing state consumers can ignore these fields.
- The MCP bridge reports explicit history/loading/error status in `browser_tabs`, adds `browser_diagnostics` and `browser_go_forward`, filters console output by severity/limit, rejects stale explicit tab IDs, and releases pending calls when the socket closes.
- Editor browser tabs have an accessible loading/error status and retry button. The pane already consumes `loading`/`loadError` in its health row; the added state remains backward-compatible for the pane renderer.
- Visual edits still use the existing live edit engine. Navigation, reload, back and forward clear picked state and pending visual changes so edits cannot silently apply to another page. Screenshot picks continue through the existing `.muster/browser` attachment path.

## Checks

- `pnpm --filter @muster-code/builtin test` — 41 passed, including executable fake-Electron navigation event sequences.
- `node --check product/muster-browser-main.js` — passed.
- `git diff --check` on browser lane files — passed.
- `pnpm --filter @muster-code/builtin typecheck` reaches unrelated pre-existing `CodexTurnResult` errors in `agent-pane.ts`; no browser-file type error remains after that baseline failure.

## Deterministic live QA

From the repository root, serve the fixture directory:

```sh
python3 -m http.server 4317 --directory scripts/dev/site
```

Use these URLs in the packaged app:

- `http://127.0.0.1:4317/index.html`: click, type/submit, select, hover, back/forward, element pick, screenshot attachment, and console warning/late-error checks.
- `http://127.0.0.1:4317/page2.html`: history and forward-button availability.
- `http://127.0.0.1:4317/slow.html`: loading state, delayed text with `browser_wait_for`, and no early snapshot race.
- `http://127.0.0.1:4317/subframe-error.html`: main page remains usable while diagnostics identifies a subframe network error.
- `http://127.0.0.1:4317/console-stress.html`: emit 450 messages; verify the UI stays responsive, the bounded console retains the newest entries, and `browser_console_messages` limit/severity filters work.
- `http://127.0.0.1:4318/`: refused connection on an unused local port; verify failed main-frame load, URL restoration, visible retry/error state, and successful recovery by navigating back to `index.html`. An HTTP 404 fixture is intentionally not used because Chromium treats an HTTP error response as a loaded document.

For cleanup, open a pane browser and an editor browser, switch between them while an agent turn is driving, close each tab during and after a load, and confirm `browser_tabs` no longer lists closed IDs and no stale page view remains over the workbench. Parent lane owns the real native UI and inference checks for take-control, selection context, visual Apply changes, and dirty-buffer/undo behavior.

## Integration needs

- `/root/frontend` should expose optional `history` and `networkErrors` in any richer browser diagnostics panel if desired; current pane health rendering already handles loading/error.
- `/root/runtime` should preserve the selected browser tab ID when assembling live context so `@browser` cannot fall through to another visible tab during a switch.
- Parent native QA should rebuild the staged app so `product/muster-browser-main.js` is injected into `out/main.js`, then exercise the URLs above in both pane and editor locations.
