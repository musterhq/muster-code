import type {
  ApprovalDecision,
  Chat,
  FollowUpMode,
  Commands,
  ChangedFile,
  ContextTelemetry,
  FileEntry,
  Folder,
  ProviderInfo,
  SkillEntry,
  PluginEntry,
  ReasoningEffort,
  MemoryEntry,
  Snapshot,
  TimelineItem,
} from '../shared/protocol';
import type {ScopedComputerRef} from '../shared/scoped-computer-protocol';
import {SETTING_DEFAULTS,normalizeSettings,type AppSettings,type SettingKey} from '../shared/domains/settings-protocol';
import {browserURL} from '../shared/browser-protocol';
import type {AutomationView} from '../shared/domains/automations-protocol';
import {filePresentation} from './components/filePresentation';
import {cleanIpcError, isNotGitRepository} from './components/resourceErrors';
import { BridgeError, getBridge, invoke, subscribe } from './bridge';
import { runtimeMessage } from './composerBridge';
import { focusComposer } from './focus';
import { killChatTerminals } from './processSummary';
import { TimelineReplica } from './timeline-replica';
import { recordTransport } from './connectionHealth';
import { MAX_TABS, readWorkspace, saveWorkspace } from './workspacePersistence';
import { showHiddenFiles, writeShowHiddenFiles } from './fileTreePrefs';

export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface Loadable<T> {
  phase: LoadPhase;
  value?: T;
  error?: string;
}

export interface WorkspaceTab {
  id: string;
  /** 'git' is the one Git surface per folder (Changes · History · Pull request). The older 'changes', 'history' and
   *  'pullRequest' kinds are only read from saved workspaces and are mapped onto 'git' on restore. */
  kind: 'files' | 'git' | 'changes' | 'file' | 'diff' | 'subagents' | 'browser' | 'computer' | 'processes' | 'attachment' | 'pullRequest' | 'history' | 'conflict' | 'canvas' | 'sideChat' | 'pluginUi' | 'inbox';
  /** kind: 'git' only — which segment is showing. */
  gitView?: GitView;
  /** kind: 'canvas' only (WRK-12). */
  canvasId?: string;
  /** kind: 'pluginUi' only (EXT-10): the plugin (its folder id) and the app it declares. */
  pluginId?: string;
  appName?: string;
  scope?:ScopedComputerRef;
  /** kind: 'git' (History) — a commit to select when the view opens (a blame gutter click). */
  sha?: string;
  browserProfileId?: string;
  url?: string;
  folderId?: string;
  path?: string;
  title: string;
  line?: number;
  chatId?: string;
  /** kind: 'attachment' only — the id staged/sent under this chat; `path` carries its file name (reused for icon/extension lookups). */
  attachmentId?: string;
  /** kind: 'git' (Pull request) — the PR number; absent for the "Create pull request" form. */
  prNumber?: number;
  /** A single click in the tree opens or replaces this one italic tab; a double-click, an edit or a pin makes it permanent. */
  preview?: boolean;
  /** Pinned tabs sort first and are excluded from "Close others"/"Close to the right" targets that would close them. */
  pinned?: boolean;
}

export type GitView = 'changes' | 'history' | 'pullRequest';

export type NoticeKind = 'success' | 'error' | 'info';
export interface NoticeAction { label: string; run: () => unknown }
/** Errors stay until dismissed; identical ones coalesce into one row with a count. */
export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
  count: number;
  action?: NoticeAction;
}
export type SettingsSection = 'general' | 'appearance' | 'chat' | 'providers' | 'models' | 'memory' | 'plugins' | 'environments' | 'automations' | 'shortcuts' | 'diagnostics' | 'storage';

export type FileBody = {native?: boolean; text: string; truncated: boolean; revision?: string; encodingWarning?: boolean; asset?: Commands['files.asset']['output']; document?:Commands['files.document']['output']; workbook?:Commands['files.workbook']['output']};

export interface AppState {
  /** Settings › Chat "Follow-up behavior": what Enter does while a turn runs (this Mac). */
  followUpMode: FollowUpMode;
  screen: 'work' | 'providers' | 'projects' | 'plugins' | 'memory' | 'settings' | 'automations';
  /** Scheduled agent work; kept live by `automationsChanged` events once loaded. */
  automations: Loadable<AutomationView[]>;
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
  /** Stable identity for this chat's independent resource tab set. */
  workspaceScope: string;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** File tabs with unsaved edits; closing one asks for confirmation. */
  dirtyTabs: Record<string, boolean>;
  providers: Loadable<ProviderInfo[]>;
  skills: Loadable<SkillEntry[]>;
  plugins: Loadable<PluginEntry[]>;
  pluginView: 'skills'|'plugins';
  /** Revealed provider identities; entries expire via remask timers in the view. */
  revealed: Record<string, string>;
  files: Record<string, Loadable<FileEntry[]>>;
  fileBodies: Record<string, Loadable<FileBody>>;
  diffs: Record<string, Loadable<{ before: string; after: string; truncated: boolean }>>;
  gitChanges: Record<string, Loadable<ChangedFile[]>>;
  navWidth: number;
  resourcesHidden: boolean;
  rightPaneMode: 'resources' | 'activity';
  showInlineFileDiffs: boolean;
  /** User choice for the floating right-side summary card (Codex-style). */
  summaryHidden: boolean;
  /** How the always-present summary card sits over the conversation, picked from the centre column's width:
   *  'float' fits in the side margin, 'reserve' gives the transcript a right gutter, 'overlay' is a compact card
   *  over the transcript's right margin (collapsible to a pill). Only `summaryHidden` ever hides it. */
  summaryLayout: 'float' | 'reserve' | 'overlay';
  navHidden: boolean;
  memory: Loadable<MemoryEntry[]>;
  memorySearch: string;
  memoryFolderId: string | undefined;
  /** Runtime-persisted preferences (dataDir/settings.json), cached locally for first paint. */
  settings: AppSettings;
  settingsSection: SettingsSection;
}

const NAV_KEY = 'muster.navWidth';
const SETTINGS_CACHE = 'muster.settings.v1';
/** Last known runtime settings, so text size and overrides apply before the bridge answers. */
function cachedSettings(): AppSettings {
  try {
    const cached = localStorage.getItem(SETTINGS_CACHE);
    if (cached) return normalizeSettings(JSON.parse(cached));
    return {...SETTING_DEFAULTS, 'chat.inlineDiffs': localStorage.getItem('muster.showInlineFileDiffs') !== 'false'};
  } catch { return SETTING_DEFAULTS; }
}
const initialSettings = cachedSettings();
let settingsCacheMissing = true;
try { settingsCacheMissing = !localStorage.getItem(SETTINGS_CACHE); } catch {}
/** Guards every module-scope localStorage read so importing this module never throws where storage is unavailable (private windows, tests). */
function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export const NAV_DEFAULT = 224;
export const NAV_MIN = 180;
export const NAV_MAX = 320;

function workspaceScope(snapshot: Snapshot | null, chatId: string | null, prior?: string): string {
  if (!chatId) return 'personal';
  const chat = snapshot?.chats.find(candidate => candidate.id === chatId);
  // F44: a snapshot that momentarily lacks the active chat (a stop/recovery transition) must not swap
  // its resource tabs for an empty scope — that collapsed Terminal + Browser mid-run.
  if (!chat && prior?.startsWith(`chat:${chatId}|`)) return prior;
  return chat
    ? `chat:${chat.id}|project:${chat.projectId ?? ''}|folder:${chat.folderId ?? ''}`
    : `chat:${chatId}`;
}

let state: AppState = {
  followUpMode: readFollowUpMode(),
  screen: 'work',
  automations: {phase: 'idle'},
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
  // Resource tabs are restored only after the host identifies the active
  // chat. Never paint a previous chat's files while boot is resolving.
  tabs: [],
  activeTabId: null,
  dirtyTabs: {},
  workspaceScope: 'personal',
  providers: { phase: 'idle' },
  skills: { phase: 'idle' },
  plugins: { phase: 'idle' },
  pluginView: 'skills',
  revealed: {},
  files: {},
  fileBodies: {},
  diffs: {},
  gitChanges: {},
  navHidden: readLocal('muster.navHidden')==='true',
  resourcesHidden: readLocal('muster.resourcesHidden')==='true' || readLocal('muster.resourcesHidden')===null,
  rightPaneMode: readLocal('muster.rightPaneMode')==='activity' ? 'activity' : 'resources',
  showInlineFileDiffs: initialSettings['chat.inlineDiffs'],
  settings: initialSettings,
  settingsSection: 'general',
  summaryHidden: readLocal('muster.summaryHidden')==='true',
  summaryLayout: 'float',
  navWidth: clampNav(Number(readLocal(NAV_KEY)) || NAV_DEFAULT),
};

// Keep a small warm cache while durable transcripts remain in SQLite. Open
// subagent resources and the selected chat are protected independently.
const timelineAccess = new Map<string, number>();
let timelineAccessSequence = 0;
// Each cached transcript holds full tool output; 3 keeps chat switching instant without unbounded renderer growth.
const INACTIVE_TIMELINE_CACHE_LIMIT = 3;
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
  const priorScope = state.workspaceScope;
  const nextState = { ...state, ...patch };
  const nextScope = workspaceScope(nextState.snapshot, nextState.activeChatId, priorScope);
  const scopeChanged = priorScope !== nextScope;
  if (scopeChanged) {
    saveWorkspace(localStorage, {tabs:state.tabs,activeTabId:state.activeTabId}, priorScope);
    const restored = readWorkspace(localStorage, nextScope);
    nextState.tabs = restored.tabs;
    nextState.activeTabId = restored.activeTabId;
    nextState.workspaceScope = nextScope;
    nextState.fileBodies = {};
    nextState.diffs = {};
    if (state.boot.phase === 'idle' && localStorage.getItem('muster.resourcesHidden') === null && restored.tabs.length > 0) {
      nextState.resourcesHidden = false;
    }
  }
  state = nextState;
  if ('timelines' in patch || 'activeChatId' in patch || 'tabs' in patch) {
    const protectedIds = new Set([state.activeChatId, ...state.tabs.map(tab=>tab.chatId), ...timelineReads.keys()]);
    const inactive = Object.keys(state.timelines).filter(id=>!protectedIds.has(id)).sort((a,b)=>(timelineAccess.get(b)??0)-(timelineAccess.get(a)??0));
    if (inactive.length > INACTIVE_TIMELINE_CACHE_LIMIT) {
      const timelines={...state.timelines};
      for(const id of inactive.slice(INACTIVE_TIMELINE_CACHE_LIMIT)) {delete timelines[id];timelineReplicas.delete(id);timelineAccess.delete(id);}
      state={...state,timelines};
    }
  }
  if ('tabs' in patch || 'activeTabId' in patch) saveWorkspace(localStorage, {tabs:state.tabs, activeTabId:state.activeTabId}, state.workspaceScope);
  for (const l of listeners) l();
  if (('tabs' in patch || scopeChanged) && state.boot.phase === 'ready') syncResourceWatches();
}

/** `retry` adds a Retry action that re-runs the failed operation. */
export function notifyError(cause: unknown, retry?: () => unknown): void { pushNotice(errorText(cause), {kind:'error', ...(retry ? {action:{label:'Retry', run:retry}} : {})}); }
export function notifySuccess(message: string, action?: NoticeAction): void { pushNotice(message, {kind:'success', ...(action ? {action} : {})}); }

const MAX_NOTICES = 4;
const noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();
let noticesHeld = false;
/** Success confirms briefly (longer when it offers Undo); errors persist until dismissed. */
export function noticeLifetime(notice: Pick<Notice, 'kind' | 'action'>): number | null {
  return notice.kind === 'error' ? null : notice.kind === 'success' && !notice.action ? 4000 : 6000;
}
function scheduleNotice(notice: Notice): void {
  clearTimeout(noticeTimers.get(notice.id));
  noticeTimers.delete(notice.id);
  const lifetime = noticeLifetime(notice);
  if (lifetime === null || noticesHeld) return;
  noticeTimers.set(notice.id, setTimeout(() => dismissNotice(notice.id), lifetime));
}

/** Runtime notices carry no kind; failures among them must not vanish on a timer. */
export function runtimeNoticeKind(message: string): NoticeKind {
  return /\b(could not|couldn't|cannot|can't|failed|failure|unavailable|not available|stopped|error|denied)\b/i.test(message) ? 'error' : 'info';
}

export function pushNotice(message: string, options: {kind?: NoticeKind; action?: NoticeAction} = {}): number {
  const kind = options.kind ?? 'info';
  // An Undo reverts one specific change, so two of them never merge into a row that could revert only the last.
  const same = options.action?.label === 'Undo' ? undefined : state.notices.find(n => n.message === message && n.kind === kind && n.action?.label === options.action?.label);
  if (same) {
    const next = {...same, count: same.count + 1, ...(options.action ? {action: options.action} : {})};
    set({notices: state.notices.map(n => n.id === same.id ? next : n)});
    scheduleNotice(next);
    return same.id;
  }
  const notice: Notice = {id: ++noticeSeq, message, kind, count: 1, ...(options.action ? {action: options.action} : {})};
  let notices = [...state.notices, notice];
  while (notices.length > MAX_NOTICES) {
    // Drop the oldest transient row first; persistent errors leave only when errors alone overflow.
    const drop = notices.find(n => n.kind !== 'error') ?? notices[0]!;
    clearTimeout(noticeTimers.get(drop.id)); noticeTimers.delete(drop.id);
    notices = notices.filter(n => n !== drop);
  }
  set({notices});
  scheduleNotice(notice);
  return notice.id;
}

export function dismissNotice(id: number): void {
  clearTimeout(noticeTimers.get(id));
  noticeTimers.delete(id);
  if (state.notices.some(n => n.id === id)) set({ notices: state.notices.filter((n) => n.id !== id) });
  // The stack unmounts when empty, so no pointerleave will arrive to release a hold.
  if (!state.notices.length) noticesHeld = false;
}

/** A pointer over the stack pauses expiry so a reader can reach Undo. */
export function holdNotices(hold: boolean): void {
  if (noticesHeld === hold) return;
  noticesHeld = hold;
  if (hold) { for (const timer of noticeTimers.values()) clearTimeout(timer); noticeTimers.clear(); }
  else for (const notice of state.notices) scheduleNotice(notice);
}

export function runNoticeAction(id: number): void {
  const action = state.notices.find(n => n.id === id)?.action;
  dismissNotice(id);
  if (action) void Promise.resolve().then(action.run).catch(cause => notifyError(cause));
}

/** Every surface's error text goes through here, so none of them ever show Electron's IPC boilerplate
 * ("Error invoking remote method 'muster:invoke': Error: …") — only the underlying message, with the
 * failing command kept as light context. */
function errorText(cause: unknown): string {
  return cause instanceof BridgeError
    ? `${cause.command}: ${cleanIpcError(cause)}`
    : cause instanceof Error
      ? cleanIpcError(cause)
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
    if (state.automations.phase !== 'idle') void loadAutomations(true);
    void invoke('app.snapshot', undefined).then(snapshot => {
      applySnapshot(snapshot);
      if (state.activeChatId) return readTimeline(state.activeChatId);
    }).catch(cause => notifyError(cause)).finally(() => { refreshingFocus = false; });
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
      refreshAfterAgentEdits(event.chatId, event.patch.items);
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
    } else if (event.type === 'notice') pushNotice(event.message, {kind: runtimeNoticeKind(event.message)});
    else if (event.type === 'settingsChanged') applySettings(event.values);
    else if (event.type === 'automationsChanged') set({automations: {phase: 'ready', value: event.automations}});
  });
  try {
    const snapshot = await invoke('app.snapshot', undefined);
    applySnapshot(snapshot);
    set({ boot: { phase: 'ready', value: true } });
    void loadSettings();
    syncResourceWatches();
    if (state.activeChatId) void loadTimeline(state.activeChatId);
  } catch (cause) {
    set({ boot: { phase: 'error', error: errorText(cause) } });
  }
}

let snapshotRevisionValue = 0;
/** Bumps once per runtime snapshot (not for local draft edits); lets views tell runtime truth from their own optimism. */
export function snapshotRevision(): number { return snapshotRevisionValue; }

function applySnapshot(snapshot: Snapshot): void {
  snapshotRevisionValue++;
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
      if (state.timelines[id]?.value) notifyError(cause);
      else set({timelines: {...state.timelines, [id]: {phase: 'error', error: errorText(cause)}}});
    }
  })();
  timelineReads.set(id, task);
  try { await task; } finally { timelineReads.delete(id); }
  // Only a genuine missing revision schedules recovery; failed reads do not
  // create a retry loop. New events or the explicit Retry action can retry.
  if (succeeded && timelineReplicas.get(id)?.needsSnapshot) void readTimeline(id);
}

/** PER-14: one freshness probe for a silent running chat. Reads the durable timeline; a newer revision
 *  than the replica means events were missed (subscription broke on a healthy transport) and resyncs it.
 *  Transport health is recorded by bridge.invoke itself. */
export async function probeTimeline(id: string, timeoutMs = 4_000): Promise<'live' | 'resynced' | 'failed'> {
  const local = timelineReplicas.get(id)?.value?.revision;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      invoke('chat.timeline', {id}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timeline probe timed out')), timeoutMs); }),
    ]);
    if (local !== undefined && snapshot.revision <= local) return 'live';
    timelineReplica(id).snapshot(snapshot);
    publishTimeline(id);
    return 'resynced';
  } catch (cause) {
    if (cause instanceof Error && /timed out/.test(cause.message)) recordTransport({ok: false, error: cause});
    return 'failed';
  } finally { clearTimeout(timer); }
}

async function loadTimeline(id: string): Promise<void> {
  if (state.timelines[id]?.phase === 'ready') return;
  await readTimeline(id);
}

export function retryTimeline(id: string): void {
  set({ timelines: { ...state.timelines, [id]: { phase: 'idle' } } });
  void loadTimeline(id);
}

/** Opens a new chat; `draft` prefills its composer (Codex's prefilled "Record a skill" conversation). */
export async function createChat(folderId?: string, projectId?: string, options: {draft?: string} = {}): Promise<string | undefined> {
  try {
    const chat = await invoke('chat.create', { folderId, projectId });
    set({ activeChatId: chat.id, screen: 'work' });
    if (options.draft) setComposerDraft(chat.id, options.draft);
    await loadTimeline(chat.id);
    return chat.id;
  } catch (cause) {
    notifyError(cause);
    return undefined;
  }
}

/** A hoisted declaration: it runs while `state` initializes, before any module constant exists. */
function readFollowUpMode(): FollowUpMode {
  try { return localStorage.getItem('muster.followUpMode') === 'steer' ? 'steer' : 'queue'; } catch { return 'queue'; }
}
export function setFollowUpMode(mode: FollowUpMode): void {
  if (state.followUpMode !== mode) set({followUpMode: mode});
  try { localStorage.setItem('muster.followUpMode', mode); } catch { /* this session only */ }
}

type ChatPatch = { title?: string; pinned?: boolean; archived?: boolean; draft?: string; mode?: Chat['mode']; model?: string; projectId?: string | null };
const quoted = (title: string) => `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`;
/** Archive, unpin and project moves confirm with an Undo that reverts exactly that change. */
function undoFor(prior: Chat, patch: ChatPatch): {message: string; revert: ChatPatch} | null {
  if (patch.archived === true && !prior.archived) return {message: `Archived ${quoted(prior.title)}`, revert: {archived: false}};
  if (patch.pinned === false && prior.pinned) return {message: `Unpinned ${quoted(prior.title)}`, revert: {pinned: true}};
  if (patch.projectId !== undefined && (patch.projectId ?? undefined) !== prior.projectId) {
    const project = patch.projectId ? state.snapshot?.projects.find(candidate => candidate.id === patch.projectId)?.name : undefined;
    return {message: project ? `Moved ${quoted(prior.title)} to ${project}` : `Removed ${quoted(prior.title)} from its project`, revert: {projectId: prior.projectId ?? null}};
  }
  return null;
}

export async function updateChat(
  id: string,
  patch: ChatPatch,
  options: {undoable?: boolean} = {},
): Promise<boolean> {
  // Optimistic local apply so pin/rename/archive feel immediate; the returned
  // chat (and subsequent snapshots) reconcile. On failure, restore the prior
  // chat so the UI does not show unpersisted state.
  const prior = state.snapshot?.chats.find((c) => c.id === id);
  if (state.snapshot && prior) {
    set({
      snapshot: {
        ...state.snapshot,
        chats: state.snapshot.chats.map((c) => (c.id === id ? { ...c, ...patch, projectId: patch.projectId === undefined ? c.projectId : patch.projectId ?? undefined } : c)),
      },
    });
  }
  try {
    const result = await invoke('chat.update', { id, ...patch });
    // Main may decline an archive after its confirmation dialog and return the chat unchanged: no Undo then.
    const applied = !result || (patch.archived === undefined || result.archived === patch.archived) && (patch.pinned === undefined || result.pinned === patch.pinned);
    const undo = options.undoable !== false && prior && applied ? undoFor(prior, patch) : null;
    if (undo) notifySuccess(undo.message, {label: 'Undo', run: () => updateChat(id, undo.revert, {undoable: false})});
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
    notifyError(cause, () => updateChat(id, patch, options));
    return false;
  }
}

export async function movePin(id: string, direction: 'up' | 'down'): Promise<void> {
  try {
    await invoke('chat.movePin', { id, direction });
  } catch (cause) {
    notifyError(cause, () => movePin(id, direction));
  }
}

/** UX-12/UX-23: optimistic drag reorder of the pinned list; a refused order restores the previous one and says why. */
export async function reorderPins(chatIds: string[]): Promise<boolean> {
  const before = state.snapshot;
  if (before) {
    const slot = new Map(chatIds.map((chatId, index) => [chatId, index + 1] as const));
    set({ snapshot: { ...before, chats: before.chats.map(chat => slot.has(chat.id) ? { ...chat, pinOrder: slot.get(chat.id)! } : chat) } });
  }
  try { await invoke('chat.reorderPins', { chatIds }); return true; }
  catch (cause) { if (before && state.snapshot) set({ snapshot: { ...state.snapshot, chats: before.chats } }); notifyError(cause); return false; }
}

/** NAV-05: optimistic folder reorder (drag) and the Move up/down equivalent. */
export async function reorderFolders(folderIds: string[]): Promise<boolean> {
  const before = state.snapshot;
  if (before) {
    const byId = new Map(before.folders.map(folder => [folder.id, folder] as const));
    const folders = folderIds.flatMap(folderId => byId.get(folderId) ?? []);
    if (folders.length === before.folders.length) set({ snapshot: { ...before, folders } });
  }
  try { await invoke('folder.reorder', { folderIds }); return true; }
  catch (cause) { if (before && state.snapshot) set({ snapshot: { ...state.snapshot, folders: before.folders } }); notifyError(cause); return false; }
}
export async function moveFolder(id: string, direction: 'up' | 'down'): Promise<void> {
  try { await invoke('folder.move', { id, direction }); } catch (cause) { notifyError(cause, () => moveFolder(id, direction)); }
}

/** CHAT-15: snooze never stops a run or touches the draft. Undo wakes it again (manual: no notification). */
export async function snoozeChat(id: string, choice: { until?: string; untilActivity?: boolean }, label?: string): Promise<boolean> {
  try {
    const chat = await invoke('chat.snooze', { id, ...choice });
    notifySuccess(label ? `Snoozed “${chat.title}” · ${label}` : `Snoozed “${chat.title}”`, { label: 'Undo', run: () => void wakeChat(id, true) });
    return true;
  } catch (cause) { notifyError(cause); return false; }
}
export async function wakeChat(id: string, quiet = false): Promise<void> {
  try { const chat = await invoke('chat.wake', { id }); if (!quiet) notifySuccess(`“${chat.title}” is awake`); }
  catch (cause) { notifyError(cause); }
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
const pendingSends: Record<string, { requestId: string; text: string; extras: string; attachmentIds: string[] }> = {};
/** Structured composer chips that travel beside the visible text. */
export interface SendExtras { skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort }

export async function sendMessage(id: string, text: string, skill?: string | SendExtras, attachmentIds: string[] = []): Promise<boolean> {
  if (state.sending[id] || (!text.trim() && !attachmentIds.length)) return false;
  const extras: SendExtras = typeof skill === 'string' ? { skillIds: [skill] } : skill ?? {};
  const skillIds = extras.skillIds?.filter(Boolean) ?? [], pluginIds = extras.pluginIds?.filter(Boolean) ?? [];
  const key = JSON.stringify([skillIds, pluginIds, extras.effort ?? null]);
  const submittedDraft = state.composerDrafts[id];
  const pending = pendingSends[id];
  const requestId =
    pending && pending.text === text && pending.extras === key && pending.attachmentIds.join('\n') === attachmentIds.join('\n') ? pending.requestId : crypto.randomUUID();
  pendingSends[id] = { requestId, text, attachmentIds, extras: key };
  const { [id]: _previousError, ...sendErrors } = state.sendErrors;
  set({ sending: { ...state.sending, [id]: true }, sendErrors });
  try {
    if (!(await flushComposerDraft(id))) throw new Error('Draft could not be saved. Retry after resolving the storage error.');
    // A single skill keeps the original `skillId` field so older runtimes still accept it.
    const payload = { id, text, requestId, ...(skillIds.length === 1 ? { skillId: skillIds[0] } : skillIds.length ? { skillIds } : {}), ...(pluginIds.length ? { pluginIds } : {}), ...(extras.effort ? { effort: extras.effort } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) };
    await invoke('chat.send', payload);
    delete pendingSends[id];
    const currentDraft = state.composerDrafts[id];
    if (currentDraft === submittedDraft || (submittedDraft && currentDraft?.revision === submittedDraft.revision)) {
      setComposerDraft(id, '');
    }
    await flushComposerDraft(id);
    return true;
  } catch (cause) {
    // The composer shows the runtime's own sentence; the toast keeps the command for diagnosis.
    set({ sendErrors: { ...state.sendErrors, [id]: runtimeMessage(cause) } });
    notifyError(cause);
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
    notifyError(cause, () => stopChat(id));
  }
}

export async function respondApproval(id: string, decision: ApprovalDecision): Promise<void> {
  try {
    await invoke('approval.respond', { id, approved: decision !== 'decline', decision });
  } catch (cause) {
    notifyError(cause);
  }
}

export async function respondQuestion(id: string, answers: Record<string, {answers: string[]}>): Promise<boolean> {
  try {
    await invoke('question.respond', { id, answers });
    return true;
  } catch (cause) {
    notifyError(cause);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Folders & projects

/** Resolves to the added folder (null when the picker was cancelled or failed) so callers can target it (F2). */
export async function pickFolder(): Promise<Folder | null> {
  try {
    // Host also emits a snapshot event with the new folder.
    return await invoke('folder.pick', undefined);
  } catch (cause) {
    notifyError(cause);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workspace tabs

export function setResourcesHidden(hidden:boolean):void {
  set({resourcesHidden:hidden});
  try{localStorage.setItem('muster.resourcesHidden',String(hidden));}catch{}
}

export function setSummaryHidden(hidden:boolean):void {
  set({summaryHidden:hidden});
  try{localStorage.setItem('muster.summaryHidden',String(hidden));}catch{}
}
export function setSummaryLayout(layout:AppState['summaryLayout']):void { if (state.summaryLayout!==layout) set({summaryLayout:layout}); }
/** Header toggle: the one and only way the summary card is hidden or shown, at every width. */
export function toggleSummary():void { setSummaryHidden(!state.summaryHidden); }

/** Switch the shared right-hand surface without closing or re-scoping resource tabs. */
export function setRightPaneMode(mode:'resources'|'activity', visible=true):void {
  set({rightPaneMode:mode, resourcesHidden:!visible});
  try {
    localStorage.setItem('muster.rightPaneMode',mode);
    localStorage.setItem('muster.resourcesHidden',String(!visible));
  } catch {}
}

/** `preview` opens (or replaces) the single italic preview tab; permanent opens never hit MAX_TABS via a preview slot. */
export function openTab(tab: WorkspaceTab, options: {preview?: boolean} = {}): void {
  const existing = state.tabs.find((t) => t.id === tab.id);
  if (existing) {
    // Reopening an already-open tab never demotes it back to a preview.
    set({
      tabs: state.tabs.map(t=>t.id===tab.id?{...t,...tab,preview:t.preview && options.preview!==false}:t),
      activeTabId: tab.id, resourcesHidden: false, rightPaneMode: 'resources',
    });
    rememberVisibleResourcePane();
    return;
  }
  const nextTab: WorkspaceTab = {...tab, preview: options.preview === true};
  const previewTab = options.preview ? state.tabs.find(t => t.preview) : undefined;
  let tabs: WorkspaceTab[];
  if (previewTab) {
    // Replace the existing preview tab in place; its cached body is stale for the new path.
    tabs = state.tabs.map(t => t.id === previewTab.id ? nextTab : t);
    const {[previewTab.id]: _body, ...fileBodies} = state.fileBodies;
    const {[previewTab.id]: _diff, ...diffs} = state.diffs;
    set({tabs, fileBodies, diffs, activeTabId: nextTab.id, resourcesHidden: false, rightPaneMode: 'resources'});
    rememberVisibleResourcePane();
    return;
  }
  if (!options.preview && state.tabs.length >= MAX_TABS) { pushNotice('Close a resource tab before opening another.'); return; }
  tabs = [...state.tabs, nextTab];
  set({tabs, activeTabId: nextTab.id, resourcesHidden: false, rightPaneMode: 'resources'});
  rememberVisibleResourcePane();
}

/** An in-progress edit marks the tab dirty (unsaved dot) and promotes it out of preview. */
export function setTabDirty(id: string, dirty: boolean): void {
  if (Boolean(state.dirtyTabs[id]) === dirty) return;
  const {[id]: _drop, ...rest} = state.dirtyTabs;
  set({dirtyTabs: dirty ? {...state.dirtyTabs, [id]: true} : rest});
  if (dirty) makeTabPermanent(id);
}

/** A double-click, an edit or a pin promotes a preview tab to a permanent one (same id, same position). */
export function makeTabPermanent(id: string): void {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || !tab.preview) return;
  set({tabs: state.tabs.map(t => t.id === id ? {...t, preview: false} : t)});
}

export function pinTab(id: string, pinned: boolean): void {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  set({tabs: state.tabs.map(t => t.id === id ? {...t, pinned, preview: pinned ? false : t.preview} : t)});
}

/** Drag-to-reorder and Alt+Shift+Left/Right; `toIndex` is clamped to the strip. */
export function reorderTab(id: string, toIndex: number): void {
  const from = state.tabs.findIndex(t => t.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(state.tabs.length - 1, toIndex));
  if (from === to) return;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  set({tabs});
}

export function moveTabDirection(id: string, direction: 'left' | 'right'): void {
  const index = state.tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  reorderTab(id, index + (direction === 'left' ? -1 : 1));
}

/** Bulk closes share single close's protection: tabs with unsaved edits are kept open, never silently discarded. */
function keepDirtyNotice(candidates: readonly WorkspaceTab[]): Set<string> {
  const dirty = new Set(candidates.filter(t => state.dirtyTabs[t.id]).map(t => t.id));
  if (dirty.size) pushNotice(`${dirty.size === 1 ? '1 tab' : `${dirty.size} tabs`} with unsaved changes ${dirty.size === 1 ? 'was' : 'were'} kept open.`, {kind: 'info'});
  return dirty;
}

/** Shared by Close Others / Close to the Right. Browser and Terminal tabs own native resources, so they
 *  close exactly as a single close does (browser.close, then removal; shells are ended) instead of
 *  vanishing from the strip while their web view or PTYs keep running. */
function closeBulk(anchorId: string, candidates: readonly WorkspaceTab[], activateAnchor: boolean): void {
  const keptDirty = keepDirtyNotice(candidates);
  const closing = candidates.filter(t => !keptDirty.has(t.id));
  if (!closing.length) { if (activateAnchor && state.activeTabId !== anchorId) set({activeTabId: anchorId}); return; }
  for (const tab of closing) if (tab.kind === 'processes' && tab.chatId) killChatTerminals(tab.chatId);
  const browsers = closing.filter(t => t.kind === 'browser');
  const closedIds = new Set(closing.filter(t => t.kind !== 'browser').map(t => t.id));
  if (closedIds.size) {
    const {fileBodies, diffs} = pruneClosed(closedIds);
    const activeClosed = !!state.activeTabId && (closedIds.has(state.activeTabId) || browsers.some(t => t.id === state.activeTabId));
    set({tabs: state.tabs.filter(t => !closedIds.has(t.id)), fileBodies, diffs, activeTabId: activateAnchor || activeClosed ? anchorId : state.activeTabId});
  } else if (activateAnchor) set({activeTabId: anchorId});
  for (const tab of browsers) closeTab(tab.id);
}

export function closeOtherTabs(id: string): void {
  if (!state.tabs.some(t => t.id === id)) return;
  closeBulk(id, state.tabs.filter(t => t.id !== id && !t.pinned), true);
}

export function closeTabsToRight(id: string): void {
  const index = state.tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  closeBulk(id, state.tabs.filter((t, i) => i > index && !t.pinned), false);
}

function pruneClosed(closedIds: Set<string>): {fileBodies: AppState['fileBodies']; diffs: AppState['diffs']} {
  return {
    fileBodies: Object.fromEntries(Object.entries(state.fileBodies).filter(([tabId]) => !closedIds.has(tabId))),
    diffs: Object.fromEntries(Object.entries(state.diffs).filter(([tabId]) => !closedIds.has(tabId))),
  };
}

function rememberVisibleResourcePane():void {
  try { localStorage.setItem('muster.rightPaneMode','resources'); localStorage.setItem('muster.resourcesHidden','false'); } catch {}
}

const closingBrowserTabs = new Set<string>();
export function closeTab(id: string): void {
  const tab = state.tabs.find(tab => tab.id === id);
  if (tab?.kind === 'browser') {
    if (closingBrowserTabs.has(id)) return;
    closingBrowserTabs.add(id);
    void invoke('browser.close', {owner:id}).then(() => removeTab(id)).catch(error => pushNotice(`Browser could not close. Its tab was kept so you can retry. ${error instanceof Error ? error.message : String(error)}`, {kind:'error', action:{label:'Retry', run:()=>closeTab(id)}})).finally(() => closingBrowserTabs.delete(id));
    return;
  }
  // Closing the Terminal resource ends its shells (Codex/VS Code parity) instead of leaving PTYs running
  // with nothing in the UI to show it — see killChatTerminals.
  if (tab?.kind === 'processes' && tab.chatId) killChatTerminals(tab.chatId);
  removeTab(id);
}
function removeTab(id: string): void {
  const index = state.tabs.findIndex(t=>t.id===id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  const { [id]: _body, ...fileBodies } = state.fileBodies;
  const { [id]: _diff, ...diffs } = state.diffs;
  const { [id]: _dirty, ...dirtyTabs } = state.dirtyTabs;
  set({
    tabs,
    fileBodies,
    diffs,
    dirtyTabs,
    activeTabId:
      state.activeTabId === id ? (tabs[Math.min(index,tabs.length-1)]?.id ?? null) : state.activeTabId,
    // Closing the last resource gives the conversation its width back.
    ...(tabs.length === 0 ? {resourcesHidden: true} : {}),
  });
  if (tabs.length === 0) try { localStorage.setItem('muster.resourcesHidden','true'); } catch {}
}

function remapFileTab(folderId: string, from: string, to: string): void {
  if (from === to) return;
  const basename = to.split('/').pop() || to;
  const remaps = [
    {kind:'file' as const, oldId:`file:${folderId}:${from}`, newId:`file:${folderId}:${to}`, title:basename},
    {kind:'diff' as const, oldId:`diff:${folderId}:${from}`, newId:`diff:${folderId}:${to}`, title:`Diff: ${basename}`},
  ];
  const changes = remaps.filter(remap=>state.tabs.some(tab=>tab.id===remap.oldId));
  if (!changes.length) return;
  const replacements = new Map(changes.map(remap=>[remap.oldId,remap]));
  const targetIds = new Set(state.tabs.filter(tab=>!replacements.has(tab.id)).map(tab=>tab.id));
  const tabs = state.tabs.flatMap(tab=>{
    const remap = replacements.get(tab.id);
    if (!remap) return [tab];
    // Keep an already-open destination tab as the canonical reference.
    if (targetIds.has(remap.newId)) return [];
    targetIds.add(remap.newId);
    return [{...tab,id:remap.newId,path:to,title:remap.title}];
  });
  const activeTabId = replacements.get(state.activeTabId ?? '')?.newId ?? state.activeTabId;
  const fileBodies = {...state.fileBodies};
  const diffs = {...state.diffs};
  for (const remap of changes) {
    delete fileBodies[remap.oldId];
    delete diffs[remap.oldId];
    // File format and Git content may both change at the destination.
    if (!state.tabs.some(tab=>tab.id===remap.newId)) {
      delete fileBodies[remap.newId];
      delete diffs[remap.newId];
    }
  }
  set({tabs,fileBodies,diffs,activeTabId});
}

export function activateTab(id: string): void {
  if (!state.tabs.some(tab=>tab.id===id)) return;
  set({ activeTabId: id, resourcesHidden: false, rightPaneMode: 'resources' });
  rememberVisibleResourcePane();
}

/** Lazily reconnect a restored tab; missing paths remain recoverable errors. */
export function hydrateTab(tab: WorkspaceTab): void {
  if (tab.kind === 'files' || tab.kind === 'changes' || tab.kind === 'git') {
    if (!state.files[dirKey(tab.folderId!, '')]) void loadDir(tab.folderId!, '');
    if (!state.gitChanges[tab.folderId!]) void loadGitChanges(tab.folderId!);
  } else if (tab.kind === 'file' && !state.fileBodies[tab.id]) void openFile(tab.folderId!, tab.path!);
  else if (tab.kind === 'diff' && !state.diffs[tab.id]) void openDiff(tab.folderId!, tab.path!);
  else if ((tab.kind === 'subagents' || tab.kind === 'processes' || tab.kind === 'sideChat') && tab.chatId && !state.timelines[tab.chatId]) void readTimeline(tab.chatId);
}

export function openFilesTab(folderId: string, folderName: string): void {
  openTab({ id: `files:${folderId}`, kind: 'files', folderId, title: folderName });
  void loadDir(folderId, '');
  void loadGitChanges(folderId);
}

/**
 * The one Git tab per folder: Changes · History · Pull request segments. Every Git entry point (summary card rows,
 * launch tiles, ⌘K, blame, the + menu) lands here; reopening switches the segment instead of adding a tab.
 */
export function openGitTab(folderId: string, folderName: string, view: GitView = 'changes', extra: {sha?: string; prNumber?: number} = {}): void {
  const tab: WorkspaceTab = {id: `git:${folderId}`, kind: 'git', folderId, title: `Git · ${folderName}`, gitView: view};
  if (view === 'history' && extra.sha) tab.sha = extra.sha;
  // openTab merges into an open tab: a PR number set here replaces the old one, an explicit undefined (the create
  // form) clears it, and Changes/History leave it alone so the Pull request segment keeps its target.
  if (view === 'pullRequest') tab.prNumber = extra.prNumber;
  openTab(tab);
  if (view === 'changes') void loadGitChanges(folderId);
}
/** Switch the Git tab's segment in place (the segmented header). */
export function setGitView(tabId: string, view: GitView): void {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab || tab.gitView === view) return;
  set({tabs: state.tabs.map(t => t.id === tabId ? {...t, gitView: view} : t)});
}
export function openChangesTab(folderId: string, folderName: string): void {
  openGitTab(folderId, folderName, 'changes');
}
/** GIT-11: commit history / compare view of a folder. `sha` preselects a commit (kept on the tab so a remount lands on it). */
export function openHistoryTab(folderId: string, folderName: string, sha?: string): void {
  openGitTab(folderId, folderName, 'history', sha ? {sha} : {});
}
/** GIT-13: the per-file merge-conflict resolver. */
export function openConflictTab(folderId: string, path: string): void {
  openTab({id:`conflict:${folderId}:${path}`,kind:'conflict',folderId,path,title:`Resolve: ${path.split('/').pop() ?? path}`});
}

/** SBX-12/17: the chat's durable mailbox. */
export function openInboxTab(chatId: string, title: string): void {
  openTab({id:`inbox:${chatId}`, kind:'inbox', chatId, title:`Inbox · ${title}`});
}
export function openSubagentsTab(chatId: string, folderId: string | undefined, folderName: string): void {
  openTab({id:`subagents:${chatId}`, kind:'subagents', ...(folderId ? {folderId} : {}), chatId, title:`Subagents · ${folderName}`});
}

export function openComputerTab(scope:ScopedComputerRef,label:string):void {
  openTab({id:`computer:${scope.kind}:${scope.id}`,kind:'computer',scope,title:`Computer · ${label}`});
}
export function openProcessesTab(chatId:string,label:string):void {
  void label; // every terminal surface is simply "Terminal"
  openTab({id:`processes:${chatId}`,kind:'processes',chatId,title:'Terminal'});
}

/** Click-to-open (composer tiles, sent-message attachments, queued chips): unhides the pane and focuses this chat-scoped
 * attachment's tab, opening a new one only the first time — `openTab` already re-focuses an existing id. */
export function openAttachmentTab(chatId: string, attachmentId: string, name: string): void {
  openTab({id: `attachment:${chatId}:${attachmentId}`, kind: 'attachment', chatId, attachmentId, path: name, title: name});
}

/** A pull request in the Git tab's Pull request segment (GIT-12). */
export function openPullRequestTab(folderId: string, number: number, title?: string): void {
  void title;
  openGitTab(folderId, folderName(folderId), 'pullRequest', {prNumber: number});
}

/** The in-app "Create pull request" form for a folder's checked-out branch (GIT-07), in the same segment. */
export function openCreatePullRequestTab(folderId: string): void {
  openGitTab(folderId, folderName(folderId), 'pullRequest');
}
function folderName(folderId: string): string {
  return state.snapshot?.folders.find(folder => folder.id === folderId)?.name ?? 'Repository';
}

export function openBrowserTab(url = 'about:blank'): void {
  try { url = browserURL(url); } catch(error) { notifyError(error); return; }
  const existing = url !== 'about:blank' && state.tabs.find(t => t.kind === 'browser' && t.url === url);
  if (existing) { activateTab(existing.id); return; }
  openTab({id:`browser:${crypto.randomUUID()}`,kind:'browser',browserProfileId:'personal',url,title:'Browser'});
}

/** Persist only the latest validated main-frame URL for an existing browser tab. */
export function updateBrowserTabUrl(id:string,value:string):void {
  let url:string;
  try {url=browserURL(value);} catch {return;}
  const tab=state.tabs.find(candidate=>candidate.id===id);
  if(!tab || tab.kind!=='browser' || tab.url===url)return;
  set({tabs:state.tabs.map(candidate=>candidate.id===id?{...candidate,url}:candidate)});
}

/** Providers live inside Settings; older callers land on that one entry point. */
export function openProvidersTab(): void {
  openAppSettings('providers');
  void loadProviders(true);
}
export function openProjectsScreen(): void { set({ screen: 'projects', revealed: {} }); }
export function openAutomationsScreen(): void { set({ screen: 'automations', revealed: {} }); void loadAutomations(true); }
let automationsRequest = 0;
/** The list stays live through events; this is the first read and the focus refresh. */
export async function loadAutomations(force = false): Promise<void> {
  if (!force && state.automations.phase === 'ready') return;
  const ticket = ++automationsRequest;
  if (!state.automations.value) set({automations: {phase: 'loading'}});
  try { const value = await invoke('automations.list', undefined); if (ticket === automationsRequest) set({automations: {phase: 'ready', value}}); }
  catch (cause) { if (ticket === automationsRequest) set({automations: state.automations.value ? state.automations : {phase: 'error', error: errorText(cause)}}); }
}
export function openAppSettings(section?: SettingsSection): void {
  set({screen:'settings',revealed:{},...(section ? {settingsSection:section} : {})});
}
export function setSettingsSection(settingsSection: SettingsSection): void { if (state.settingsSection !== settingsSection) set({settingsSection, revealed: {}}); }
export function closeSettings(): void { set({ screen: 'work', revealed: {} }); }
export function setInlineFileDiffsVisible(value:boolean):void { void setSetting('chat.inlineDiffs', value); }

function applySettings(values: AppSettings): void {
  const settings = normalizeSettings(values);
  set({settings, showInlineFileDiffs: settings['chat.inlineDiffs']});
  try { localStorage.setItem(SETTINGS_CACHE, JSON.stringify(settings)); } catch { /* the runtime file stays authoritative */ }
}

async function loadSettings(): Promise<void> {
  try {
    const result = await invoke('settings.get', {});
    if (!result?.values) return;
    // One-time move of the old browser-only inline diff choice into the runtime file.
    const legacyOff = settingsCacheMissing && state.settings['chat.inlineDiffs'] === false && result.values['chat.inlineDiffs'];
    settingsCacheMissing = false;
    applySettings(result.values);
    if (legacyOff) void setSetting('chat.inlineDiffs', false);
  } catch { /* cached values keep applying; Settings shows the runtime error on change */ }
}

/** Applies at once, persists through the runtime, and rolls back with a Retry on failure. */
export async function setSetting<K extends SettingKey>(key: K, value: AppSettings[K]): Promise<boolean> {
  const previous = state.settings[key];
  if (previous === value) return true;
  applySettings({...state.settings, [key]: value});
  try {
    const result = await invoke('settings.set', {key, value});
    if (result?.values) applySettings(result.values);
    return true;
  } catch (cause) {
    if (state.settings[key] === value) applySettings({...state.settings, [key]: previous});
    notifyError(cause, () => setSetting(key, value));
    return false;
  }
}

export async function resetSettings(): Promise<void> {
  try { const result = await invoke('settings.reset', {}); if (result?.values) applySettings(result.values); notifySuccess('Settings reset to defaults'); }
  catch (cause) { notifyError(cause, resetSettings); }
}

/** Skills & plugins live inside Settings too, like Providers: route through the same shell (left
 * nav, search) instead of a separate top-level screen. */
export function openPluginsScreen(pluginView:'skills'|'plugins'='skills'): void {
  openAppSettings('plugins');
  set({ pluginView });
  if(pluginView==='skills')void loadSkills(); else void loadPlugins();
}

export function setPluginView(pluginView:'skills'|'plugins'):void {
  set({pluginView});
  if(pluginView==='skills')void loadSkills(); else void loadPlugins();
}

export async function loadSkills(force = false, folderPaths?: string[]): Promise<void> {
  if (state.skills.phase === 'loading') return;
  if (!force && state.skills.phase === 'ready') return;
  set({ skills: { phase: 'loading', value: state.skills.value } });
  try {
    const allowedFolders = folderPaths ?? (state.snapshot?.folders ?? []).map(folder => folder.path);
    const value = await invoke('plugins.list', { folderPaths: allowedFolders });
    set({ skills: { phase: 'ready', value } });
  } catch (cause) {
    set({ skills: { phase: 'error', error: errorText(cause) } });
  }
}

export async function loadPlugins(force=false):Promise<void>{
  if(state.plugins.phase==='loading')return;
  if(!force&&state.plugins.phase==='ready')return;
  set({plugins:{phase:'loading',value:state.plugins.value}});
  try{set({plugins:{phase:'ready',value:await invoke('plugins.inventory',undefined)}});}
  catch(cause){set({plugins:{phase:'error',error:errorText(cause)}});}
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
  // Also refreshes from Settings' Memory section, not just the standalone Memory screen, so a
  // future folder-scoped panel embedded there never shows a stale list after adding an entry.
  const onMemoryScreen = state.screen === 'memory' || (state.screen === 'settings' && state.settingsSection === 'memory');
  if (onMemoryScreen && state.memoryFolderId === input.folderId) {
    if (state.memorySearch.trim()) await runMemorySearch(); else await loadMemory();
  }
}

export function dirKey(folderId: string, path: string): string {
  return `${folderId}\u0000${path}`;
}

/** Files tab "Show .git and system files" (WRK-06): persists the choice and relists every loaded directory.
 *  A directory mid-load is not skipped: loadDir joins the in-flight read and lists once more after it, so the
 *  tree never keeps a listing taken under the old setting. */
export function setShowHiddenFiles(on: boolean): void {
  writeShowHiddenFiles(on);
  for (const key of Object.keys(state.files)) {
    const cut = key.indexOf('\u0000');
    if (cut > 0) void loadDir(key.slice(0, cut), key.slice(cut + 1));
  }
}

const dirLoads = new Map<string, Promise<void>>();
const dirReloads = new Set<string>();
/**
 * List one directory. F28: a call that lands while the same listing is in flight (a watcher refresh
 * racing the tree's first load, or an agent writing apps/web/** mid-listing) used to return early and
 * leave the older listing on screen. It now joins the in-flight load and forces one more read after it,
 * so the tree always ends on a listing taken after the latest change.
 */
export function loadDir(folderId: string, path: string): Promise<void> {
  const key = dirKey(folderId, path);
  const running = dirLoads.get(key);
  if (running) { dirReloads.add(key); return running; }
  const task = (async () => {
    do {
      dirReloads.delete(key);
      set({ files: { ...state.files, [key]: { phase: 'loading', value: state.files[key]?.value } } });
      try {
        const entries = await invoke('files.list', { folderId, path: path || undefined, ...(showHiddenFiles() ? {showHidden: true} : {}) });
        set({ files: { ...state.files, [key]: { phase: 'ready', value: entries } } });
      } catch (cause) {
        set({ files: { ...state.files, [key]: { phase: 'error', error: errorText(cause) } } });
      }
    } while (dirReloads.has(key));
  })().finally(() => { dirLoads.delete(key); dirReloads.delete(key); });
  dirLoads.set(key, task);
  return task;
}

async function readFileBody(folderId: string, path: string): Promise<FileBody> {
  const kind = filePresentation(path);
  if (kind === 'quicklook' || kind === 'media' || kind === 'binary') return {text: '', truncated: false};
  if (['document','workbook'].includes(filePresentation(path)) && await invoke('files.nativeAvailable',undefined).catch(()=>false)) return {native:true,text:'',truncated:false};
  if (filePresentation(path) === 'document') return {text:'',truncated:false,document:await invoke('files.document',{folderId,path})};
  if (filePresentation(path) === 'workbook') return {text:'',truncated:false,workbook:await invoke('files.workbook',{folderId,path})};
  if (filePresentation(path) === 'image') return {text: '', truncated: false, asset: await invoke('files.asset',{folderId,path})};
  return invoke('files.read',{folderId,path});
}

export async function openFile(folderId: string, path: string, line?: number, options: {preview?: boolean} = {}): Promise<void> {
  const id = `file:${folderId}:${path}`;
  openTab({ id, kind: 'file', folderId, path, line, title: path.split('/').pop() ?? path }, options);
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
    if (state.tabs.some(tab => tab.id === id)) set({
      fileBodies: { ...state.fileBodies, [id]: { phase: 'error', error: errorText(cause) } },
    });
  }
}

/** Forces a re-read of an open file's body, bypassing the "already ready" cache short-circuit `openFile` uses.
 * Called after a save (files.write) so the cached preview reflects what is now on disk. */
export async function refreshFileBody(folderId: string, path: string): Promise<void> {
  const id = `file:${folderId}:${path}`;
  if (!state.tabs.some(tab => tab.id === id)) return;
  try {
    const body = await readFileBody(folderId, path);
    if (state.tabs.some(tab => tab.id === id)) set({fileBodies: {...state.fileBodies, [id]: {phase: 'ready', value: body}}});
  } catch (cause) {
    if (state.tabs.some(tab => tab.id === id)) set({fileBodies: {...state.fileBodies, [id]: {phase: 'error', error: errorText(cause)}}});
  }
}

const gitChangesRetry = new Map<string, ReturnType<typeof setTimeout>>();
const gitChangesRetryCount = new Map<string, number>();
/** A handful of quick retries covers a transient timeout or a busy Git lock; a folder that keeps
 * failing past that has a real, standing problem and should just show the error until the user acts. */
const GIT_CHANGES_MAX_RETRIES = 5;
/** Errors no retry can fix: not a repository, the folder is gone, or Git is not installed. */
function isStandingGitError(cause: unknown): boolean {
  if (isNotGitRepository(cause)) return true;
  const text = cause instanceof Error ? cause.message : String(cause ?? '');
  return /ENOENT|no such file|cannot find the path|spawn git|git: command not found|git not found|Folder does not exist|Unknown folder/i.test(text);
}
function gitFolderKnown(folderId: string): boolean {
  if (state.tabs.some(tab => tab.folderId === folderId)) return true;
  const folders = state.snapshot?.folders;
  return !folders || folders.some(folder => folder.id === folderId);
}
export async function loadGitChanges(folderId: string): Promise<void> {
  const previous = state.gitChanges[folderId];
  if (previous?.phase === 'loading') return;
  clearTimeout(gitChangesRetry.get(folderId));
  gitChangesRetry.delete(folderId);
  set({ gitChanges: { ...state.gitChanges, [folderId]: { phase: 'loading', value: previous?.value } } });
  try {
    const changes = await invoke('git.changes', { folderId });
    gitChangesRetryCount.delete(folderId);
    set({ gitChanges: { ...state.gitChanges, [folderId]: { phase: 'ready', value: changes } } });
  } catch (cause) {
    // Mid-run reads can hit a transient timeout or a busy Git lock (the review host and the status
    // queue both spawn `git`, and heavy edit activity can starve either one): keep the last good list
    // on screen instead of blanking it to "Unavailable", and retry shortly so it self-heals without
    // the user noticing. A folder that isn't a repository (or has no Git at all) never recovers, so
    // it isn't retried; anything else gets a few quick attempts before settling on the error.
    set({
      gitChanges: { ...state.gitChanges, [folderId]: { phase: 'error', error: errorText(cause), value: previous?.value } },
    });
    const tries = gitChangesRetryCount.get(folderId) ?? 0;
    if (!isStandingGitError(cause) && tries < GIT_CHANGES_MAX_RETRIES) {
      gitChangesRetryCount.set(folderId, tries + 1);
      gitChangesRetry.set(folderId, setTimeout(() => {
        gitChangesRetry.delete(folderId);
        // A folder removed while a retry was pending is not polled again (and not re-added to gitChanges).
        if (!gitFolderKnown(folderId)) { gitChangesRetryCount.delete(folderId); return; }
        void loadGitChanges(folderId);
      }, 2500));
    } else {
      gitChangesRetryCount.delete(folderId);
    }
  }
}

export async function openDiff(folderId: string, path: string): Promise<void> {
  const id = `diff:${folderId}:${path}`;
  openTab({ id, kind: 'diff', folderId, path, title: `Diff: ${path.split('/').pop() ?? path}` });
  set({ diffs: { ...state.diffs, [id]: { phase: 'loading' } } });
  try {
    const diff = await invoke('git.diff', { folderId, path });
    if (!state.tabs.some(tab=>tab.id===id)) return;
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
    if (state.tabs.some(tab=>tab.id===id)) set({ diffs: { ...state.diffs, [id]: { phase: 'error', error: errorText(cause) } } });
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
  void invoke('workspace.watch', {folderIds}).catch(cause=>{watchedSignature='';notifyError(cause);});
}

const agentEditRefresh = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * F28: the agent's own file edits refresh the open resources of its folder even when the file watcher
 * is unavailable, failed, or coalesced the burst away (belt and braces with workspaceChanged).
 */
function refreshAfterAgentEdits(chatId: string, items: readonly TimelineItem[]): void {
  if (!items.some(item => item.kind === 'tool' && item.status === 'completed' && (item.data?.type === 'fileChange' || item.data?.type === 'commandExecution'))) return;
  const folderId = state.snapshot?.chats.find(chat => chat.id === chatId)?.folderId;
  if (!folderId || !state.tabs.some(tab => tab.folderId === folderId)) return;
  clearTimeout(agentEditRefresh.get(folderId));
  agentEditRefresh.set(folderId, setTimeout(() => { agentEditRefresh.delete(folderId); void refreshResources(folderId); }, 250));
}

export async function refreshResources(folderId: string): Promise<void> {
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
      if(active.kind==='changes'||active.kind==='git'){await loadGitChanges(folderId);continue;}
      if (active.kind === 'files') { const paths=[...new Set(['',...Object.keys(files).filter(key=>key.startsWith(folderId+'\0')).map(key=>key.slice(folderId.length+1))])].slice(0,64); await Promise.all([...paths.map(path=>loadDir(folderId,path)),loadGitChanges(folderId)]); continue; }
      // Views that read Git themselves (history, PR, conflicts, …) refresh on workspaceChanged; only file/diff bodies reload here.
      if (active.kind !== 'file' && active.kind !== 'diff') continue;
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
      pushNotice('Provider identity is unavailable.', {kind:'error'});
      return;
    }
    set({ revealed: { ...state.revealed, [id]: identity } });
  } catch (cause) {
    notifyError(cause);
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

/** Hiding navigation preserves its width, selection and draft state. `persist:false` is the narrow-window
 *  auto-collapse (UX-13): it never overwrites the user's own choice for wide windows. */
export function setNavHidden(hidden:boolean,options:{persist?:boolean}={}):void {
 set({navHidden:hidden});
 if(options.persist===false)return;
 try{localStorage.setItem('muster.navHidden',String(hidden));}catch{}
}
