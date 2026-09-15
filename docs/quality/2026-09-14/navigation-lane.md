# Navigation lane · 14 September 2026

`navigation.ts` adds a native `Muster: Go To` QuickPick hub. It delegates to existing workbench and Muster commands for Files, Commands, Symbols, Lines, Tasks, Managed terminals, Browser, Review, Appearance, and Word Wrap. Files still use the native `workbench.action.quickOpen` path, so Cmd+P retains its normal file-picker semantics; Cmd+K inline edit and live-diff shortcuts are untouched.

The hub uses Cmd+Alt+G on macOS and Ctrl+Alt+G on Windows/Linux. Destination rows show platform-specific native hints, and the hub dispatches exactly one selected command or none on cancellation. The runtime `muster.workspace.hub` is registered through its existing `registerWorkspaceHub` entry point, so Workspaces appears only when that command (or one of the compatible `muster.workspaces.open`, `muster.worktree.open`, `muster.orca.open`, or `muster.omniroute.open` commands) is actually registered. Navigation owns no worktree mutation logic.

Native QuickInput widgets receive a small opaque Graphite treatment with theme-token colors, restrained rim/shadow, and a high-contrast solid fallback. There is no animation or custom fuzzy index. The existing workbench watermark patch now keeps Commands, Files, Search in Files, Terminal, Add Folder, and Settings mapped to their honest native actions instead of routing them to unrelated agent actions.

The `muster.ui.glass` configuration defaults to true, and the AgentPane state payload includes `appearance.glass` for the frontend’s pane preview/settings contract.

## Checks

- Navigation behavior tests cover destination gating, platform hints, cancellation, single dispatch, unknown command filtering, shortcut conflict, and watermark mappings.
- `zsh -n`/Python syntax and manifest checks should be run by the parent integrated pass; this lane does not claim native QA completion.
