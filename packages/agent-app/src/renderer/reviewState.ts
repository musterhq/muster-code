import {useCallback, useEffect, useSyncExternalStore} from 'react';
import type {ReviewBaseline, ReviewBaselineInfo, ReviewChanges, ReviewMark} from '../shared/domains/review-protocol';
import {invoke, subscribe} from './bridge';

/**
 * Renderer-side review state shared by the Changes list, the Diff tab, the
 * file view and the turn pill: the baseline each folder is reviewed against,
 * a chat's turn baselines, change lists per (folder, baseline) that refresh on
 * workspaceChanged, and a run's Keep/Undo marks. One cache entry per key, so
 * every surface shows the same answer without refetching it.
 */
interface Entry<T> {value?: T; error?: string; loading: boolean; version: number}
const entries = new Map<string, Entry<unknown>>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();
/** Keys asked for again while a fetch was running: one more fetch follows, so a change made mid-fetch is never missed. */
const again = new Set<string>();
const notify = () => { for (const listener of listeners) listener(); };
const listen = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const EMPTY: Entry<never> = {loading: false, version: 0};

function put<T>(key: string, patch: Partial<Entry<T>>): void {
  const previous = entries.get(key) ?? EMPTY;
  // Least recently written first, so the cap drops lists no longer on screen, never the one being refreshed.
  entries.delete(key);
  entries.set(key, {...previous, ...patch, version: previous.version + 1});
  if (entries.size > 128) entries.delete(entries.keys().next().value!);
  notify();
}

function load<T>(key: string, fetch: () => Promise<T>): Promise<void> {
  const running = inflight.get(key);
  if (running) { again.add(key); return running; }
  put<T>(key, {loading: true});
  const task = fetch().then(value => put<T>(key, {value, error: undefined, loading: false}), cause => put<T>(key, {error: cause instanceof Error ? cause.message : String(cause), loading: false}))
    .finally(() => { inflight.delete(key); if (again.delete(key)) void load(key, fetch); });
  inflight.set(key, task);
  return task;
}

function useEntry<T>(key: string | null): Entry<T> {
  return useSyncExternalStore(listen, () => (key ? entries.get(key) ?? EMPTY : EMPTY) as Entry<T>);
}

export function baselineKey(baseline: ReviewBaseline): string { return typeof baseline === 'string' ? baseline : 'ref' in baseline ? `ref:${baseline.ref}` : `run:${baseline.runId}`; }
export const sameBaseline = (a: ReviewBaseline, b: ReviewBaseline) => baselineKey(a) === baselineKey(b);

// ---------------------------------------------------------------------------
// Per-folder baseline selection (session only: a restart reviews against HEAD again).

const selected = new Map<string, ReviewBaseline>();
export function reviewBaselineFor(folderId: string): ReviewBaseline { return selected.get(folderId) ?? 'head'; }
export function setReviewBaseline(folderId: string, baseline: ReviewBaseline): void {
  if (sameBaseline(reviewBaselineFor(folderId), baseline)) return;
  selected.set(folderId, baseline); notify();
}
export function useReviewBaseline(folderId: string | undefined): [ReviewBaseline, (baseline: ReviewBaseline) => void] {
  const baseline = useSyncExternalStore(listen, () => folderId ? reviewBaselineFor(folderId) : 'head');
  return [baseline, useCallback((next: ReviewBaseline) => { if (folderId) setReviewBaseline(folderId, next); }, [folderId])];
}

// ---------------------------------------------------------------------------
// Turn baselines of a chat. `stamp` (the chat status / last item) refetches after a new turn starts.

export function refreshChatBaselines(chatId: string): Promise<void> {
  return load(`baselines:${chatId}`, async () => (await invoke('review.baselines', {chatId})) ?? []);
}
export function useChatBaselines(chatId: string | undefined, stamp?: string): ReviewBaselineInfo[] {
  const entry = useEntry<ReviewBaselineInfo[]>(chatId ? `baselines:${chatId}` : null);
  useEffect(() => { if (chatId) void refreshChatBaselines(chatId); }, [chatId, stamp]);
  return entry.value ?? [];
}
/** The chat's latest turn in this folder, when it has a snapshot (a turn without one never falls back to an older baseline). */
export function latestBaseline(baselines: readonly ReviewBaselineInfo[], folderId: string | undefined): ReviewBaselineInfo | undefined {
  for (let index = baselines.length - 1; index >= 0; index--) {
    const info = baselines[index];
    if (!folderId || !info.folderId || info.folderId === folderId) return info.treeSha ? info : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Change lists per folder + baseline, refreshed (debounced) on workspaceChanged.

const changesKey = (folderId: string, baseline: ReviewBaseline) => `changes:${folderId}:${baselineKey(baseline)}`;
export function refreshReviewChanges(folderId: string, baseline: ReviewBaseline): Promise<void> {
  return load(changesKey(folderId, baseline), () => invoke('review.changes', {folderId, baseline}));
}
export function useReviewChanges(folderId: string | undefined, baseline: ReviewBaseline | undefined): Entry<ReviewChanges> {
  const key = folderId && baseline ? changesKey(folderId, baseline) : null;
  const entry = useEntry<ReviewChanges>(key);
  useEffect(() => {
    if (!folderId || !baseline) return;
    void refreshReviewChanges(folderId, baseline);
    return onWorkspaceChanged(folderId, () => void refreshReviewChanges(folderId, baseline));
  }, [key]);
  return entry;
}

/** Debounced workspaceChanged for one folder. */
export function onWorkspaceChanged(folderId: string, run: () => void, delay = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = subscribe(event => {
    if (event.type !== 'workspaceChanged' || event.folderId !== folderId) return;
    clearTimeout(timer); timer = setTimeout(run, delay);
  });
  return () => { off(); clearTimeout(timer); };
}

// ---------------------------------------------------------------------------
// Keep/Undo marks of a run.

export function refreshRunMarks(runId: string): Promise<void> {
  return load(`marks:${runId}`, async () => (await invoke('review.marks', {runId})) ?? []);
}
export function useRunMarks(runId: string | undefined): ReviewMark[] {
  const entry = useEntry<ReviewMark[]>(runId ? `marks:${runId}` : null);
  useEffect(() => { if (runId) void refreshRunMarks(runId); }, [runId]);
  return entry.value ?? [];
}
export async function keepHunks(runId: string, path: string, hunkIds: string[]): Promise<void> {
  if (!hunkIds.length) return;
  const marks = await invoke('review.keep', {runId, path, hunkIds});
  put(`marks:${runId}`, {value: marks, loading: false});
}
/** Kept hunk ids (and '*' for a whole file) of one path. */
export function keptFor(marks: readonly ReviewMark[], path: string): Set<string> {
  return new Set(marks.filter(mark => mark.path === path && mark.state === 'kept').map(mark => mark.hunkId));
}

// ---------------------------------------------------------------------------
// Review comments as composer context (DIF-10).

/**
 * Hand a review range to the composer as a chip. The composer acknowledges
 * with preventDefault(); otherwise the text is copied so nothing is lost.
 * Returns what happened, for the caller's status line.
 */
export async function addReviewContext(detail: {label: string; text: string; source: Record<string, unknown>}): Promise<'added' | 'copied' | 'failed'> {
  const accepted = !window.dispatchEvent(new CustomEvent('muster:composer-add-context', {detail: {id: `review:${crypto.randomUUID()}`, type: 'review', ...detail}, cancelable: true}));
  if (accepted) return 'added';
  try { await invoke('clipboard.write', {text: `${detail.label}\n\n${detail.text}`}); return 'copied'; } catch { return 'failed'; }
}

/** Labels for the baseline menus: 'Last agent turn' for the latest run, 'Turn n · time' for earlier ones. */
export function baselineLabel(baseline: ReviewBaseline, turns: readonly ReviewBaselineInfo[]): string {
  if (baseline === 'head') return 'Last commit';
  if (baseline === 'staged') return 'Staged only';
  if (baseline === 'unstaged') return 'Unstaged only';
  if ('ref' in baseline) return baseline.ref;
  const usable = turns.filter(turn => turn.treeSha);
  const index = usable.findIndex(turn => turn.runId === baseline.runId);
  if (index < 0) return 'Agent turn';
  return index === usable.length - 1 ? 'Last agent turn' : `Since turn ${index + 1} · ${timeLabel(usable[index].at)}`;
}
export function timeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}

/** TRN-18: after a turn ends, re-read the chat's baselines and the latest turn's review, so "Ready to review" means the diff is current. */
/** Rejects when either read fails (load() keeps the error on the entry instead of throwing), so the turn pill
 *  can show a failed preparation with Retry instead of "Ready to review" (TRN-18). */
export async function prepareTurnReview(chatId: string, folderId: string): Promise<void> {
  await refreshChatBaselines(chatId);
  const baselines = entries.get(`baselines:${chatId}`);
  if (baselines?.error) throw new Error(baselines.error);
  const info = latestBaseline((baselines?.value as ReviewBaselineInfo[] | undefined) ?? [], folderId);
  if (!info) return;
  await refreshReviewChanges(folderId, {runId: info.runId});
  const changes = entries.get(changesKey(folderId, {runId: info.runId}));
  if (changes?.error) throw new Error(changes.error);
}
