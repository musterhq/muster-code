# Terminal workspace lane · 13 September 2026

## MC-501 deliverable

Muster now has a managed shell-terminal registry in `src/terminal-workspace.ts`. It owns real VS Code `Terminal` instances created with `window.createTerminal`; it does not wrap provider command output or claim that streamed agent tool events are shell sessions.

Each managed record has a stable local ID, `managed-shell` kind, task ID/label, cwd, process ID when available, running/exited/closed status, exit code, timestamps, most recent command, and bounded UTF-8 output. Native terminal behavior remains unchanged: `send` uses `Terminal.sendText`, with execution only when the caller explicitly sets `execute: true`.

## Operator commands

- `muster.terminal.workspace` opens a quick pick of managed running terminals or creates one.
- `muster.terminal.list` returns task-labelled summaries; pass `{ includeClosed: false }` for active shells only.
- `muster.terminal.open` reuses a matching managed terminal by task ID/label/name/cwd, or creates one. Pass `{ reuse: false }` to force creation.
- `muster.terminal.create` always creates a native managed shell.
- `muster.terminal.reveal` shows a terminal by ID.
- `muster.terminal.output` returns a bounded tail; `muster.terminal.search` returns bounded line-addressable matches.
- `muster.terminal.send` writes text to a running terminal; `execute: true` opts into pressing Enter.
- `muster.terminal.close` disposes the native terminal and preserves the closed record for inspection.

The output retention limit is controlled by `muster.terminal.maxOutputBytes` (4 KiB–1 MiB, default 40 KiB). The existing `@terminal` context path remains independent and continues to use its own watcher.

Interactive/open/create commands default to the active AgentPane task context when the runtime supplies `AgentPane.terminalContext()` (`taskId` = stable tab ID, `taskLabel` = tab name, `cwd` = task cwd). Explicit command arguments are merged afterward and therefore win; no command is sent or executed as part of context setup.

## Checks

- `pnpm --filter @muster-code/builtin test` — 42 passed, including UTF-8 output bounding, case-insensitive output search, command registration, native-terminal lifecycle behavior, and browser regressions.
- `pnpm --filter @muster-code/builtin build` — passed.
- `pnpm --filter @muster-code/builtin typecheck` still reports the unrelated existing `CodexTurnResult` fields in `agent-pane.ts`; the terminal files introduce no reported type error.

## UI/runtime integration

The command IDs are available for `/root/frontend` to add a terminal workspace entry point and render `ManagedTerminalSummary`/`OutputMatch` data. `/root/runtime` can attach task IDs/labels when it opens a terminal through `muster.terminal.open`; no extra model call is needed. Existing provider tool cards should retain their current output rendering and remain visibly distinct from managed shell records.

## Risks and live checks

VS Code does not provide a portable readback API for arbitrary terminal screen contents, so output inspection depends on the proposed `onDidWriteTerminalData` event and captures writes observed after registration. Shells or extensions that bypass that event may have an empty inspection buffer while remaining fully usable natively. Verify in the packaged app that a created terminal receives output, status transitions to exited after `exit`, remains listed as closed after disposal, and that reopening by task ID reuses the same shell only while it is running.
