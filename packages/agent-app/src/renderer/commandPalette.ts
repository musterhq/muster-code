/** NAV-12 command palette: every menu and quick action, its shortcut, and whether it can run right now.
 *  Pure (no React, no store) so eligibility is unit-tested; SpotlightSearch renders and executes. */
import { fuzzyMatch, type FuzzyMatch } from './spotlightModel.ts';

/** Command-mode prefix inside ⌘K (VS Code/Cursor convention); ⌘⇧P opens the palette already in this mode. */
export const COMMAND_PREFIX = '>';

export function parsePaletteQuery(raw: string): { mode: 'commands' | 'search'; text: string } {
  const lead = raw.trimStart();
  return lead.startsWith(COMMAND_PREFIX) ? { mode: 'commands', text: lead.slice(1).trim() } : { mode: 'search', text: raw.trim() };
}

export type CommandId =
  | 'new-chat' | 'open-folder' | 'search-chats' | 'search-files' | 'find-in-chat' | 'focus-composer' | 'close-tab'
  | 'toggle-sidebar' | 'toggle-resources' | 'toggle-summary' | 'back' | 'forward' | 'stop' | 'open-terminal'
  | 'rename-chat' | 'mark-unread' | 'pin-chat' | 'snooze-chat' | 'archive-chat' | 'copy-link' | 'next-chat' | 'prev-chat'
  | 'settings' | 'providers' | 'plugins' | 'memory' | 'automations' | 'projects' | 'stashes' | 'import-conversations'
  | 'git-changes' | 'git-history' | 'git-pull-request'
  | `chat-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export type CommandGroup = 'Chat' | 'File' | 'View' | 'Go' | 'App';

export interface CommandDef {
  readonly id: CommandId;
  readonly label: string;
  readonly group: CommandGroup;
  /** Display form of the accelerator the app menu (or a window chord) binds; '' when none. */
  readonly shortcut: string;
  readonly keywords?: string;
}

/** What eligibility is decided from — a plain snapshot of the renderer state at palette-open time. */
export interface CommandContext {
  readonly screen: string;
  readonly draftOpen: boolean;
  readonly chat: {
    readonly id: string; readonly title: string; readonly status: string; readonly archived: boolean;
    readonly pinned: boolean; readonly unread: boolean; readonly snoozed: boolean; readonly folderName?: string;
  } | null;
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** Chats in ⌘1…⌘9 order (visible, unarchived), titles only. */
  readonly slotTitles: readonly string[];
  readonly chatCount: number;
}

export interface CommandState {
  readonly enabled: boolean;
  /** Why it is disabled — the missing prerequisite, in the user's terms. */
  readonly reason?: string;
  /** What it will act on, shown before running it ("Refactor auth", "api-server"). */
  readonly scope?: string;
  /** A state-dependent label ("Unpin chat" for a pinned chat). */
  readonly label?: string;
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const COMMANDS: readonly CommandDef[] = [
  { id: 'new-chat', label: 'New chat', group: 'File', shortcut: '⌘N', keywords: 'start conversation draft' },
  { id: 'open-folder', label: 'Add folder…', group: 'File', shortcut: '⌘O', keywords: 'open workspace directory repository' },
  { id: 'search-chats', label: 'Search chats and files', group: 'Go', shortcut: '⌘K', keywords: 'find spotlight global' },
  { id: 'search-files', label: 'Go to file…', group: 'Go', shortcut: '⌘P', keywords: 'quick open search files' },
  { id: 'find-in-chat', label: 'Find in chat', group: 'Chat', shortcut: '⌘F', keywords: 'search transcript' },
  { id: 'focus-composer', label: 'Focus composer', group: 'Chat', shortcut: '⌘/', keywords: 'message input prompt' },
  { id: 'close-tab', label: 'Close tab', group: 'View', shortcut: '⌘W' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', group: 'View', shortcut: '⌘B', keywords: 'navigation hide show' },
  { id: 'toggle-resources', label: 'Toggle resources', group: 'View', shortcut: '⌥⌘B', keywords: 'right pane panel hide show' },
  { id: 'toggle-summary', label: 'Toggle summary', group: 'View', shortcut: '' },
  { id: 'back', label: 'Back', group: 'Go', shortcut: '⌘[', keywords: 'previous history' },
  { id: 'forward', label: 'Forward', group: 'Go', shortcut: '⌘]', keywords: 'next history' },
  { id: 'next-chat', label: 'Next chat', group: 'Go', shortcut: '⌃Tab' },
  { id: 'prev-chat', label: 'Previous chat', group: 'Go', shortcut: '⌃⇧Tab' },
  { id: 'stop', label: 'Stop run', group: 'Chat', shortcut: '⌘.', keywords: 'cancel interrupt abort' },
  { id: 'open-terminal', label: 'Open terminal', group: 'Chat', shortcut: '⌘J', keywords: 'shell pty console' },
  { id: 'rename-chat', label: 'Rename chat…', group: 'Chat', shortcut: '⌥⌘R', keywords: 'title' },
  { id: 'mark-unread', label: 'Mark as unread', group: 'Chat', shortcut: '⇧⌘U' },
  { id: 'pin-chat', label: 'Pin chat', group: 'Chat', shortcut: '⌥⌘P', keywords: 'unpin' },
  { id: 'snooze-chat', label: 'Snooze chat…', group: 'Chat', shortcut: '⌥⌘Z', keywords: 'wake remind later' },
  { id: 'archive-chat', label: 'Archive chat', group: 'Chat', shortcut: '⇧⌘A', keywords: 'unarchive hide' },
  { id: 'copy-link', label: 'Copy chat link', group: 'Chat', shortcut: '', keywords: 'share url' },
  { id: 'settings', label: 'Open settings', group: 'App', shortcut: '⌘,', keywords: 'preferences general appearance' },
  { id: 'providers', label: 'Accounts & providers', group: 'App', shortcut: '', keywords: 'model models reasoning usage api key' },
  { id: 'plugins', label: 'Skills & plugins', group: 'App', shortcut: '', keywords: 'skill plugin mcp' },
  { id: 'memory', label: 'Memory', group: 'App', shortcut: '' },
  { id: 'automations', label: 'Automations', group: 'App', shortcut: '', keywords: 'schedule scheduled cron' },
  { id: 'projects', label: 'Projects', group: 'App', shortcut: '', keywords: 'team tasks board' },
  { id: 'stashes', label: 'Prompt stashes', group: 'Chat', shortcut: '', keywords: 'stash stashed draft saved restore' },
  { id: 'import-conversations', label: 'Import conversations…', group: 'App', shortcut: '', keywords: 'codex claude chatgpt sessions history transcripts' },
  // The one Git tab (Changes · History · Pull request) for the chat's folder.
  { id: 'git-changes', label: 'Git: Changes', group: 'View', shortcut: '', keywords: 'diff review stage commit uncommitted working tree status' },
  { id: 'git-history', label: 'Git: History', group: 'View', shortcut: '', keywords: 'log commits compare branches graph blame' },
  { id: 'git-pull-request', label: 'Git: Pull request', group: 'View', shortcut: '', keywords: 'pr github review checks ci create open' },
  ...SLOTS.map((slot): CommandDef => ({ id: `chat-${slot}`, label: `Go to chat ${slot}`, group: 'Go', shortcut: `⌘${slot}`, keywords: 'switch jump' })),
];

const NO_CHAT = 'Open a chat first';

/** Eligibility for one command in `ctx`. Every command is always listed; a disabled one says what is missing. */
export function commandState(id: CommandId, ctx: CommandContext): CommandState {
  const chat = ctx.draftOpen ? null : ctx.chat;
  const chatScope = chat ? chat.title : undefined;
  const needChat = (extra?: Partial<CommandState>): CommandState => chat ? { enabled: true, scope: chatScope, ...extra } : { enabled: false, reason: NO_CHAT };
  const slot = /^chat-([1-9])$/.exec(id);
  if (slot) {
    const title = ctx.slotTitles[Number(slot[1]) - 1];
    return title ? { enabled: true, scope: title } : { enabled: false, reason: `No chat in position ${slot[1]}` };
  }
  switch (id) {
    case 'back': return ctx.canBack ? { enabled: true } : { enabled: false, reason: 'No earlier chat in history' };
    case 'forward': return ctx.canForward ? { enabled: true } : { enabled: false, reason: 'Nothing to go forward to' };
    case 'next-chat': case 'prev-chat': return ctx.chatCount > 1 ? { enabled: true } : { enabled: false, reason: 'Needs at least two chats' };
    case 'focus-composer': return ctx.screen === 'work' ? { enabled: true } : { enabled: false, reason: 'Return to a chat to use the composer' };
    case 'find-in-chat': return needChat();
    case 'search-files': {
      if (!chat) return { enabled: false, reason: 'Open a chat in a folder first' };
      return chat.folderName ? { enabled: true, scope: chat.folderName } : { enabled: false, reason: 'This chat has no folder' };
    }
    case 'open-terminal': return needChat(chat?.folderName ? { scope: chat.folderName } : {});
    case 'git-changes': case 'git-history': case 'git-pull-request': {
      if (!chat) return { enabled: false, reason: 'Open a chat in a folder first' };
      return chat.folderName ? { enabled: true, scope: chat.folderName } : { enabled: false, reason: 'This chat has no folder' };
    }
    case 'stop': {
      if (!chat) return { enabled: false, reason: NO_CHAT };
      if (chat.status === 'stopping') return { enabled: false, reason: 'Already stopping' };
      return ['running', 'waiting', 'reconnecting', 'queued'].includes(chat.status) ? { enabled: true, scope: chatScope } : { enabled: false, reason: 'This chat is not running' };
    }
    case 'rename-chat': case 'copy-link': return needChat();
    case 'mark-unread': return !chat ? { enabled: false, reason: NO_CHAT } : chat.unread ? { enabled: false, reason: 'Already unread' } : needChat();
    case 'pin-chat': return needChat(chat?.pinned ? { label: 'Unpin chat' } : {});
    case 'archive-chat': return needChat(chat?.archived ? { label: 'Unarchive chat' } : {});
    case 'snooze-chat': return !chat ? { enabled: false, reason: NO_CHAT } : chat.archived ? { enabled: false, reason: 'Archived chats cannot be snoozed' } : needChat(chat.snoozed ? { label: 'Wake chat' } : {});
    case 'stashes': return ctx.screen === 'work' ? { enabled: true } : { enabled: false, reason: 'Return to a chat to use stashes' };
    case 'memory': return { enabled: true, scope: chat?.folderName };
    default: return { enabled: true };
  }
}

export interface CommandRow {
  readonly command: CommandDef;
  readonly state: CommandState;
  readonly label: string;
  readonly labelRanges: FuzzyMatch['ranges'];
}

/** All commands (empty query: menu order, enabled first) or the fuzzy-ranked matches; disabled ones stay listed. */
export function commandRows(query: string, ctx: CommandContext, commands: readonly CommandDef[] = COMMANDS): CommandRow[] {
  const q = query.trim();
  const rows: Array<CommandRow & { score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const state = commandState(command.id, ctx);
    const label = state.label ?? command.label;
    if (!q) { rows.push({ command, state, label, labelRanges: [], score: 0, order }); return; }
    const labelMatch = fuzzyMatch(q, label);
    if (labelMatch) { rows.push({ command, state, label, labelRanges: labelMatch.ranges, score: labelMatch.score + 10, order }); return; }
    const keywordMatch = fuzzyMatch(q, `${command.group} ${command.keywords ?? ''}`);
    if (keywordMatch) rows.push({ command, state, label, labelRanges: [], score: keywordMatch.score * 0.5, order });
  });
  rows.sort((a, b) => Number(b.state.enabled) - Number(a.state.enabled) || b.score - a.score || a.order - b.order);
  return rows.map(({ score: _score, order: _order, ...row }) => row);
}

/** The palette's no-results copy: says what was searched and what else to try (never a blank panel). */
export function paletteEmptyState(raw: string): { title: string; message: string } {
  const { mode, text } = parsePaletteQuery(raw);
  const shown = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  if (mode === 'commands') return text
    ? { title: `No commands match “${shown}”`, message: 'Try another word, or delete “>” to search chats, files and messages.' }
    : { title: 'No commands', message: 'Delete “>” to search chats, files and messages.' };
  return text
    ? { title: `No results for “${shown}”`, message: 'Try a file name, words from a message, or type > for commands.' }
    : { title: 'Nothing to show yet', message: 'Start a chat or add a folder. Type > for commands.' };
}
