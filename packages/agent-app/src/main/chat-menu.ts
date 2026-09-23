/** Native chat and folder menus (Codex item order and shortcut hints). Pure: tests read the template without Electron. */
import type { MenuItemConstructorOptions } from 'electron';
import type { Chat, ChatMenuAction, Folder, Project } from '../shared/protocol.ts';
import { isSnoozed, snoozeChoices } from '../shared/snooze.ts';

export type ChatMenuCommand =
  | { kind: 'renderer'; action: ChatMenuAction }
  | { kind: 'pin' } | { kind: 'unread'; unread: boolean } | { kind: 'archive' } | { kind: 'delete' }
  | { kind: 'project'; projectId: string | null } | { kind: 'folder'; folderId: string } | { kind: 'folder-pick' }
  | { kind: 'copy'; what: 'link' | 'id' | 'path' | 'markdown' } | { kind: 'export' }
  | { kind: 'pin-move'; direction: 'up' | 'down' } | { kind: 'reveal' }
  | { kind: 'snooze'; until?: string; untilActivity?: boolean } | { kind: 'wake' }
  | { kind: 'open-in'; app: string };

export type FolderMenuCommand = { kind: 'renderer'; action: 'new-chat' | 'rename' | 'files' | 'default-model' } | { kind: 'reveal' } | { kind: 'relink' } | { kind: 'remove' } | { kind: 'move'; direction: 'up' | 'down' };

/** Hints only: the Work menu and the renderer own the real shortcuts, so a context menu must not register them twice. */
const hint = (accelerator: string) => ({ accelerator, registerAccelerator: false });

export function chatMenuTemplate(input: { chat: Chat; folders: readonly Folder[]; projects: readonly Project[]; surface: 'sidebar' | 'header'; openIn?: readonly { id: string; name: string }[] }, pick: (command: ChatMenuCommand) => void): MenuItemConstructorOptions[] {
  const { chat, surface } = input;
  const folder = chat.folderId ? input.folders.find(item => item.id === chat.folderId) : undefined;
  const usable = folder && !folder.missing ? folder : undefined;
  const item = (label: string, command: ChatMenuCommand, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({ label, click: () => pick(command), ...extra });
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const project = chat.projectId ? input.projects.find(entry => entry.id === chat.projectId) : undefined;
  // A chat can gain a folder when it has none, or when the one it had was removed or went missing.
  const attachable = (!folder || folder.missing) ? input.folders.filter(entry => !entry.missing && (!project || project.folderIds.includes(entry.id))) : null;
  const template: MenuItemConstructorOptions[] = [
    item('Rename…', { kind: 'renderer', action: 'rename' }, hint('Alt+CmdOrCtrl+R')),
    item(chat.pinned ? 'Unpin' : 'Pin', { kind: 'pin' }, { ...hint('Alt+CmdOrCtrl+P'), enabled: !chat.archived || chat.pinned }),
    item(chat.unread ? 'Mark as Read' : 'Mark as Unread', { kind: 'unread', unread: !chat.unread }, hint('Shift+CmdOrCtrl+U')),
    // CHAT-15: snooze files the chat away until a time or new activity; a snoozed chat offers Wake Now instead.
    isSnoozed(chat)
      ? item('Wake Now', { kind: 'wake' })
      : { label: 'Snooze', enabled: !chat.archived, submenu: [
        ...snoozeChoices().map(choice => item(`${choice.label}${choice.preset === 'activity' ? '' : ` (${choice.hint})`}`, { kind: 'snooze', ...(choice.until ? { until: choice.until } : {}), ...(choice.untilActivity ? { untilActivity: true } : {}) })),
        separator,
        item('Choose Date and Time…', { kind: 'renderer', action: 'snooze' }),
      ] },
    item(chat.archived ? 'Restore' : 'Archive', { kind: 'archive' }, hint('Shift+CmdOrCtrl+A')),
    item('Permanently Delete…', { kind: 'delete' }),
    separator,
    { label: 'Project', submenu: [
      item('None', { kind: 'project', projectId: null }, { type: 'radio', checked: !project }),
      ...(input.projects.length ? [separator] : []),
      ...input.projects.map(entry => item(entry.name, { kind: 'project', projectId: entry.id }, { type: 'radio', checked: entry.id === project?.id })),
    ] },
    ...(attachable ? [{ label: folder?.missing ? 'Folder (missing)' : 'Folder', submenu: [
      ...attachable.map(entry => item(entry.name, { kind: 'folder', folderId: entry.id }, { toolTip: entry.path })),
      ...(attachable.length ? [separator] : []),
      item('Choose Folder…', { kind: 'folder-pick' }, { enabled: !project }),
    ] } satisfies MenuItemConstructorOptions] : []),
    { label: 'Copy', submenu: [
      item('Chat Link', { kind: 'copy', what: 'link' }),
      item('Chat ID', { kind: 'copy', what: 'id' }),
      ...(folder ? [item('Folder Path', { kind: 'copy', what: 'path' })] : []),
      item('Conversation as Markdown', { kind: 'copy', what: 'markdown' }),
    ] },
    item(surface === 'header' ? 'Export Conversation…' : 'Export…', { kind: 'export' }),
    // USER-18: Share sheet — Markdown / HTML / JSON with a redaction toggle; its link stays local to this Mac.
    item('Share…', { kind: 'renderer', action: 'share' }),
    // Codex chat menu parity (2026-09-22T1133): Fork branches the whole conversation into a new chat.
    item('Fork', { kind: 'renderer', action: 'fork' }),
    separator,
    surface === 'header'
      ? item('Open Terminal', { kind: 'renderer', action: 'terminal' }, hint('CmdOrCtrl+J'))
      : item('Open Command Activity', { kind: 'renderer', action: 'activity' }),
    ...(usable ? [item('Open Files and Changes', { kind: 'renderer', action: 'files' })] : []),
    ...(usable ? [item(process.platform === 'darwin' ? 'Open in Finder' : 'Open Folder', { kind: 'reveal' })] : []),
    // USER-31/W6-D: Codex "Open in" — the chat's folder in an installed editor (VS Code, Cursor, …).
    ...(usable && input.openIn?.some(app => app.id !== 'finder') ? [{ label: 'Open in', submenu: input.openIn.filter(app => app.id !== 'finder').map(app => item(app.name, { kind: 'open-in', app: app.id })) } satisfies MenuItemConstructorOptions] : []),
  ];
  if (chat.pinned && !chat.archived) template.push(separator, item('Move Pin Up', { kind: 'pin-move', direction: 'up' }, hint('Alt+Shift+Up')), item('Move Pin Down', { kind: 'pin-move', direction: 'down' }, hint('Alt+Shift+Down')));
  return template;
}

export type ProjectMenuCommand = 'new-chat' | 'open' | 'rename' | 'edit' | 'export' | 'archive' | 'restore';
/** UR-135 / S3-G: right-clicking a Project row gets a native menu like chats and folders: rename, edit (goal and folders) and archive live here too. */
export function projectMenuTemplate(project: Project, pick: (command: ProjectMenuCommand) => void): MenuItemConstructorOptions[] {
  const item = (label: string, command: ProjectMenuCommand, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({ label, click: () => pick(command), ...extra });
  return [
    item('New Chat in Project', 'new-chat', { enabled: !project.archived }),
    item('Open Project', 'open'),
    { type: 'separator' },
    item('Rename…', 'rename'),
    item('Edit Project…', 'edit'),
    item(`Export “${project.name}”…`, 'export'),
    { type: 'separator' },
    project.archived ? item('Restore Project', 'restore') : item('Archive Project…', 'archive'),
  ];
}

export function folderMenuTemplate(folder: Folder, pick: (command: FolderMenuCommand) => void, place: { first: boolean; last: boolean } = { first: true, last: true }): MenuItemConstructorOptions[] {
  const item = (label: string, command: FolderMenuCommand, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({ label, click: () => pick(command), ...extra });
  return [
    item('New Chat Here', { kind: 'renderer', action: 'new-chat' }, { enabled: !folder.missing }),
    item('Browse Files', { kind: 'renderer', action: 'files' }, { enabled: !folder.missing }),
    item(process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder', { kind: 'reveal' }, { enabled: !folder.missing }),
    { type: 'separator' },
    item('Rename…', { kind: 'renderer', action: 'rename' }),
    item(folder.missing ? 'Relink Missing Folder…' : 'Relink…', { kind: 'relink' }),
    // CMP-23: the model new chats in this folder start with.
    item('Default Model…', { kind: 'renderer', action: 'default-model' }),
    { type: 'separator' },
    // NAV-05: keyboard/menu equivalent of dragging the folder header (⌥⇧↑ / ⌥⇧↓ in the sidebar).
    item('Move Up', { kind: 'move', direction: 'up' }, { ...hint('Alt+Shift+Up'), enabled: !place.first }),
    item('Move Down', { kind: 'move', direction: 'down' }, { ...hint('Alt+Shift+Down'), enabled: !place.last }),
    { type: 'separator' },
    item('Remove from Sidebar…', { kind: 'remove' }),
  ];
}

/** Resolves with the clicked command, or null once the menu closes without one. On macOS the close callback can
 *  arrive just before the click, so the null answer waits a beat. */
export function popupChoice<T>(open: (pick: (command: T) => void, closed: () => void) => void): Promise<T | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (value: T | null) => { if (!done) { done = true; resolve(value); } };
    open(command => finish(command), () => setTimeout(() => finish(null), 120));
  });
}
