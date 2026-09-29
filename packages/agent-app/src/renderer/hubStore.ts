/**
 * Paperclip-in-Muster data for the renderer (#115): one cached workspace snapshot, the hub route (Inbox, Roster, an
 * agent, Ledger, Outputs, a task thread) and the sidebar Inbox badge. No intervals anywhere: the runtime owns the live
 * channel (Paperclip's WebSocket, or Muster's own projectChanged / mailboxChanged events) and a hidden window defers
 * every refetch until it is shown again.
 *
 * Everything goes through `invoke` and `subscribe` (the command protocol), never Electron APIs, so the same code can talk
 * to a remote Muster Server later.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { AgentEvent } from '../shared/protocol';
import type { WorkspaceBadge, WorkspaceSnapshot } from '../shared/domains/paperclip-protocol';
import { invoke, subscribe } from './bridge';
import { openHubScreen } from './store';

export type HubPage = 'inbox' | 'ledger' | 'agent' | 'task' | 'project' | 'dashboard' | 'tasks' | 'roster' | 'outputs';
export interface HubRoute { page: HubPage; arg: string | null; from: HubPage | null; fromArg: string | null }

// --- route ---------------------------------------------------------------------------------------------------------
let route: HubRoute = { page: 'inbox', arg: null, from: null, fromArg: null };
const routeListeners = new Set<() => void>();
export function openHub(page: HubPage, arg: string | null = null): void {
  route = route.page === page ? { page, arg, from: route.from, fromArg: route.fromArg } : { page, arg, from: route.page, fromArg: route.arg };
  for (const l of routeListeners) l();
  openHubScreen();
}
/** The current route, outside React (tests, command handlers). */
export function hubRoute(): HubRoute { return route; }
export function useHubRoute(): HubRoute { return useSyncExternalStore(l => { routeListeners.add(l); return () => routeListeners.delete(l); }, () => route); }

// --- workspace snapshot ------------------------------------------------------------------------------------------------
interface WorkspaceState { snapshot: WorkspaceSnapshot | null; error: string; loading: boolean }
let state: WorkspaceState = { snapshot: null, error: '', loading: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<WorkspaceState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
let viewers = 0, dirty = true, inflight: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null;
const taskListeners = new Set<(ids: string[]) => void>();
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function refreshWorkspace(refresh = false): Promise<void> {
  if (inflight && !refresh) return inflight;
  dirty = false;
  if (!state.snapshot) set({ loading: true });
  inflight = invoke('paperclip.snapshot', refresh ? { refresh: true } : {})
    .then(snapshot => set({ snapshot, error: '', loading: false }), cause => set({ error: cause instanceof Error ? cause.message : String(cause), loading: false }))
    .finally(() => { inflight = null; });
  return inflight;
}
function schedule(delay = 250) {
  if (!viewers || hidden()) { dirty = true; return; }
  if (timer) return;
  timer = setTimeout(() => { timer = null; void refreshWorkspace(); }, delay);
}
const LOCAL_EVENTS = new Set(['projectChanged', 'mailboxChanged']);
function onEvent(event: AgentEvent) {
  if (event.type === 'projectsWorkspaceChanged') { if (event.taskIds.length) for (const l of taskListeners) l(event.taskIds); schedule(); return; }
  if (LOCAL_EVENTS.has(event.type)) { if (event.type === 'projectChanged') for (const l of taskListeners) l([event.taskId]); schedule(400); }
}
let unsubscribeEvents: (() => void) | null = null;
function onVisibility() {
  const visible = !hidden();
  void invoke('paperclip.watch', { visible: visible && viewers > 0 }).catch(() => undefined);
  if (visible && dirty && viewers) schedule(0);
}
/** Each mounted viewer (a hub page, the sidebar's Paperclip projects) keeps the snapshot live; the last one to leave stops it. */
export function useWorkspace(enabled = true): WorkspaceState {
  useEffect(() => {
    if (!enabled) return;
    viewers++;
    if (viewers === 1) { unsubscribeEvents = subscribe(onEvent); document.addEventListener('visibilitychange', onVisibility); }
    void invoke('paperclip.watch', { visible: !hidden() }).catch(() => undefined);
    if (dirty || !state.snapshot) void refreshWorkspace();
    return () => {
      viewers--;
      if (viewers === 0) {
        unsubscribeEvents?.(); unsubscribeEvents = null;
        document.removeEventListener('visibilitychange', onVisibility);
        if (timer) { clearTimeout(timer); timer = null; }
        dirty = true;
        void invoke('paperclip.watch', { visible: false }).catch(() => undefined);
      }
    };
  }, [enabled]);
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export function onTasksChanged(listener: (ids: string[]) => void): () => void { taskListeners.add(listener); return () => taskListeners.delete(listener); }

// --- the sidebar Inbox badge -----------------------------------------------------------------------------------------------
let badge: WorkspaceBadge | null = null;
const badgeListeners = new Set<() => void>();
let badgeTimer: ReturnType<typeof setTimeout> | null = null, badgeDirty = true, badgeSubscribed = false;
const BADGE_EVENTS = new Set(['projectsWorkspaceChanged', 'projectChanged', 'mailboxChanged']);
function loadBadge() {
  badgeDirty = false;
  void invoke('paperclip.badge', {}).then(next => {
    if (badge && next.inbox === badge.inbox && next.liveRuns === badge.liveRuns && next.connected === badge.connected && next.mail === badge.mail) return;
    badge = next; for (const l of badgeListeners) l();
  }, () => undefined);
}
function queueBadge(delay: number) {
  if (hidden()) { badgeDirty = true; return; }
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => { badgeTimer = null; loadBadge(); }, delay);
}
/** Refetched after events (coalesced over 1.5 s) and when the window is shown again. Never polled. */
export function useInboxBadge(): WorkspaceBadge | null {
  useEffect(() => {
    if (badgeSubscribed) return;
    badgeSubscribed = true;
    subscribe(event => { if (BADGE_EVENTS.has(event.type)) queueBadge(1500); });
    document.addEventListener('visibilitychange', () => { if (!hidden() && badgeDirty) queueBadge(0); });
    queueBadge(2500);
  }, []);
  return useSyncExternalStore(l => { badgeListeners.add(l); return () => badgeListeners.delete(l); }, () => badge);
}

// --- Inbox dismissals (#189) ---------------------------------------------------------------------------------------------
// Read once, then kept here: Dismiss updates this map at once and saves in the background. Shared by the Inbox and the badge.
let dismissals: ReadonlyMap<string, string> = new Map();
let dismissalsLoaded = false;
const dismissalListeners = new Set<() => void>();
const setDismissals = (next: ReadonlyMap<string, string>) => { dismissals = next; for (const l of dismissalListeners) l(); };
export function useInboxDismissals(): ReadonlyMap<string, string> {
  useEffect(() => {
    if (dismissalsLoaded) return;
    dismissalsLoaded = true;
    void invoke('paperclip.inbox.dismissed', {}).then(result => {
      if (!result?.items?.length) return;
      const next = new Map(dismissals);
      for (const item of result.items) if (!next.has(item.id)) next.set(item.id, item.at);
      setDismissals(next);
    }, () => { dismissalsLoaded = false; });
  }, []);
  return useSyncExternalStore(l => { dismissalListeners.add(l); return () => dismissalListeners.delete(l); }, () => dismissals);
}
/** Hides an Inbox item until it changes. The chat, task or mail it points at is kept. */
export function dismissInboxItem(item: { id: string; at: string }): Promise<void> {
  const previous = dismissals.get(item.id);
  setDismissals(new Map(dismissals).set(item.id, item.at));
  return invoke('paperclip.inbox.dismiss', { id: item.id, at: item.at }).then(() => undefined, cause => {
    if (dismissals.get(item.id) === item.at) { const next = new Map(dismissals); if (previous === undefined) next.delete(item.id); else next.set(item.id, previous); setDismissals(next); }
    throw cause;
  });
}
