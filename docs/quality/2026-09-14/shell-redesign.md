# Muster shell redesign · 14 September 2026

The native shell now has a distinct graphite hierarchy while retaining the
Code-OSS workbench components and their commands. The change is contained in
`product/muster-workbench.css`; it does not replace the workbench, editor,
diff, terminal, Explorer, settings, or panel implementations.

## Component mapping

| Native surface | Selector family | Treatment | Access preserved |
| --- | --- | --- | --- |
| Masthead and navigation | `.part.titlebar`, `.titlebar-container`, `.window-title`, `.command-center` | Compact product rail, copper hairline, rounded command entry | Window controls, menus, command center |
| Left rail | `.part.activitybar`, `.activitybar .action-item` | Stacked graphite controls with selected-state edge | Explorer, search, source control, run, extensions |
| Project and task panes | `.part.sidebar`, `.part.auxiliarybar`, `.pane-header`, `.monaco-list-row` | Uppercase section labels, framed rows, scoped hover/selection | Explorer and task/agent views |
| Editor groups | `.part.editor`, `.editor-group-container`, `.tabs-container > .tab` | Framed groups and tab underline; editor canvas remains opaque | Files, split groups, tab close/switch |
| Panels and status | `.part.panel`, `.part.basepanel`, `.part.statusbar` | Shared dock language and compact metrics | Terminal, Problems, Output, Debug Console, status actions |
| Native overlays | `.quick-input-widget`, `.context-view .monaco-menu` | Opaque fallback, restrained glass where supported | Commands, Go To, menus, settings search |
| Settings | `.settings-editor`, `.settings-header` | Same opaque document canvas with framed header | Settings categories and search |

The CSS uses existing `--vscode-*` theme tokens and adds `--mc-shell-*`
aliases for the shell only. Glass filtering is limited to titlebar, rails,
panes, panels, status, quick input, and menus. Editors, diff editors, source
documents, and transcript content do not receive a filter. Opaque backgrounds
are the default fallback; `prefers-reduced-transparency` and high contrast
disable backdrop filtering and use stronger borders.

## Compatibility risks and checks

Selectors were checked against the staged Code-OSS workbench stylesheet for
the current `.part.*`, `.titlebar-container`, `.activitybar`,
`.editor-group-container`, `.tabs-container > .tab`, `.statusbar`,
`.quick-input-widget`, and `.settings-editor` structures. The main risks are a
future upstream rename of a native part class, a user-selected vertical/top
activity-bar layout, and theme combinations that do not implement
`color-mix()`. The existing theme values remain the fallback source for every
surface, and the rules avoid `display:none` on functional controls.

Static acceptance for this lane:

```sh
python3 - <<'PY'
from pathlib import Path
css = Path("product/muster-workbench.css").read_text()
assert css.count("{") == css.count("}")
assert "backdrop-filter" in css and ".monaco-editor" not in css[css.index("/* ── Muster shell") :]
for selector in (".part.titlebar", ".part.activitybar", ".part.sidebar", ".part.auxiliarybar", ".part.editor", ".part.panel", ".part.statusbar", ".quick-input-widget", ".settings-editor"):
    assert selector in css, selector
PY
```

Native QA should confirm that the Explorer, editor tabs/splits, inline and
full-file diffs, terminal panel, settings search, command palette, and task
workspace remain reachable. Visual review belongs to the frontend/native QA
lane after a fresh staged app is assembled; this lane does not claim GUI
acceptance.
