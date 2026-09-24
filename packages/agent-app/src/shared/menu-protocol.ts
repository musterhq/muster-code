/** Native menu → renderer channel. Separate from the command bridge so the
 *  menu can never invoke runtime commands; it only names a UI intent. */
export type ChatSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type MenuAction =
  | 'new-chat' | 'settings' | 'toggle-sidebar' | 'toggle-resources' | 'toggle-summary'
  | 'search-chats' | 'command-palette' | 'find-in-chat' | 'focus-composer' | 'close-tab' | 'back' | 'forward' | 'open-terminal'
  | 'rename-chat' | 'mark-unread' | 'pin-chat' | 'snooze-chat' | 'archive-chat' | 'copy-link' | 'next-chat' | 'prev-chat'
  | `chat-${ChatSlot}`;

export const MENU_CHANNEL = 'muster:menu';
export const MENU_CLOSE_CHANNEL = 'muster:menu-close-window';

export const MENU_ACTIONS: readonly MenuAction[] = [
  'new-chat', 'settings', 'toggle-sidebar', 'toggle-resources', 'toggle-summary', 'search-chats', 'command-palette', 'find-in-chat', 'focus-composer',
  'close-tab', 'back', 'forward', 'open-terminal', 'rename-chat', 'mark-unread', 'pin-chat', 'snooze-chat', 'archive-chat', 'copy-link',
  'next-chat', 'prev-chat', 'chat-1', 'chat-2', 'chat-3', 'chat-4', 'chat-5', 'chat-6', 'chat-7', 'chat-8', 'chat-9',
];

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && (MENU_ACTIONS as readonly string[]).includes(value);
}

/** Cmd+1…9 → slot; null for every other action. */
export function chatSlot(action: MenuAction): ChatSlot | null {
  const match = /^chat-([1-9])$/.exec(action);
  return match ? (Number(match[1]) as ChatSlot) : null;
}

export interface MenuBridge {
  onAction(listener: (action: MenuAction) => void): () => void;
  /** Cmd+W with nothing left to close: main runs the normal close path (hide on macOS). */
  closeWindow(): void;
}

declare global { interface Window { musterMenu?: MenuBridge } }
