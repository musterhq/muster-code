/** Computer-use PiP model: live frames, placement, freshness and the right-pane viewer. The pure helpers are tested
 * directly; the small store below holds only per-window UI state and the latest frame per chat. */
import {useSyncExternalStore} from 'react';
import type {TimelineItem} from '../shared/protocol.ts';
import type {ComputerControlOwner, ComputerFrame} from '../shared/domains/computer-protocol.ts';
import {computerAction, computerUseTarget, type ComputerTarget} from '../shared/computer-use.ts';
import {subscribe} from './bridge.ts';

export type Corner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export const PIP_MIN = 220, PIP_MAX = 480, PIP_DEFAULT = 300;
/** Cards in the PiP stack: one per app, window or page the agent used lately (Codex). */
export const PIP_STACK_MAX = 4;
/** CUA-09: a frame older than this is stale; older than the second, the feed is disconnected. */
export const STALE_MS = 2000, DISCONNECTED_MS = 10_000;
/** The PiP goes away this long after the last computer-use activity once the run is idle. */
export const HIDE_AFTER_MS = 45_000;
export interface ToolShot {id?: string; dataUrl?: string; mime?: string; width?: number; height?: number; bytes?: number}
/** What the PiP shows: a pushed browser frame or the newest computer-use screenshot in the transcript. */
export interface PipSource {
  chatId: string; target: ComputerTarget; app: string; label: string; at: number;
  image?: ToolShot; url?: string; owner?: string; profileId?: string; itemId?: string; running?: boolean; failed?: string;
}
export interface PipPlacement {corner: Corner; width: number}

export const clampPipWidth = (width: number) => Math.round(Math.min(PIP_MAX, Math.max(PIP_MIN, Number.isFinite(width) ? width : PIP_DEFAULT)));
/** The corner nearest a dropped PiP's centre, within the conversation rectangle. */
export function snapCorner(center: {x: number; y: number}, area: {left: number; top: number; width: number; height: number}): Corner {
  const right = center.x >= area.left + area.width / 2, bottom = center.y >= area.top + area.height / 2;
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`;
}
/** Where the PiP sits (fixed-position CSS) for a corner of the conversation area. */
export function cornerPosition(corner: Corner, area: {left: number; top: number; width: number; height: number}, size: {width: number; height: number}, inset: {top: number; right: number; bottom: number; left: number}) {
  const x = corner.endsWith('right') ? area.left + area.width - inset.right - size.width : area.left + inset.left;
  const y = corner.startsWith('bottom') ? area.top + area.height - inset.bottom - size.height : area.top + inset.top;
  return {x: Math.max(area.left, Math.round(x)), y: Math.max(area.top, Math.round(y))};
}
export interface Box {left: number; top: number; right: number; bottom: number; width: number; height: number}
/** Stack metrics: gap under the summary card, inset from the conversation edge, how far each older card peeks. */
export const STACK_GAP = 10, STACK_EDGE = 14, STACK_PEEK = 9, STACK_WIDTH = 280;
/** The stack's cards are 16:10; each older card peeks above the one in front of it. */
export const stackHeight = (width: number, count: number) => Math.round(width * 0.625) + STACK_PEEK * Math.max(0, Math.min(count, PIP_STACK_MAX) - 1);
export const stackWidth = (card: Box | undefined) => Math.round(Math.min(320, Math.max(PIP_MIN, card?.width ?? STACK_WIDTH)));
/** Codex: the stack floats at the conversation's right, just under the summary card; beside the card when
 * there is no room under it, and under the chat header (where the card would be) when the card is hidden.
 * `right` is the CSS distance from the viewport's right edge. */
export function stackAnchor(center: Box | undefined, card: Box | undefined, vars: {top: number; bottom: number}, size: {width: number; height: number}, viewportWidth: number): {right: number; top: number} {
  if (!center) return {right: STACK_EDGE, top: 56};
  const floor = center.bottom - vars.bottom;
  let right: number, top: number;
  if (card) {
    const below = card.bottom + STACK_GAP;
    if (below + size.height <= floor) { right = viewportWidth - card.right; top = below; }
    else { right = viewportWidth - card.left + STACK_GAP; top = card.top; }
  } else { right = viewportWidth - center.right + STACK_EDGE; top = center.top + vars.top; }
  return {right: Math.max(0, Math.round(right)), top: Math.round(Math.max(center.top, top))};
}
export type Freshness = 'live' | 'stale' | 'disconnected' | 'ended';
export function frameFreshness(ageMs: number, running: boolean): Freshness {
  if (!running) return 'ended';
  return ageMs < STALE_MS ? 'live' : ageMs < DISCONNECTED_MS ? 'stale' : 'disconnected';
}
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 1 ? 'now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
const shots = (data: Record<string, unknown> | undefined): ToolShot[] => Array.isArray(data?.images) ? (data!.images as unknown[]).filter((image): image is ToolShot => !!image && typeof image === 'object' && (typeof (image as ToolShot).id === 'string' || typeof (image as ToolShot).dataUrl === 'string')) : [];
export const toolShots = shots;
const errorText = (data: Record<string, unknown> | undefined): string => {
  const raw = data?.error;
  if (typeof raw !== 'string') return '';
  try { const parsed = JSON.parse(raw); return typeof parsed === 'string' ? parsed : typeof parsed?.message === 'string' ? parsed.message : raw; } catch { return raw; }
};
/** The newest computer-use step of a transcript, carrying the newest screenshot seen at or before it. Bounded scan. */
export function latestComputerShot(items: readonly TimelineItem[], limit = 400): PipSource | undefined {
  let step: PipSource | undefined;
  for (let index = items.length - 1, seen = 0; index >= 0 && seen < limit; index--, seen++) {
    const item = items[index]!;
    if (item.kind !== 'tool') continue;
    const target = computerUseTarget(item.data);
    if (!target) continue;
    const images = shots(item.data), at = Date.parse(item.createdAt) || 0;
    if (!step) {
      const action = computerAction(item.data)!;
      step = {chatId: item.chatId, target, app: action.app, label: item.status === 'running' ? `${action.runningVerb}${action.label.slice(action.verb.length)}` : action.label, at, itemId: item.id, running: item.status === 'running', ...(item.status === 'failed' ? {failed: errorText(item.data) || 'The last step failed.'} : {}), ...(action.url ? {url: action.url} : {})};
    }
    if (images.length) { step.image = images.at(-1); if (!step.app) step.app = computerAction(item.data)?.app ?? ''; return step; }
  }
  return step;
}
/** Newest of a pushed browser frame and the transcript's computer-use step. */
export function pickSource(frame: PipSource | undefined, shot: PipSource | undefined): PipSource | undefined {
  if (!frame) return shot; if (!shot) return frame;
  // A transcript step newer than the last frame still wins its label, but keeps the fresher picture.
  return shot.at > frame.at ? {...shot, image: shot.image ?? frame.image, owner: frame.owner, profileId: frame.profileId, url: shot.url ?? frame.url} : frame;
}
/** Which card a source belongs to: a browser page by host, a desktop app by name. */
export function sourceKey(source: Pick<PipSource, 'target' | 'app' | 'url'>): string {
  if (source.target === 'browser') return `browser:${source.url ? hostOf(source.url) : (source.app || 'browser').toLowerCase()}`;
  return `app:${(source.app || 'screen').toLowerCase()}`;
}
/** The chat's recently used apps and pages, newest first, each with its own newest step and screenshot.
 * Browser steps without a URL belong to the page the last navigation opened. Bounded scan of the tail. */
export function recentComputerSources(items: readonly TimelineItem[], limit = 400, max = PIP_STACK_MAX): PipSource[] {
  const byKey = new Map<string, PipSource>();
  let page = '';
  for (let index = Math.max(0, items.length - limit); index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== 'tool') continue;
    const action = computerAction(item.data);
    if (!action) continue;
    if (action.target === 'browser' && action.url) page = action.url;
    const url = action.url || (action.target === 'browser' ? page : '');
    const running = item.status === 'running';
    const step: PipSource = {chatId: item.chatId, target: action.target, app: action.app, label: running ? `${action.runningVerb}${action.label.slice(action.verb.length)}` : action.label, at: Date.parse(item.createdAt) || 0, itemId: item.id, running, ...(item.status === 'failed' ? {failed: errorText(item.data) || 'The last step failed.'} : {}), ...(url ? {url} : {})};
    const key = sourceKey(step), prior = byKey.get(key), image = shots(item.data).at(-1) ?? prior?.image;
    byKey.delete(key);
    byKey.set(key, {...step, ...(image ? {image} : {})});
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, max);
}
/** Pushed browser frames and transcript steps, one card per source (pickSource per match), newest first. */
export function mergeSources(frames: readonly PipSource[], steps: readonly PipSource[], max = PIP_STACK_MAX): PipSource[] {
  const byKey = new Map<string, PipSource>();
  for (const step of steps) byKey.set(sourceKey(step), step);
  for (const frame of frames) { const key = sourceKey(frame); byKey.set(key, pickSource(frame, byKey.get(key))!); }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, max);
}
export function pipShouldShow(source: PipSource | undefined, running: boolean, now: number): boolean {
  return !!source && (running || now - source.at < HIDE_AFTER_MS);
}
export function frameSource(frame: ComputerFrame): PipSource {
  return {chatId: frame.chatId, target: 'browser', app: frame.title || hostOf(frame.url), label: frame.action ?? (frame.title || hostOf(frame.url)), at: frame.at, image: {dataUrl: frame.dataUrl, width: frame.width, height: frame.height, mime: 'image/jpeg'}, url: frame.url, owner: frame.owner, profileId: frame.profileId};
}
export const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };

// --- Per-window store -------------------------------------------------------
const PLACEMENT_KEY = 'muster.computerPip';
interface ViewerTarget {chatId: string; live: boolean; source?: PipSource}
interface ComputerUiState {
  frames: Record<string, PipSource>;
  /** chatId → the last few distinct pages the agent's browser pushed frames for, newest first. */
  recentFrames: Record<string, PipSource[]>;
  control: Record<string, ComputerControlOwner>;
  placement: PipPlacement;
  minimized: boolean;
  docked: boolean;
  viewer: ViewerTarget | null;
  /** chatId → the newest agent browser tab main opened for it. */
  browsers: Record<string, {owner: string; profileId: string; url: string}>;
}
function loadPlacement(): PipPlacement {
  try {
    const value = JSON.parse(localStorage.getItem(PLACEMENT_KEY) ?? 'null');
    if (value && ['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(value.corner)) return {corner: value.corner, width: clampPipWidth(value.width)};
  } catch {}
  return {corner: 'top-right', width: PIP_DEFAULT};
}
let ui: ComputerUiState = {frames: {}, recentFrames: {}, control: {}, placement: typeof localStorage === 'undefined' ? {corner: 'top-right', width: PIP_DEFAULT} : loadPlacement(), minimized: false, docked: false, viewer: null, browsers: {}};
const listeners = new Set<() => void>();
function set(patch: Partial<ComputerUiState>): void { ui = {...ui, ...patch}; for (const listener of listeners) listener(); }
export function computerUi(): ComputerUiState { return ui; }
export function useComputerUi(): ComputerUiState { return useSyncExternalStore(subscribeUi, computerUi); }
function subscribeUi(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

export function setPlacement(placement: Partial<PipPlacement>): void {
  const next = {...ui.placement, ...placement, width: clampPipWidth(placement.width ?? ui.placement.width)};
  set({placement: next});
  try { localStorage.setItem(PLACEMENT_KEY, JSON.stringify(next)); } catch {}
}
export const setMinimized = (minimized: boolean) => set({minimized});
export const setDocked = (docked: boolean) => set({docked, ...(docked ? {minimized: false} : {})});
export const openViewer = (target: ViewerTarget) => set({viewer: target});
export const closeViewer = () => set({viewer: null, docked: false});
export function applyComputerEvent(event: {type: string; [key: string]: unknown}): void {
  if (event.type === 'computerFrame') {
    const frame = event.frame as ComputerFrame;
    const source = frameSource(frame), key = sourceKey(source);
    const frames = {...ui.frames, [frame.chatId]: source};
    const ids = Object.keys(frames).filter(id => id !== frame.chatId);
    if (ids.length >= 16) delete frames[ids.sort((a, b) => frames[a]!.at - frames[b]!.at)[0]!];
    const recentFrames = {...ui.recentFrames, [frame.chatId]: [source, ...(ui.recentFrames[frame.chatId] ?? []).filter(prior => sourceKey(prior) !== key)].slice(0, PIP_STACK_MAX)};
    for (const id of Object.keys(recentFrames)) if (!frames[id]) delete recentFrames[id];
    set({frames, recentFrames});
  } else if (event.type === 'computerControl') set({control: bounded({...ui.control, [String(event.chatId)]: event.owner as ComputerControlOwner})});
  else if (event.type === 'computerBrowserOpened') set({browsers: bounded({...ui.browsers, [String(event.chatId)]: {owner: String(event.owner), profileId: String(event.profileId), url: String(event.url)}})});
}
/** Keeps a per-chat record from growing without bound over a long session; oldest entry dropped first. */
function bounded<T>(record: Record<string, T>, limit = 64): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  const next = {...record};
  for (const key of keys.slice(0, keys.length - limit)) delete next[key];
  return next;
}
let wired = 0, unsubscribe: (() => void) | undefined;
/** Components call this in an effect; one bridge subscription serves every consumer. */
export function wireComputerEvents(onEvent?: (event: {type: string; [key: string]: unknown}) => void): () => void {
  if (!wired++) unsubscribe = subscribe(event => { applyComputerEvent(event as {type: string}); onEvent?.(event as {type: string}); });
  return () => { if (!--wired) { unsubscribe?.(); unsubscribe = undefined; } };
}

// --- Full-resolution screenshots ---------------------------------------------
const IMAGE_CACHE_LIMIT = 24;
const imageCache = new Map<string, Promise<string>>();
/** The data URL of a tool screenshot: inline when the runtime kept it inline, else fetched once by id and cached. */
export function toolImageUrl(shot: ToolShot | undefined, load: (id: string) => Promise<{dataUrl: string}>): Promise<string> {
  if (!shot) return Promise.reject(new Error('No screenshot.'));
  if (shot.dataUrl) return Promise.resolve(shot.dataUrl);
  const id = shot.id;
  if (!id) return Promise.reject(new Error('No screenshot.'));
  let pending = imageCache.get(id);
  if (!pending) {
    pending = load(id).then(image => image.dataUrl);
    pending.catch(() => imageCache.delete(id));
    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(id, pending);
  }
  return pending;
}
/** File name for an exported screenshot: app or host, action and time. */
export function screenshotName(source: Pick<PipSource, 'app' | 'label' | 'at'>, mime = 'image/png'): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
  const slug = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40);
  const stamp = new Date(source.at || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return [slug(source.app) || 'screen', slug(source.label), stamp].filter(Boolean).join('-') + '.' + ext;
}
