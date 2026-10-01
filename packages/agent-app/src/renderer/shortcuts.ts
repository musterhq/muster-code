/**
 * Single-key shortcuts for the work surfaces (C3): the Inbox, task lists and threads, the Roster, Outputs, the Ledger and
 * Projects. Pure (no React, no DOM reads) so the rules are unit tested; WorkShortcuts.tsx listens and acts.
 *
 * They are on by default (Paperclip ships them off) and never fire while you are typing, while a dialog or menu is open, or
 * on the chat screen, where plain letters belong to the transcript and composer. The ⌘ shortcuts of the app menu are unchanged.
 *
 *   /  search            ?  this list           c  new task          [  toggle the sidebar   ]  toggle properties   u  undo the last Inbox action
 *   g i  Inbox   g d  Dashboard   g t  Tasks   g r  Roster   g o  Outputs   g l  Ledger   g p  Projects   g c  comment box
 *   j / k  next / previous row      Enter  open      Inbox rows: a or y dismiss, r mark read
 */
export type ShortcutAction =
  | 'new-task' | 'search' | 'cheatsheet' | 'toggle-sidebar'
  | 'go-inbox' | 'go-dashboard' | 'go-tasks' | 'go-roster' | 'go-outputs' | 'go-ledger' | 'go-projects' | 'focus-comment'
  | 'next-row' | 'prev-row' | 'toggle-properties' | 'undo';

export const CHORD_MS = 1200;
export const GO_KEYS: Record<string, ShortcutAction> = { i: 'go-inbox', d: 'go-dashboard', t: 'go-tasks', r: 'go-roster', o: 'go-outputs', l: 'go-ledger', p: 'go-projects', c: 'focus-comment' };

export interface ShortcutKey {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  isComposing?: boolean; repeat?: boolean; defaultPrevented?: boolean;
  /** The target is a text field, a select or an editable region. */
  typing: boolean;
  /** A dialog, menu or listbox is open. */
  blocked: boolean;
}
export interface ChordState { armedAt: number | null }
export const IDLE: ChordState = { armedAt: null };
export interface Resolved { action: ShortcutAction | null; next: ChordState; consume: boolean }

/** Screens where single keys apply. The chat screen is deliberately not one. */
export const shortcutScreens = ['hub', 'projects'] as const;
export const shortcutsApplyOn = (screen: string): boolean => (shortcutScreens as readonly string[]).includes(screen);

export function resolveShortcut(state: ChordState, e: ShortcutKey, now: number): Resolved {
  const none: Resolved = { action: null, next: IDLE, consume: false };
  if (e.defaultPrevented || e.isComposing || e.typing || e.blocked) return none;
  const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (!bare) return none;
  const armed = state.armedAt !== null && now - state.armedAt <= CHORD_MS;
  if (armed) {
    const action = GO_KEYS[e.key.toLowerCase()];
    if (action && !e.shiftKey) return { action, next: IDLE, consume: true };
    // Any other key ends the chord and then means what it normally means.
  }
  if (e.repeat) return none;
  if (e.key === 'g' && !e.shiftKey) return { action: null, next: { armedAt: now }, consume: true };
  if (e.key === '/' ) return { action: 'search', next: IDLE, consume: true };
  if (e.key === '?') return { action: 'cheatsheet', next: IDLE, consume: true };
  if (e.shiftKey) return none;
  if (e.key === 'c') return { action: 'new-task', next: IDLE, consume: true };
  if (e.key === '[') return { action: 'toggle-sidebar', next: IDLE, consume: true };
  if (e.key === ']') return { action: 'toggle-properties', next: IDLE, consume: true };
  if (e.key === 'u') return { action: 'undo', next: IDLE, consume: true };
  if (e.key === 'j') return { action: 'next-row', next: IDLE, consume: true };
  if (e.key === 'k') return { action: 'prev-row', next: IDLE, consume: true };
  return none;
}

/** Moves a position through `count` rows without wrapping; from nothing, j lands on the first row and k on the last. */
export function stepRow(count: number, index: number, action: 'next-row' | 'prev-row'): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return action === 'next-row' ? 0 : count - 1;
  return Math.min(Math.max(index + (action === 'next-row' ? 1 : -1), 0), count - 1);
}

export interface CheatEntry { keys: string[]; label: string; /** Keys pressed one after the other, not together. */ then?: boolean }
export interface CheatSection { title: string; entries: CheatEntry[] }
export const CHEATSHEET: readonly CheatSection[] = [
  { title: 'Anywhere in Inbox, Tasks, Projects and the Ledger', entries: [
    { keys: ['/'], label: 'Search the page, or the whole workspace' }, { keys: ['⌘K'], label: 'Command palette: tasks, agents, projects, files' }, { keys: ['c'], label: 'New task' },
    { keys: ['['], label: 'Show or hide the sidebar' }, { keys: [']'], label: 'Show or hide the properties of the open task' }, { keys: ['u'], label: 'Undo the last Inbox action (dismiss or mark read)' }, { keys: ['?'], label: 'This list' },
  ] },
  { title: 'Go to', entries: [
    { keys: ['g', 'i'], label: 'Inbox', then: true }, { keys: ['g', 'd'], label: 'Dashboard', then: true }, { keys: ['g', 't'], label: 'Tasks', then: true }, { keys: ['g', 'r'], label: 'Roster', then: true },
    { keys: ['g', 'o'], label: 'Outputs', then: true }, { keys: ['g', 'l'], label: 'Ledger', then: true }, { keys: ['g', 'p'], label: 'Projects', then: true }, { keys: ['g', 'c'], label: 'Comment box of the open task', then: true },
  ] },
  { title: 'Lists', entries: [{ keys: ['j'], label: 'Next row' }, { keys: ['k'], label: 'Previous row' }, { keys: ['Enter'], label: 'Open the row' }] },
  { title: 'Inbox', entries: [{ keys: ['a'], label: 'Dismiss the row' }, { keys: ['y'], label: 'Dismiss the row' }, { keys: ['r'], label: 'Mark the row read' }, { keys: ['U'], label: 'Mark the row unread' }, { keys: ['x'], label: 'Dismiss a decision (a row that needs you)' }] },
  { title: 'Command palette', entries: [{ keys: ['OSS-12'], label: 'Type a task key to jump to it' }, { keys: ['>'], label: 'Commands' }, { keys: ['in:docs'], label: 'Limit the search: tasks, agents, projects, docs, comments, outputs, decisions' }] },
];

export const SHORTCUTS_KEY = 'muster.shortcuts';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
/** On unless you turned them off. */
export function readShortcutsEnabled(storage: Store | undefined): boolean { try { return storage?.getItem(SHORTCUTS_KEY) !== 'off'; } catch { return true; } }
export function writeShortcutsEnabled(storage: Store | undefined, on: boolean): void { try { storage?.setItem(SHORTCUTS_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable: it stays as it was */ } }

// The preference as the app holds it: read once, kept here, and announced to whoever listens.
const prefListeners = new Set<() => void>();
let pref: boolean | null = null;
const browserStore = (): Store | undefined => { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } };
export const shortcutsEnabled = (): boolean => (pref ??= readShortcutsEnabled(browserStore()));
export function setShortcutsEnabled(on: boolean): void { pref = on; writeShortcutsEnabled(browserStore(), on); for (const l of prefListeners) l(); }
export function subscribeShortcutsPref(l: () => void): () => void { prefListeners.add(l); return () => { prefListeners.delete(l); }; }
