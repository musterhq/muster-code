/**
 * #829: the user's edits of the visuals in a chat (Mermaid, chart and html-report fences, render_html pages). An edit is a
 * Canvas linked to its chat and visual (`Canvas.visual`): version 1 is the visual as the reply drew it, each Save a later
 * version, so the original stays reachable and the agent reads the edit like any canvas. One `artifacts.canvas.list` per chat
 * finds the links; a block fetches content only when its visual has an edit. Canvas events keep both up to date.
 */
import {useEffect, useSyncExternalStore} from 'react';
import {invoke} from './bridge';
import {onCanvasEvent} from './artifacts';
import {getState} from './store';
import {richHash} from '../shared/rich-fence';
import type {Canvas, CanvasKind, CanvasSummary, CanvasVersion, CanvasVisual, CanvasVisualKind} from '../shared/domains/artifacts-protocol';

interface ChatEdits {ready: boolean; byKey: Map<string, CanvasSummary>}
const chats = new Map<string, ChatEdits>();
const contents = new Map<string, Canvas>();
const fetching = new Set<string>();
const listeners = new Set<() => void>();
/** #829 part 2: a visual canvas's version list (as of its `version`) and the content of older versions, fetched when shown. */
const versionLists = new Map<string, {version: number; versions: CanvasVersion[]}>();
const versionContents = new Map<string, string>();
const versionFetching = new Set<string>();
let revision = 0;
let offCanvas: (() => void) | undefined;
const summaryOf = ({content, ...rest}: Canvas): CanvasSummary => ({...rest, size: new TextEncoder().encode(content).length});
const notify = () => { revision++; for (const listener of [...listeners]) listener(); };

/** The link key of a fenced visual (its kind and original source) or of a stored render_html page. */
export const visualKey = (kind: Exclude<CanvasVisualKind, 'page'>, source: string): string => `${kind}:${richHash(source)}`;
export const pageVisualKey = (renderId: string): string => `page:${renderId}`;

function follow(): void {
  offCanvas ??= onCanvasEvent(event => {
    if (event.type === 'deleted') {
      for (const entry of chats.values()) for (const [key, summary] of entry.byKey) if (summary.id === event.id) entry.byKey.delete(key);
      contents.delete(event.id); notify(); return;
    }
    const {canvas} = event;
    const entry = canvas.visual && canvas.chatId ? chats.get(canvas.chatId) : undefined;
    if (!entry || !canvas.visual) return;
    entry.byKey.set(canvas.visual.key, canvas);
    notify();
  });
}

function load(chatId: string): ChatEdits {
  follow();
  let entry = chats.get(chatId);
  if (entry) return entry;
  const created: ChatEdits = {ready: false, byKey: new Map()};
  chats.set(chatId, created);
  void invoke('artifacts.canvas.list', {chatId}).then(result => {
    if (chats.get(chatId) !== created) return;
    for (const canvas of result?.canvases ?? []) if (canvas.visual) created.byKey.set(canvas.visual.key, canvas);
  }, () => { /* no edits shown; the visual draws as written */ }).finally(() => { if (chats.get(chatId) === created) { created.ready = true; notify(); } });
  entry = created;
  return entry;
}

function fetchContent(summary: CanvasSummary): void {
  if (fetching.has(summary.id)) return;
  fetching.add(summary.id);
  void invoke('artifacts.canvas.get', {id: summary.id}).then(canvas => { contents.set(canvas.id, canvas); notify(); }, () => {}).finally(() => fetching.delete(summary.id));
}

/** The saved edit of one visual in a chat, or null. `ready` is false until the chat's links are known. */
export function useVisualEdit(chatId: string | undefined, key: string | undefined): {ready: boolean; canvas: Canvas | null} {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision, () => revision);
  const entry = chatId && key ? load(chatId) : undefined;
  const summary = entry && key ? entry.byKey.get(key) : undefined;
  const canvas = summary ? contents.get(summary.id) : undefined;
  const stale = !!summary && (!canvas || canvas.version < summary.version);
  useEffect(() => { if (summary && stale) fetchContent(summary); }, [summary, stale]);
  if (!entry) return {ready: true, canvas: null};
  return {ready: entry.ready && !stale, canvas: canvas ?? null};
}

const useRevision = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision, () => revision);

/** The versions of a visual's canvas, newest first; undefined while they load. Read again when the canvas gains a version. */
export function useVisualVersions(canvas: Pick<Canvas, 'id' | 'version'> | null): CanvasVersion[] | undefined {
  useRevision();
  const known = canvas ? versionLists.get(canvas.id) : undefined;
  const current = !!canvas && known?.version === canvas.version;
  useEffect(() => {
    if (!canvas || current) return;
    const key = `list:${canvas.id}:${canvas.version}`;
    if (versionFetching.has(key)) return;
    versionFetching.add(key);
    void invoke('artifacts.canvas.versions', {id: canvas.id}).then(result => {
      const latest = versionLists.get(canvas.id);
      if (!latest || latest.version <= canvas.version) { versionLists.set(canvas.id, {version: canvas.version, versions: result.versions}); notify(); }
    }, () => {}).finally(() => versionFetching.delete(key));
  }, [canvas?.id, canvas?.version, current]); // eslint-disable-line react-hooks/exhaustive-deps
  return current ? known!.versions : undefined;
}

/** The content of one saved version of a canvas (versions never change once saved); undefined while it loads. */
export function useVisualVersionContent(canvasId: string | undefined, version: number | undefined): string | undefined {
  useRevision();
  const key = canvasId && version ? `${canvasId}:${version}` : undefined;
  const content = key ? versionContents.get(key) : undefined;
  useEffect(() => {
    if (!key || content !== undefined || versionFetching.has(key)) return;
    versionFetching.add(key);
    void invoke('artifacts.canvas.version', {id: canvasId!, version: version!}).then(result => { versionContents.set(key, result.content); notify(); }, () => {}).finally(() => versionFetching.delete(key));
  }, [key, content]); // eslint-disable-line react-hooks/exhaustive-deps
  return content;
}

export interface VisualSave {
  chatId: string; visual: CanvasVisual; title: string;
  /** The visual as the reply drew it: version 1 when this is its first edit. */
  original: string;
  content: string;
  kind: CanvasKind; language?: string;
}
/** Saves an edit as the next version of the visual's canvas (made on the first Save, with the original as version 1). */
export async function saveVisualEdit(input: VisualSave): Promise<Canvas> {
  const entry = load(input.chatId);
  const known = entry.byKey.get(input.visual.key);
  let base: Canvas;
  if (known) base = contents.get(known.id) ?? await invoke('artifacts.canvas.get', {id: known.id});
  else {
    const chat = getState().snapshot?.chats.find(item => item.id === input.chatId);
    base = await invoke('artifacts.canvas.create', {
      kind: input.kind, title: input.title, content: input.original, chatId: input.chatId, visual: input.visual, note: 'Original from the chat',
      ...(input.language ? {language: input.language} : {}), ...(chat?.folderId ? {folderId: chat.folderId} : {}),
    });
  }
  const result = await invoke('artifacts.canvas.update', {id: base.id, content: input.content, baseVersion: base.version, note: 'Edited in the chat'});
  if (result.conflict) {
    contents.set(result.canvas.id, result.canvas); entry.byKey.set(input.visual.key, summaryOf(result.canvas)); notify();
    throw new Error(`${result.canvas.updatedBy === 'agent' ? 'The agent' : 'Someone'} changed this visual while you were editing. Your edit was not saved; Edit again to start from their version.`);
  }
  contents.set(result.canvas.id, result.canvas);
  entry.byKey.set(input.visual.key, summaryOf(result.canvas));
  notify();
  return result.canvas;
}

/** Tests: forget every chat's links and contents, as after a restart. */
export function resetVisualEdits(): void { chats.clear(); contents.clear(); fetching.clear(); versionLists.clear(); versionContents.clear(); versionFetching.clear(); notify(); }
