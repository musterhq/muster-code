import type { MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../shared/menu-protocol.ts';

export const PRODUCT_NAME = 'Muster Agent';

export interface MenuDeps {
  isMac: boolean;
  /** DevTools never ships in the packaged product menu. */
  isPackaged: boolean;
  /** A bundled help page; none exists today, so Help stays disabled rather than pointing at an unverified URL. */
  helpAvailable: boolean;
  /** Forward a UI intent to the renderer (which owns selection, panes and tabs). */
  send(action: MenuAction): void;
  /** Main-process actions that need dialogs or the service directly. */
  addFolder(): void;
  stopRun(): void;
  openHelp(): void;
  toggleDevTools(): void;
  /** PER-10: opens the bundled third-party license file; the item is omitted when absent. */
  openLicenses?(): void;
}

/** Native application menu. No IDE gear (build/run/debug) — this is the agent
 *  product, not an editor. "Work" holds agent actions. Pure so tests can
 *  inspect it without Electron. */
export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const { isMac } = deps;
  const item = (label: string, action: MenuAction, accelerator?: string): MenuItemConstructorOptions =>
    ({ label, accelerator, click: () => deps.send(action) });
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      role: 'appMenu',
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about', label: `About ${PRODUCT_NAME}` },
        { type: 'separator' },
        item('Settings…', 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${PRODUCT_NAME}` },
      ],
    });
  }

  template.push(
    {
      label: 'File',
      submenu: [
        item('New Chat', 'new-chat', 'CmdOrCtrl+N'),
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => deps.addFolder() },
        { type: 'separator' },
        // Closes the focused resource tab first; the renderer asks main to close the window only when none is left.
        item('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        ...(isMac ? [] : [{ type: 'separator' } as const, item('Settings…', 'settings', 'Ctrl+,'), { type: 'separator' } as const, { role: 'quit' } as const]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find in Chat', 'find-in-chat', 'CmdOrCtrl+F'),
        // CS-B13-5: Codex's ⌘/ puts the caret back in the composer from anywhere in the window.
        item('Focus Composer', 'focus-composer', 'CmdOrCtrl+/'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        item('Toggle Resources', 'toggle-resources', 'Alt+CmdOrCtrl+B'),
        item('Toggle Summary', 'toggle-summary'),
        item('Search Chats', 'search-chats', 'CmdOrCtrl+K'),
        // NAV-12: every menu and quick action with its shortcut and whether it can run here.
        item('Command Palette…', 'command-palette', 'Shift+CmdOrCtrl+P'),
        { type: 'separator' },
        item('Back', 'back', 'CmdOrCtrl+['),
        item('Forward', 'forward', 'CmdOrCtrl+]'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Work',
      submenu: [
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => deps.stopRun() },
        item('Open Terminal', 'open-terminal', 'CmdOrCtrl+J'),
        { type: 'separator' },
        item('Rename Chat', 'rename-chat', 'Alt+CmdOrCtrl+R'),
        item('Mark as Unread', 'mark-unread', 'Shift+CmdOrCtrl+U'),
        item('Pin Chat', 'pin-chat', 'Alt+CmdOrCtrl+P'),
        item('Snooze or Wake Chat…', 'snooze-chat', 'Alt+CmdOrCtrl+Z'),
        item('Archive Chat', 'archive-chat', 'Shift+CmdOrCtrl+A'),
        item('Copy Chat Link', 'copy-link'),
        { type: 'separator' },
        item('Next Chat', 'next-chat', 'Ctrl+Tab'),
        item('Previous Chat', 'prev-chat', 'Ctrl+Shift+Tab'),
        { type: 'separator' },
        ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((slot) => item(`Chat ${slot}`, `chat-${slot}`, `CmdOrCtrl+${slot}`)),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: `${PRODUCT_NAME} Help`, enabled: deps.helpAvailable, click: () => deps.openHelp() },
        ...(deps.openLicenses ? [{ label: 'Third-Party Notices', click: () => deps.openLicenses!() }] : []),
        ...(deps.isPackaged ? [] : [
          { type: 'separator' } as const,
          { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => deps.toggleDevTools() },
        ]),
      ],
    },
  );

  return template;
}

/** Every leaf item in declaration order, for tests and shortcut listings. */
export function flattenMenu(template: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const entry of template) {
    if (Array.isArray(entry.submenu)) out.push(...flattenMenu(entry.submenu));
    else out.push(entry);
  }
  return out;
}
