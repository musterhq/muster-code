import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  newChat(): void;
  addFolder(): void;
  stopRun(): void;
}

/** Native application menu. No IDE gear (build/run/debug) — this is the agent
 *  product, not an editor. "Work" holds agent actions. */
export function buildMenu(getWindow: () => BrowserWindow | null, actions: MenuActions): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push(
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => actions.newChat() },
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.addFolder() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
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
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
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
        { label: 'Stop Current Run', accelerator: 'CmdOrCtrl+.', click: () => actions.stopRun() },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Muster Code Help',
          click: () => {
            // Intentional user gesture; the only sanctioned external navigation.
            void shell.openExternal('https://muster.dev/help');
          },
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => getWindow()?.webContents.toggleDevTools(),
        },
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}
