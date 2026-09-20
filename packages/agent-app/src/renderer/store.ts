import type {
  Chat,
  Commands,
  ChangedFile,
  ContextTelemetry,
  FileEntry,
  ProviderInfo,
  SkillEntry,
  MemoryEntry,
  Snapshot,
  TimelineItem,
} from '../shared/protocol';
import type {ScopedComputerRef} from '../shared/scoped-computer-protocol';
import {browserURL} from '../shared/browser-protocol';
import {filePresentation} from './components/filePresentation';
import { BridgeError, getBridge, invoke, subscribe } from './bridge';
import { focusComposer } from './focus';
import { TimelineReplica } from './timeline-replica';
import { MAX_TABS, readWorkspace, saveWorkspace } from './workspacePersistence';

export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface Loadable<T> {
  phase: LoadPhase;
  value?: T;
  error?: string;
}

export interface WorkspaceTab {
  id: string;
  kind: 'files' | 'changes' | 'file' | 'diff' | 'subagents' | 'browser' | 'computer' | 'processes';
  scope?:ScopedComputerRef;
  browserProfileId?: string;
  url?: string;
  folderId?: string;
  path?: string;
  title: string;
  line?: number;
  chatId?: string;
}

export interface Notice {
  id: number;
  message: string;
}

export type FileBody = {native?: boolean; text: string; truncated: boolean; asset?: Commands['files.asset']['output']; document?:Commands['files.document']['output']; workbook?:Commands['files.workbook']['output']};

export interface AppState {
  screen: 'work' | 'providers' | 'projects' | 'plugins' | 'memory';
  bridgeAvailable: boolean;
  boot: Loadable<true>;
  snapshot: Snapshot | null;
  activeChatId: string | null;
  timelines: Record<string, Loadable<TimelineItem[]>>;
  /** Latest context-window telemetry per chat; live events overwrite restored rows. */
  contextTelemetry: Record<string, ContextTelemetry>;
  /** In-flight sends keyed by chat id; cleared when the run event arrives or fails. */
  sending: Record<string, boolean>;
  composerDrafts: Record<string, { text: string; revision: number; error?: string }>;
  sendErrors: Record<string, string>;
  notices: Notice[];
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  providers: Loadable<ProviderInfo[]>;
  skills: Loadable<SkillEntry[]>;
  /** Revealed provider identities; entries expire via remask timers in the view. */
  revealed: Record<string, string>;
  files: Record<string, Loadable<FileEntry[]>>;
  fileBodies: Record<string, Loadable<FileBody>>;
  diffs: Record<string, Loadable<{ before: string; after: string; truncated: boolean }>>;
  gitChanges: Record<string, Loadable<ChangedFile[]>>;
  navWidth: number;
  resourcesHidden: boolean;
  navHidden: boolean;
  memory: Loadable<MemoryEntry[]>;
  memorySearch: string;
  memoryFolderId: string | undefined;
}

const NAV_KEY = 'muster.navWidth';
export const NAV_DEFAULT = 224;
export const NAV_MIN = 180;
export const NAV_MAX = 320;

const savedWorkspace = readWorkspace(localStorage);
let state: AppState = {
  screen: 'work',
  memory: {phase: 'idle'},
  memorySearch: '',
  memoryFolderId: undefined,
  bridgeAvailable: getBridge() !== null,
  boot: { phase: 'idle' },
  snapshot: null,
  activeChatId: null,
  timelines: {},
  contextTelemetry: {},
  sending: {},
  composerDrafts: {},
  sendErrors: {},
  notices: [],
  tabs: savedWorkspace.tabs,
  activeTabId: savedWorkspace.activeTabId,
  providers: { phase: 'idle' },
  skills: { phase: 'idle' },
  revealed: {},
  files: {},
  fileBodies: {},
  diffs: {},
  gitChanges: {},
  navHidden: localStorage.getItem('muster.navHidden')==='true',
  resourcesHidden: localStorage.getItem('muster.resourcesHidden')==='true' || (localStorage.getItem('muster.resourcesHidden')===null && savedWorkspace.tabs.length===0),
  navWidth: clampNav(Number(localStorage.getItem(NAV_KEY)) || NAV_DEFAULT),
};

// Keep a small warm cache while durable transcripts remain in SQLite. Open
// subagent resources and the selected chat are protected independently.
const timelineAccess = new Map<string, number>();
let timelineAccessSequence = 0;
const INACTIVE_TIMELINE_CACHE_LIMIT = 8;
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
  if ('timelines' in patch || 'activeChatId' in patch || 'tabs' in patch) {
    const protectedIds = new Set([state.activeChatId, ...state.tabs.map(tab=>tab.chatId), ...timelineReads.keys()]);
    const inactive = Object.keys(state.timelines).filter(id=>!protectedIds.has(id)).sort((a,b)=>(timelineAccess.get(b)??0)-(timelineAccess.get(a)??0));
    if (inactive.length > INACTIVE_TIMELINE_CACHE_LIMIT) {
      const timelines={...state.timelines};
      for(const id of inactive.slice(INACTIVE_TIMELINE_CACHE_LIMIT)) {delete timelines[id];timelineReplicas.delete(id);timelineAccess.delete(id);}
      state={...state,timelines};
    }
  }
  if ('tabs'  in patch || 'activeTabId' in patch) saveWorkspace(localStorage, {tabs:state.tabs, activeTabId:state.activeTabId});
  for (const l of listeners) l();
  if ('tabs' in patch && state.boot.phase === 'ready') syncResourceWatches();
}

export function notifyError(cause: unknown): void { pushNotice(errorText(cause)); }

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
let removeFocusRefresh: (()=>void) | undefined;
const timelineReplicas = new Map<string, TimelineReplica>();
const timelineReads = new Map<string, Promise<void>>();
function timelineReplica(chatId: string): TimelineReplica {
  let replica = timelineReplicas.get(chatId);
  if (!replica) { replica = new TimelineReplica(); timelineReplicas.set(chatId, replica); }
  return replica;
}
function publishTimeline(chatId: string): void {
  const value = timelineReplicas.get(chatId)?.value;
  if (value) set({timelines: {...state.timelines, [chatId]: {phase: 'ready', value: value.items}}});
}

export async function boot(): Promise<void> {
  if (!state.bridgeAvailable) {
    set({ boot: { phase: 'error', error: 'Agent runtime is not connected.' } });
    return;
  }
  set({ boot: { phase: 'loading' } });
  unsubscribe?.();
  removeFocusRefresh?.();
  let refreshingFocus = false;
  const refreshVisible = () => {
    for (const folderId of new Set(state.tabs.map(tab=>tab.folderId))) if(folderId) void refreshResources(folderId);
    // Main intentionally suppresses events for a hidden window. Reconcile its
    // durable state on focus rather than relying on another token arriving.
    if (refreshingFocus) return;
    refreshingFocus = true;
    void invoke('app.snapshot', undefined).then(snapshot => {
      applySnapshot(snapshot);
      if (state.activeChatId) return readTimeline(state.activeChatId);
    }).catch(cause => pushNotice(errorText(cause))).finally(() => { refreshingFocus = false; });
  };
  window.addEventListener('focus',refreshVisible);
  removeFocusRefresh = () => window.removeEventListener('focus',refreshVisible);
  unsubscribe = subscribe((event) => {
    if (event.type === 'snapshot') applySnapshot(event.snapshot);
    else if (event.type === 'fileMoved') remapFileTab(event.folderId, event.from, event.to);
    else if (event.type === 'workspaceChanged') void refreshResources(event.folderId);
    else if (event.type === 'chatSelected') void selectChat(event.chatId).then(()=>focusComposer());
    else if (event.type === 'timelinePatch') {
      // Unopened chats need no transcript allocation. Their sidebar status is
      // supplied by snapshots; selecting one fetches its durable baseline.
      if (event.chatId !== state.activeChatId && !state.timelines[event.chatId]) return;
      const replica = timelineReplica(event.chatId);
      replica.patch(event.patch);
      publishTimeline(event.chatId);
      if (replica.needsSnapshot) void readTimeline(event.chatId);
    } else if (event.type === 'timeline') {
      timelineReplicas.delete(event.chatId);
      set({
        timelines: {
          ...state.timelines,
          [event.chatId]: { phase: 'ready', value: event.items },
        },
      });
    } else if (event.type === 'contextTelemetry') {
      set({ contextTelemetry: { ...state.contextTelemetry, [event.chatId]: event.telemetry } });
    } else if (event.type === 'notice') pushNotice(event.message);
  });
  try {
    const snapshot = await invoke('app.snapshot', undefined);
    applySnapshot(snapshot);
    set({ boot: { phase: 'ready', value: true } });
    syncResourceWatches();
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
  set({ snapshot: { ...snapshot, chats: snapshot.chats.map(chat => {
    const draft = state.composerDrafts[chat.id];
    return draft ? { ...chat, draft: draft.text } : chat;
  }) }, activeChatId });
  if (activeChatId && !state.timelines[activeChatId]) void loadTimeline(activeChatId);
  if (activeChatId) void loadContextTelemetry(activeChatId);
}

export function activeChat(): Chat | null {
  return state.snapshot?.chats.find((c) => c.id === state.activeChatId) ?? null;
}

// ---------------------------------------------------------------------------
// Chats

export async function selectChat(id: string): Promise<void> {
  timelineAccess.set(id, ++timelineAccessSequence);
  set({ activeChatId: id, screen: 'work' });
  void loadContextTelemetry(id);
  await readTimeline(id, true);
}

const pendingContextTelemetry = new Set<string>();

/** Restore persisted telemetry once per chat; never clobbers a live update. */
async function loadContextTelemetry(id: string): Promise<void> {
  if (state.contextTelemetry[id] || pendingContextTelemetry.has(id)) return;
  pendingContextTelemetry.add(id);
  try {
    const telemetry = await invoke('chat.contextTelemetry', { id });
    if (!state.contextTelemetry[id]) set({ contextTelemetry: { ...state.contextTelemetry, [id]: telemetry } });
  } catch {
    // Unknown stays unavailable; retry on the next selection.
  } finally {
    pendingContextTelemetry.delete(id);
  }
}

async function readTimeline(id: string, select = false): Promise<void> {
  timelineAccess.set(id, ++timelineAccessSequence);
  const existing = timelineReads.get(id);
  if (existing) {
    await existing;
    if (select && state.activeChatId === id) await readTimeline(id, true);
    return;
  }
  if (!state.timelines[id]?.value) set({timelines: {...state.timelines, [id]: {phase: 'loading'}}});
  let succeeded = false;
  const task = (async () => {
    try {
      const snapshot = await invoke('chat.timeline', {id, select});
      timelineReplica(id).snapshot(snapshot);
      publishTimeline(id);
      succeeded = true;
    } catch (cause) {
      if (state.timelines[id]?.value) pushNotice(errorText(cause));
      else set({timelines: {...state.timelines, [id]: {phase: 'error', error: errorText(cause)}}});
    }
  })();
  timelineReads.set(id, task);
  try { await task; } finally { timelineReads.delete(id); }
  // Only a genuine missing revision schedules recovery; failed reads do not
  // create a retry loop. New events or the explicit Retry action can retry.
  if (succeeded && timelineReplicas.get(id)?.needsSnapshot) void readTimeline(id);
}

async function loadTimeline(id: string): Promise<void> {
  if (state.timelines[id]?.phase === 'ready') return;
  await readTimeline(id);
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
  patch: { title?: string; pinned?: boolean; archived?: boolean; draft?: string; mode?: Chat['mode']; model?: string },
): Promise<boolean> {
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
    return true;
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
    return false;
  }
}

export async function movePin(id: string, direction: 'up' | 'down'): Promise<void> {
  try {
    await invoke('chat.movePin', { id, direction });
  } catch (cause) {
    pushNotice(errorText(cause));
  }
}

const draftTimers = new Map<string, number>();
const draftWrites = new Map<string, Promise<boolean>>();

/** Local edit identity survives composer unmounts and delayed send replies. */
export function setComposerDraft(id: string, text: string): void {
  const previous = state.composerDrafts[id];
  set({
    composerDrafts: { ...state.composerDrafts, [id]: { text, revision: (previous?.revision ?? 0) + 1 } },
    snapshot: state.snapshot ? { ...state.snapshot, chats: state.snapshot.chats.map(chat => chat.id === id ? { ...chat, draft: text } : chat) } : null,
  });
  clearTimeout(draftTimers.get(id));
  draftTimers.set(id, window.setTimeout(() => void flushComposerDraft(id), 250));
}

/** Serialize saves per chat; a late save can never overwrite a newer edit. */
export function flushComposerDraft(id: string): Promise<boolean> {
  clearTimeout(draftTimers.get(id));
  draftTimers.delete(id);
  const writing = draftWrites.get(id);
  if (writing) return writing;
  const save = (async () => {
    let draft = state.composerDrafts[id];
    while (draft) {
      try {
        await invoke('chat.update', { id, draft: draft.text });
      } catch (cause) {
        if (state.composerDrafts[id]?.revision !== draft.revision) {
          draft = state.composerDrafts[id];
          continue;
        }
        set({ composerDrafts: { ...state.composerDrafts, [id]: { ...draft, error: errorText(cause) } } });
        return false;
      }
      if (state.composerDrafts[id]?.revision === draft.revision) {
        if (draft.error) set({ composerDrafts: { ...state.composerDrafts, [id]: { text: draft.text, revision: draft.revision } } });
        return true;
      }
      draft = state.composerDrafts[id];
    }
    return true;
  })();
  const result = save.finally(() => { draftWrites.delete(id); });
  draftWrites.set(id, result);
  return result;
}

/**
 * One pending request ID per chat/draft. A retry after an ambiguous IPC
 * failure reuses the same ID so the host can dedupe; a changed draft gets a
 * fresh ID. Cleared only on acknowledged success.
 */
const pendingSends: Record<string, { requestId: string; text: string }> = {};

export async function sendMessage(id: string, text: string): Promise<boolean> {
  if (state.sending[id] || !text.trim()) return false;
  const submittedDraft = state.composerDrafts[id];
  const pending = pendingSends[id];
  const requestId =
    pending && pending.text === text ? pending.requestId : crypto.randomUUID();
  pendingSends[id] = { requestId, text };
  const { [id]: _previousError, ...sendErrors } = state.sendErrors;
  set({ sending: { ...state.sending, [id]: true }, sendErrors });
  try {
    if (!(await flushComposerDraft(id))) throw new Error('Draft could not be saved. Retry after resolving the storage error.');
    await invoke('chat.send', { id, text, requestId });
    delete pendingSends[id];
    const currentDraft = state.composerDrafts[id];
    if (currentDraft === submittedDraft || (submittedDraft && currentDraft?.revision === submittedDraft.revision)) {
      setComposerDraft(id, '');
    }
    await flushComposerDraft(id);
    return true;
  } catch (cause) {
    set({ sendErrors: { ...state.sendErrors, [id]: errorText(cause) } });
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

export async function respondQuestion(id: string, answers: Record<string, {answers: string[]}>): Promise<boolean> {
  try {
    await invoke('question.respond', { id, answers });
    return true;
  } catch (cause) {
    pushNotice(errorText(cause));
    return false;
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

export function setResourcesHidden(hidden:boolean):void {
  set({resourcesHidden:hidden});
  try{localStorage.setItem('muster.resourcesHidden',String(hidden));}catch{}
}

export function openTab(tab: WorkspaceTab): void {
  const existing = state.tabs.find((t) => t.id === tab.id);
  if (!existing && state.tabs.length >= MAX_TABS) { pushNotice('Close a resource tab before opening another.'); return; }
  set({
    tabs: existing ? state.tabs.map(t=>t.id===tab.id?{...t,...tab}:t) : [...state.tabs, tab],
    activeTabId: tab.id,
    resourcesHidden: false,
  });
}

const closingBrowserTabs = new Set<string>();
export function closeTab(id: string): void {
  if (state.tabs.find(tab => tab.id === id)?.kind === 'browser') {
    if (closingBrowserTabs.has(id)) return;
    closingBrowserTabs.add(id);
    void invoke('browser.close', {owner:id}).then(() => removeTab(id)).catch(error => pushNotice(`Browser could not close. Its tab was kept so you can retry. ${error instanceof Error ? error.message : String(error)}`)).finally(() => closingBrowserTabs.delete(id));
    return;
  }
  removeTab(id);
}
function removeTab(id: string): void {
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

function remapFileTab(folderId: string, from: string, to: string): void {
  const oldId = `file:${folderId}:${from}`, newId = `file:${folderId}:${to}`;
  if (!state.tabs.some(tab => tab.id === oldId)) return;
  const alreadyOpen = state.tabs.some(tab => tab.id === newId);
  const tabs = state.tabs.flatMap(tab => tab.id !== oldId ? [tab] : alreadyOpen ? [] : [{...tab,id:newId,path:to,title:to.split('/').pop() || to}]);
  const {[oldId]: oldBody, ...fileBodies} = state.fileBodies;
  // Re-read the destination: the preview format may change with its extension.
  delete fileBodies[newId];
  set({tabs,fileBodies,activeTabId:state.activeTabId === oldId ? newId : state.activeTabId});
}

export function activateTab(id: string): void {
  if (!state.tabs.some(tab=>tab.id===id)) return;
  set({ activeTabId: id, resourcesHidden: false });
}

/** Lazily reconnect a restored tab; missing paths remain recoverable errors. */
export function hydrateTab(tab: WorkspaceTab): void {
  if (tab.kind === 'files' || tab.kind === 'changes') {
    if (!state.files[dirKey(tab.folderId!, '')]) void loadDir(tab.folderId!, '');
    if (!state.gitChanges[tab.folderId!]) void loadGitChanges(tab.folderId!);
  } else if (tab.kind === 'file' && !state.fileBodies[tab.id]) void openFile(tab.folderId!, tab.path!);
  else if (tab.kind === 'diff' && !state.diffs[tab.id]) void openDiff(tab.folderId!, tab.path!);
  else if (tab.kind === 'subagents' && tab.chatId && !state.timelines[tab.chatId]) void readTimeline(tab.chatId);
}

export function openFilesTab(folderId: string, folderName: string): void {
  openTab({ id: `files:${folderId}`, kind: 'files', folderId, title: folderName });
  void loadDir(folderId, '');
  void loadGitChanges(folderId);
}

export function openChangesTab(folderId: string, folderName: string): void {
  openTab({id:`changes:${folderId}`,kind:'changes',folderId,title:`Changes · ${folderName}`});
  void loadGitChanges(folderId);
}

export function openSubagentsTab(chatId: string, folderId: string | undefined, folderName: string): void {
  openTab({id:`subagents:${chatId}`, kind:'subagents', ...(folderId ? {folderId} : {}), chatId, title:`Subagents · ${folderName}`});
}

export function openComputerTab(scope:ScopedComputerRef,label:string):void {
  openTab({id:`computer:${scope.kind}:${scope.id}`,kind:'computer',scope,title:`Computer · ${label}`});
}
export function openProcessesTab(chatId:string,label:string):void {
  openTab({id:`processes:${chatId}`,kind:'processes',chatId,title:`Commands · ${label}`});
}

export function openBrowserTab(url = 'about:blank'): void {
  try { url = browserURL(url); } catch(error) { notifyError(error); return; }
  openTab({id:`browser:${crypto.randomUUID()}`,kind:'browser',browserProfileId:'personal',url,title:'Browser'});
}

export function openProvidersTab(): void {
  set({ screen: 'providers', revealed: {} });
  void loadProviders(true);
}
export function openProjectsScreen(): void { set({ screen: 'projects', revealed: {} }); }
export function closeSettings(): void { set({ screen: 'work', revealed: {} }); }

export function openPluginsScreen(): void {
  set({ screen: 'plugins', revealed: {} });
  void loadSkills();
}

export async function loadSkills(force = false): Promise<void> {
  if (state.skills.phase === 'loading') return;
  if (!force && state.skills.phase === 'ready') return;
  set({ skills: { phase: 'loading', value: state.skills.value } });
  try {
    const folderPaths = (state.snapshot?.folders ?? []).map(folder => folder.path);
    const value = await invoke('plugins.list', { folderPaths });
    set({ skills: { phase: 'ready', value } });
  } catch (cause) {
    set({ skills: { phase: 'error', error: errorText(cause) } });
  }
}

/** Scope is server-resolved: folderId comes from the active chat's folder, never a raw path. */
export function openMemoryScreen(folderId: string | undefined): void {
  set({ screen: 'memory', memoryFolderId: folderId, memorySearch: '' });
  void loadMemory();
}

let memoryRequest = 0;
export async function loadMemory(): Promise<void> {
  const ticket = ++memoryRequest, folderId = state.memoryFolderId;
  set({ memory: { phase: 'loading' } });
  try {
    const items = await invoke('memory.list', { folderId });
    if (ticket === memoryRequest && folderId === state.memoryFolderId) set({ memory: { phase: 'ready', value: items } });
  } catch (cause) {
    if (ticket === memoryRequest && folderId === state.memoryFolderId) set({ memory: { phase: 'error', error: errorText(cause) } });
  }
}
export function setMemorySearch(query: string): void { set({ memorySearch: query }); }
export async function runMemorySearch(): Promise<void> {
  const query = state.memorySearch.trim();
  if (!query) return loadMemory();
  const ticket = ++memoryRequest, folderId = state.memoryFolderId;
  set({ memory: { phase: 'loading' } });
  try {
    const items = await invoke('memory.search', { folderId, query });
    if (ticket === memoryRequest && folderId === state.memoryFolderId) set({ memory: { phase: 'ready', value: items } });
  } catch (cause) {
    if (ticket === memoryRequest && folderId === state.memoryFolderId) set({ memory: { phase: 'error', error: errorText(cause) } });
  }
}
/** Scope is captured with the form; never substitute a subsequently selected folder. */
export async function saveMemory(input: Commands['memory.add']['input']): Promise<void> {
  await invoke('memory.add', input);
  if (state.screen === 'memory' && state.memoryFolderId === input.folderId) {
    if (state.memorySearch.trim()) await runMemorySearch(); else await loadMemory();
  }
}

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

async function readFileBody(folderId: string, path: string): Promise<FileBody> {
  if (['document','workbook'].includes(filePresentation(path)) && await invoke('files.nativeAvailable',undefined).catch(()=>false)) return {native:true,text:'',truncated:false};
  if (filePresentation(path) === 'document') return {text:'',truncated:false,document:await invoke('files.document',{folderId,path})};
  if (filePresentation(path) === 'workbook') return {text:'',truncated:false,workbook:await invoke('files.workbook',{folderId,path})};
  if (filePresentation(path) === 'image') return {text: '', truncated: false, asset: await invoke('files.asset',{folderId,path})};
  return invoke('files.read',{folderId,path});
}

export async function openFile(folderId: string, path: string, line?: number): Promise<void> {
  const id = `file:${folderId}:${path}`;
  openTab({ id, kind: 'file', folderId, path, line, title: path.split('/').pop() ?? path });
  if (state.fileBodies[id]?.phase === 'ready' || state.fileBodies[id]?.phase === 'loading') return;
  set({ fileBodies: { ...state.fileBodies, [id]: { phase: 'loading' } } });
  try {
    const body = await readFileBody(folderId, path);
    if (!state.tabs.some(tab => tab.id === id)) return;
    // Keep at most one decoded-image payload cached; inactive image tabs reload on demand.
    const bodies = body.asset || body.document || body.workbook ? Object.fromEntries(Object.entries(state.fileBodies).filter(([key,value]) => key === id || !(value.value?.asset || value.value?.document || value.value?.workbook))) : state.fileBodies;
    set({
      fileBodies: {
        ...bodies,
        [id]: { phase: 'ready', value: body },
      },
    });
  } catch (cause) {
    set({
      fileBodies: { ...state.fileBodies, [id]: { phase: 'error', error: errorText(cause) } },
    });
  }
}

export async function loadGitChanges(folderId: string): Promise<void> {
  const previous = state.gitChanges[folderId];
  if (previous?.phase === 'loading') return;
  set({ gitChanges: { ...state.gitChanges, [folderId]: { phase: 'loading', value: previous?.value } } });
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

// Coalesce changes while a resource read is in flight. No polling loop, and
// inactive tabs retain only their reference so reopening fetches current data.
const refreshing = new Set<string>();
const refreshAgain = new Set<string>();
let watchedSignature = '';
function syncResourceWatches(): void {
  const folderIds = [...new Set(state.tabs.map(t=>t.folderId).filter((id): id is string=>Boolean(id)))].sort();
  const signature = folderIds.join(',');
  if (signature === watchedSignature) return;
  watchedSignature = signature;
  void invoke('workspace.watch', {folderIds}).catch(cause=>{watchedSignature='';pushNotice(errorText(cause));});
}

async function refreshResources(folderId: string): Promise<void> {
  if (!state.tabs.some(tab=>tab.folderId===folderId)) return;
  if (refreshing.has(folderId)) { refreshAgain.add(folderId); return; }
  refreshing.add(folderId);
  try {
    do {
      refreshAgain.delete(folderId);
      const active = state.tabs.find(tab=>tab.id===state.activeTabId && tab.folderId===folderId);
      const tabIds = new Set(state.tabs.filter(tab=>tab.folderId===folderId).map(tab=>tab.id));
      const fileBodies = Object.fromEntries(Object.entries(state.fileBodies).filter(([id])=>!tabIds.has(id)||id===active?.id));
      const diffs = Object.fromEntries(Object.entries(state.diffs).filter(([id])=>!tabIds.has(id)||id===active?.id));
      const files = active?.kind === 'files' ? state.files : Object.fromEntries(Object.entries(state.files).filter(([key])=>!key.startsWith(folderId+'\0')));
      const {[folderId]: stale, ...otherGitChanges} = state.gitChanges;
      set({fileBodies,diffs,files,gitChanges:active?.kind==='files'?state.gitChanges:otherGitChanges});
      if (!active) continue;
      if(active.kind==='changes'){await loadGitChanges(folderId);continue;}
      if (active.kind === 'files') { const paths=[...new Set(['',...Object.keys(files).filter(key=>key.startsWith(folderId+'\0')).map(key=>key.slice(folderId.length+1))])].slice(0,64); await Promise.all([...paths.map(path=>loadDir(folderId,path)),loadGitChanges(folderId)]); continue; }
      try {
        if (active.kind === 'file') {
          const value = await readFileBody(folderId,active.path!);
          if (state.tabs.some(tab=>tab.id===active.id)) set({fileBodies:{...state.fileBodies,[active.id]:{phase:'ready',value}}});
        } else {
          const value = await invoke('git.diff',{folderId,path:active.path!});
          if (state.tabs.some(tab=>tab.id===active.id)) set({diffs:{...state.diffs,[active.id]:{phase:'ready',value}}});
        }
      } catch(cause) {
        if (state.tabs.some(tab=>tab.id===active.id)) {
          const key = active.kind === 'file' ? 'fileBodies' : 'diffs';
          set({[key]:{...state[key],[active.id]:{phase:'error',error:errorText(cause)}}});
        }
      }
    } while (refreshAgain.has(folderId));
  } finally { refreshing.delete(folderId); refreshAgain.delete(folderId); }
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

/** Hiding navigation preserves its width, selection and draft state. */
export function setNavHidden(hidden:boolean):void {
 set({navHidden:hidden});
 try{localStorage.setItem('muster.navHidden',String(hidden));}catch{}
}
