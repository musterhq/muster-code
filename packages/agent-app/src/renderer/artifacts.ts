/**
 * Renderer side of the artifacts domain: canvas tabs (WRK-12), side chats bound to a resource (WRK-13) and plugin
 * UI tabs (EXT-10). Keeps the side-chat list live so the sidebar can leave unpromoted side chats out.
 */
import {useSyncExternalStore} from 'react';
import {invoke, subscribe} from './bridge';
import {activeChat, closeTab, getState, notifyError, openTab, selectChat, type WorkspaceTab} from './store';
import {MAX_SIDE_CHAT_EXCERPT, sideChatLabel, type CanvasKind, type CanvasSummary, type SideChat, type SideChatBinding} from '../shared/domains/artifacts-protocol';

let sideChats: SideChat[] = [];
let hidden: ReadonlySet<string> = new Set();
const sideListeners = new Set<() => void>();
type CanvasListener = (event: {type: 'changed'; canvas: CanvasSummary; created?: boolean} | {type: 'deleted'; id: string}) => void;
const canvasListeners = new Set<CanvasListener>();
let unsubscribe: (() => void) | undefined;

function setSideChats(next: SideChat[]): void {
  sideChats = next;
  hidden = new Set(next.filter(item => !item.promotedAt).map(item => item.chatId));
  for (const listener of [...sideListeners]) listener();
}
/** Side chats not yet promoted: kept out of the sidebar, Spotlight and chat cycling. */
export function hiddenSideChatIds(): ReadonlySet<string> { return hidden; }
export function sideChatFor(chatId: string): SideChat | undefined { return sideChats.find(item => item.chatId === chatId); }
export function useHiddenSideChats(): ReadonlySet<string> {
  return useSyncExternalStore(listener => { sideListeners.add(listener); return () => { sideListeners.delete(listener); }; }, () => hidden, () => hidden);
}
export function useSideChat(chatId: string | undefined): SideChat | undefined {
  useSyncExternalStore(listener => { sideListeners.add(listener); return () => { sideListeners.delete(listener); }; }, () => sideChats, () => sideChats);
  return chatId ? sideChatFor(chatId) : undefined;
}
export function onCanvasEvent(listener: CanvasListener): () => void { canvasListeners.add(listener); return () => { canvasListeners.delete(listener); }; }

/** Idempotent: one bridge subscription for artifact events, plus the initial side-chat list. */
export function ensureArtifactSync(): void {
  if (unsubscribe) return;
  try {
    unsubscribe = subscribe(event => {
      if (event.type === 'sideChatsChanged') setSideChats(event.sideChats);
      else if (event.type === 'canvasChanged') {
        for (const listener of [...canvasListeners]) listener({type: 'changed', canvas: event.canvas, ...(event.created ? {created: true} : {})});
        // An agent's new canvas opens beside the conversation that made it.
        if (event.created && event.canvas.updatedBy === 'agent' && event.canvas.chatId && event.canvas.chatId === getState().activeChatId) openCanvasTab(event.canvas);
      } else if (event.type === 'canvasDeleted') {
        for (const listener of [...canvasListeners]) listener({type: 'deleted', id: event.id});
        if (getState().tabs.some(tab => tab.id === `canvas:${event.id}`)) closeTab(`canvas:${event.id}`);
      }
    });
  } catch { unsubscribe = undefined; return; }
  void invoke('artifacts.sideChat.list', undefined).then(result => { if (Array.isArray(result?.sideChats)) setSideChats(result.sideChats); }, () => {});
}

export function openCanvasTab(canvas: Pick<CanvasSummary, 'id' | 'title'>): void {
  openTab({id: `canvas:${canvas.id}`, kind: 'canvas', canvasId: canvas.id, title: canvas.title});
}
const STARTERS: Record<CanvasKind, {title: string; content: string; language?: string}> = {
  markdown: {title: 'Untitled canvas', content: '# Untitled\n\n'},
  code: {title: 'Untitled snippet', content: '', language: 'typescript'},
  html: {title: 'Untitled page', content: '<!doctype html>\n<html>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>\n'},
};
/** New canvas bound to the active chat (so its agent can read and update it). */
export async function createCanvas(kind: CanvasKind = 'markdown'): Promise<void> {
  const chat = activeChat(), starter = STARTERS[kind];
  try {
    const canvas = await invoke('artifacts.canvas.create', {kind, title: starter.title, content: starter.content, ...(starter.language ? {language: starter.language} : {}), ...(chat ? {chatId: chat.id} : {}), ...(chat?.folderId ? {folderId: chat.folderId} : {})});
    openCanvasTab(canvas);
  } catch (cause) { notifyError(cause); }
}

/** The text the user has selected inside `root` (a text field's selection counts), bounded for the prompt. */
export function selectedText(root?: Element | null): string {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (active && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && (!root || root.contains(active))) {
    const start = active.selectionStart ?? 0, end = active.selectionEnd ?? 0;
    if (end > start) return active.value.slice(start, end).slice(0, MAX_SIDE_CHAT_EXCERPT);
  }
  // A text field keeps its selection after focus moves to a menu; the first one inside `root` with a selection counts.
  for (const field of root ? Array.from(root.querySelectorAll('textarea')) : []) {
    const start = field.selectionStart ?? 0, end = field.selectionEnd ?? 0;
    if (end > start) return field.value.slice(start, end).slice(0, MAX_SIDE_CHAT_EXCERPT);
  }
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
  const range = selection.getRangeAt(0);
  if (root && !root.contains(range.commonAncestorContainer)) return '';
  return selection.toString().slice(0, MAX_SIDE_CHAT_EXCERPT);
}

/** What a resource tab is, as a side-chat binding; null for tabs a side chat cannot be about. */
export function sideChatBindingForTab(tab: WorkspaceTab, excerpt = ''): SideChatBinding | null {
  const extra = excerpt.trim() ? {excerpt} : {};
  if ((tab.kind === 'file' || tab.kind === 'conflict') && tab.folderId && tab.path) return {kind: 'file', folderId: tab.folderId, path: tab.path, ...(tab.line ? {line: tab.line} : {}), ...extra};
  if (tab.kind === 'diff' && tab.folderId && tab.path) return {kind: 'diff', folderId: tab.folderId, path: tab.path, ...extra};
  if ((tab.kind === 'pullRequest' || (tab.kind === 'git' && tab.gitView === 'pullRequest')) && tab.folderId && tab.prNumber) return {kind: 'pullRequest', folderId: tab.folderId, prNumber: tab.prNumber, title: `PR #${tab.prNumber}`, ...extra};
  if (tab.kind === 'canvas' && tab.canvasId) return {kind: 'canvas', canvasId: tab.canvasId, title: tab.title, ...extra};
  return null;
}

/** Opens a side chat about `binding` in the right pane, next to the resource. */
export async function openSideChat(binding: SideChatBinding): Promise<void> {
  const parent = activeChat();
  try {
    const side = await invoke('artifacts.sideChat.create', {binding, ...(parent ? {parentChatId: parent.id} : {})});
    setSideChats([side, ...sideChats.filter(item => item.chatId !== side.chatId)]);
    openTab({id: `sidechat:${side.chatId}`, kind: 'sideChat', chatId: side.chatId, title: side.label || sideChatLabel(binding), ...('folderId' in binding ? {folderId: binding.folderId} : {})});
  } catch (cause) { notifyError(cause); }
}
/** Promote: the side chat becomes a normal chat in the sidebar and takes over the conversation column. */
export async function promoteSideChat(chatId: string): Promise<void> {
  try {
    const side = await invoke('artifacts.sideChat.promote', {chatId});
    setSideChats(sideChats.map(item => item.chatId === chatId ? side : item));
    closeTab(`sidechat:${chatId}`);
    await selectChat(chatId);
  } catch (cause) { notifyError(cause); }
}
export async function discardSideChat(chatId: string): Promise<void> {
  try {
    await invoke('artifacts.sideChat.discard', {chatId});
    setSideChats(sideChats.filter(item => item.chatId !== chatId));
    closeTab(`sidechat:${chatId}`);
  } catch (cause) { notifyError(cause); }
}

export function openPluginUiTab(pluginId: string, appName: string, title: string): void {
  openTab({id: `plugin:${pluginId}:${appName}`, kind: 'pluginUi', pluginId, appName, title});
}
