import type {
  Chat,
  ChangedFile,
  FileEntry,
  ProviderInfo,
  Snapshot,
  TimelineItem,
} from '../shared/protocol';
import { BridgeError, getBridge, invoke, subscribe } from './bridge';
import { MAX_TABS, readWorkspace, saveWorkspace } from './workspacePersistence';

export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface Loadable<T> {
  phase: LoadPhase;
  value?: T;
  error?: string;
}

export interface WorkspaceTab {
  id: string;
  kind: 'files' | 'file' | 'diff';
  folderId?: string;
  path?: string;
  title: string;
}

export interface Notice {
  id: number;
  message: string;
}

export interface AppState {
  screen: 'work' | 'providers' | 'projects';
  bridgeAvailable: boolean;
  boot: Loadable<true>;
  snapshot: Snapshot | null;
  activeChatId: string | null;
  timelines: Record<string, Loadable<TimelineItem[]>>;
  /** In-flight sends keyed by chat id; cleared when the run event arrives or fails. */
  sending: Record<string, boolean>;
  notices: Notice[];
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  providers: Loadable<ProviderInfo[]>;
  /** Revealed provider identities; entries expire via remask timers in the view. */
  revealed: Record<string, string>;
  files: Record<string, Loadable<FileEntry[]>>;
  fileBodies: Record<string, Loadable<{ text: string; truncated: boolean }>>;
  diffs: Record<string, Loadable<{ before: string; after: string; truncated: boolean }>>;
  gitChanges: Record<string, Loadable<ChangedFile[]>>;
  navWidth: number;
}

const NAV_KEY = 'muster.navWidth';
export const NAV_DEFAULT = 224;
export const NAV_MIN = 180;
export const NAV_MAX = 320;

const savedWorkspace = readWorkspace(localStorage);
let state: AppState = {
  screen: 'work',
  bridgeAvailable: getBridge() !== null,
  boot: { phase: 'idle' },
  snapshot: null,
  activeChatId: null,
  timelines: {},
  sending: {},
  notices: [],
  tabs: savedWorkspace.tabs,
  activeTabId: savedWorkspace.activeTabId,
  providers: { phase: 'idle' },
  revealed: {},
  files: {},
  fileBodies: {},
  diffs: {},
  gitChanges: {},
  navWidth: clampNav(Number(localStorage.getItem(NAV_KEY)) || NAV_DEFAULT),
};

const listeners = new Set<() => void>();
let noticeSeq = 0;

export function clampNav(width: number): number {
  return Math.min(NAV_MAX, Math.max(NAV_MIN, Math.round(width)));
}

export function getState(): AppState {
  return state;
}

export function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  if ('tabs' in patch || 'activeTabId' in patch) saveWorkspace(localStorage, {tabs:state.tabs, activeTabId:state.activeTabId});
  for (const l of listeners) l();
}

function pushNotice(message: string): void {
  const notice = { id: ++noticeSeq, message };
  set({ notices: [...state.notices, notice] });
  setTimeout(() => {
    set({ notices: state.notices.filter((n) => n.id !== notice.id) });
  }, 6000);
}

export function dismissNotice(id: number): void {
  set({ notices: state.notices.filter((n) => n.id !== id) });
}

function errorText(cause: unknown): string {
  return cause instanceof BridgeError
    ? `${cause.command}: ${cause.message}`
    : cause instanceof Error
      ? cause.message
      : String(cause);
}

// ---------------------------------------------------------------------------
// Boot & events

let unsubscribe: (() => void) | null = null;

export async function boot(): Promise<void> {
  if (!state.bridgeAvailable) {
    set({ boot: { phase: 'error', error: 'Agent runtime is not connected.' } });
    return;
  }
  set({ boot: { phase: 'loading' } });
  unsubscribe?.();
  unsubscribe = subscribe((event) => {
    if (event.type === 'snapshot') applySnapshot(event.snapshot);
    else if (event.type === 'timeline') {
      set({
        timelines: {
          ...state.timelines,
          [event.chatId]: { phase: 'ready', value: event.items },
        },
      });
    } else if (event.type === 'notice') pushNotice(event.message);
  });
  try {
    const snapshot = await invoke('app.snapshot', undefined);
    applySnapshot(snapshot);
    set({ boot: { phase: 'ready', value: true } });
    if (state.activeChatId) void loadTimeline(state.activeChatId);
  } catch (cause) {
    set({ boot: { phase: 'error', error: errorText(cause) } });
  }
}

function applySnapshot(snapshot: Snapshot): void {
  // Snapshots are authoritative for chats/folders/projects. The active chat is
  // ours once the user picked one; only adopt the host's suggestion initially.
  const activeChatId =
    state.activeChatId && snapshot.chats.some((c) => c.id === state.activeChatId)
      ? state.activeChatId
      : (snapshot.activeChatId ?? snapshot.chats.find((c) => !c.archived)?.id ?? null);
  set({ snapshot, activeChatId });
  if (activeChatId && !state.timelines[activeChatId]) void loadTimeline(activeChatId);
}

export function activeChat(): Chat | null {
  return state.snapshot?.chats.find((c) => c.id === state.activeChatId) ?? null;
}

// ---------------------------------------------------------------------------
// Chats

export async function selectChat(id: string): Promise<void> {
  set({ activeChatId: id, screen: 'work' });
  const cached = state.timelines[id];
  if (cached?.phase === 'ready') {
    // Cached view renders immediately, but the host must still learn the
    // active chat (persistence + active ID would diverge otherwise). Refresh
    // the cache from the authoritative response; keep cache on failure.
    try {
      const items = await invoke('chat.select', { id });
      set({ timelines: { ...state.timelines, [id]: { phase: 'ready', value: items } } });
    } catch (cause) {
      pushNotice(errorText(cause));
    }
    return;
  }
  await loadTimeline(id);
}

async function loadTimeline(id: string): Promise<void> {
  const cached = state.timelines[id];
  if (cached?.phase === 'ready' || cached?.phase === 'loading') return;
  set({ timelines: { ...state.timelines, [id]: { phase: 'loading' } } });
  try {
    const items = await invoke('chat.select', { id });
    set({ timelines: { ...state.timelines, [id]: { phase: 'ready', value: items } } });
  } catch (cause) {
    set({
      timelines: { ...state.timelines, [id]: { phase: 'error', error: errorText(cause) } },
    });
  }
}

export function retryTimeline(id: string): void {
  set({ timelines: { ...state.timelines, [id]: { phase: 'idle' } } });
  void loadTimeline(id);
}

export async function createChat(folderId?: string, projectId?: string): Promise<void> {
  try {
    const chat = await invoke('chat.create', { folderId, projectId });
    set({ activeChatId: chat.id, screen: 'work' });
    await loadTimeline(chat.id);
  } catch (cause) {
    pushNotice(errorText(cause));
  }
}

export async function updateChat(
  id: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean; draft?: string; mode?: Chat['mode'] },
): Promise<void> {
  // Optimistic local apply so pin/rename/archive feel immediate; the returned
  // chat (and subsequent snapshots) reconcile. On failure, restore the prior
  // chat so the UI does not show unpersisted state.
  const prior = state.snapshot?.chats.find((c) => c.id === id);
  if (state.snapshot && prior) {
    set({
      snapshot: {
        ...state.snapshot,
        chats: state.snapshot.chats.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    });
  }
  try {
    await invoke('chat.update', { id, ...patch });
  } catch (cause) {
    if (state.snapshot && prior) {
      set({
        snapshot: {
          ...state.snapshot,
          chats: state.snapshot.chats.map((c) => (c.id === id ? prior : c)),
        },
      });
    }
    pushNotice(errorText(cause));
  }
}

/**
 * One pending request ID per chat/draft. A retry after an ambiguous IPC
 * failure reuses the same ID so the host can dedupe; a changed draft gets a
 * fresh ID. Cleared only on acknowledged success.
 */
const pendingSends: Record<string, { requestId: string; text: string }> = {};

export async function sendMessage(id: string, text: string): Promise<boolean> {
  if (state.sending[id]) return false;
  const pending = pendingSends[id];
  const requestId =
    pending && pending.text === text ? pending.requestId : crypto.randomUUID();
  pendingSends[id] = { requestId, text };
  set({ sending: { ...state.sending, [id]: true } });
  try {
    await invoke('chat.send', { id, text, requestId });
    delete pendingSends[id];
    return true;
  } catch (cause) {
    pushNotice(errorText(cause));
    return false;
  } finally {
    const { [id]: _done, ...rest } = state.sending;
    set({ sending: rest });
  }
}

export async function stopChat(id: string): Promise<void> {
  try {
    await invoke('chat.stop', { id });
  } catch (cause) {
    pushNotice(errorText(cause));
  }
}

export async function respondApproval(id: string, approved: boolean): Promise<void> {
  try {
    await invoke('approval.respond', { id, approved });
  } catch (cause) {
    pushNotice(errorText(cause));
  }
}

// ---------------------------------------------------------------------------
// Folders & projects

export async function pickFolder(): Promise<void> {
  try {
    await invoke('folder.pick', undefined);
    // Host emits a snapshot event with the new folder; nothing else to do.
  } catch (cause) {
    pushNotice(errorText(cause));
  }
}

// ---------------------------------------------------------------------------
// Workspace tabs

export function openTab(tab: WorkspaceTab): void {
  const existing = state.tabs.find((t) => t.id === tab.id);
  if (!existing && state.tabs.length >= MAX_TABS) { pushNotice('Close a resource tab before opening another.'); return; }
  set({
    tabs: existing ? state.tabs : [...state.tabs, tab],
    activeTabId: tab.id,
  });
}

export function closeTab(id: string): void {
  const index = state.tabs.findIndex(t=>t.id===id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  const { [id]: _body, ...fileBodies } = state.fileBodies;
  const { [id]: _diff, ...diffs } = state.diffs;
  set({
    tabs,
    fileBodies,
    diffs,
    activeTabId:
      state.activeTabId === id ? (tabs[Math.min(index,tabs.length-1)]?.id ?? null) : state.activeTabId,
  });
}

export function activateTab(id: string): void {
  if (!state.tabs.some(tab=>tab.id===id)) return;
  set({ activeTabId: id });
}

/** Lazily reconnect a restored tab; missing paths remain recoverable errors. */
export function hydrateTab(tab: WorkspaceTab): void {
  if (tab.kind === 'files') {
    if (!state.files[dirKey(tab.folderId!, '')]) void loadDir(tab.folderId!, '');
    if (!state.gitChanges[tab.folderId!]) void loadGitChanges(tab.folderId!);
  } else if (tab.kind === 'file' && !state.fileBodies[tab.id]) void openFile(tab.folderId!, tab.path!);
  else if (tab.kind === 'diff' && !state.diffs[tab.id]) void openDiff(tab.folderId!, tab.path!);
}

export function openFilesTab(folderId: string, folderName: string): void {
  openTab({ id: `files:${folderId}`, kind: 'files', folderId, title: folderName });
  void loadDir(folderId, '');
  void loadGitChanges(folderId);
}

export function openProvidersTab(): void {
  set({ screen: 'providers', revealed: {} });
  void loadProviders(true);
}
export function openProjectsScreen(): void { set({ screen: 'projects', revealed: {} }); }
export function closeSettings(): void { set({ screen: 'work', revealed: {} }); }

export function dirKey(folderId: string, path: string): string {
  return `${folderId}\u0000${path}`;
}

export async function loadDir(folderId: string, path: string): Promise<void> {
  const key = dirKey(folderId, path);
  const cached = state.files[key];
  if (cached?.phase === 'loading') return;
  set({ files: { ...state.files, [key]: { phase: 'loading', value: cached?.value } } });
  try {
    const entries = await invoke('files.list', { folderId, path: path || undefined });
    set({ files: { ...state.files, [key]: { phase: 'ready', value: entries } } });
  } catch (cause) {
    set({ files: { ...state.files, [key]: { phase: 'error', error: errorText(cause) } } });
  }
}

export async function openFile(folderId: string, path: string): Promise<void> {
  const id = `file:${folderId}:${path}`;
  openTab({ id, kind: 'file', folderId, path, title: path.split('/').pop() ?? path });
  if (state.fileBodies[id]?.phase === 'ready' || state.fileBodies[id]?.phase === 'loading') return;
  set({ fileBodies: { ...state.fileBodies, [id]: { phase: 'loading' } } });
  try {
    const body = await invoke('files.read', { folderId, path });
    set({
      fileBodies: {
        ...state.fileBodies,
        [id]: { phase: 'ready', value: { text: body.text, truncated: body.truncated } },
      },
    });
  } catch (cause) {
    set({
      fileBodies: { ...state.fileBodies, [id]: { phase: 'error', error: errorText(cause) } },
    });
  }
}

export async function loadGitChanges(folderId: string): Promise<void> {
  set({ gitChanges: { ...state.gitChanges, [folderId]: { phase: 'loading' } } });
  try {
    const changes = await invoke('git.changes', { folderId });
    set({ gitChanges: { ...state.gitChanges, [folderId]: { phase: 'ready', value: changes } } });
  } catch (cause) {
    set({
      gitChanges: { ...state.gitChanges, [folderId]: { phase: 'error', error: errorText(cause) } },
    });
  }
}

export async function openDiff(folderId: string, path: string): Promise<void> {
  const id = `diff:${folderId}:${path}`;
  openTab({ id, kind: 'diff', folderId, path, title: `Diff: ${path.split('/').pop() ?? path}` });
  set({ diffs: { ...state.diffs, [id]: { phase: 'loading' } } });
  try {
    const diff = await invoke('git.diff', { folderId, path });
    set({
      diffs: {
        ...state.diffs,
        [id]: {
          phase: 'ready',
          value: { before: diff.before, after: diff.after, truncated: diff.truncated },
        },
      },
    });
  } catch (cause) {
    set({ diffs: { ...state.diffs, [id]: { phase: 'error', error: errorText(cause) } } });
  }
}

// ---------------------------------------------------------------------------
// Providers

export async function loadProviders(force = false): Promise<void> {
  if (state.providers.phase === 'loading') return;
  if (!force && state.providers.phase === 'ready') return;
  set({ providers: { phase: 'loading', value: state.providers.value } });
  try {
    const providers = await invoke('providers.list', undefined);
    set({ providers: { phase: 'ready', value: providers } });
  } catch (cause) {
    set({ providers: { phase: 'error', error: errorText(cause) } });
  }
}

export async function revealProvider(id: string): Promise<void> {
  try {
    const { identity } = await invoke('providers.reveal', { id });
    if (!identity) {
      pushNotice('Provider identity is unavailable.');
      return;
    }
    set({ revealed: { ...state.revealed, [id]: identity } });
  } catch (cause) {
    pushNotice(errorText(cause));
  }
}

export function remaskProvider(id: string): void {
  if (!(id in state.revealed)) return;
  const { [id]: _gone, ...rest } = state.revealed;
  set({ revealed: rest });
}

// ---------------------------------------------------------------------------
// Layout

export function setNavWidth(width: number): void {
  const navWidth = clampNav(width);
  if (navWidth === state.navWidth) return;
  set({ navWidth });
}

export function persistNavWidth(): void {
  localStorage.setItem(NAV_KEY, String(state.navWidth));
}
