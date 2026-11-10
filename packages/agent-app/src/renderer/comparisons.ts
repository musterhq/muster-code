/** #175: the comparisons the runtime keeps (one prompt run on several agents), live through `comparison` events. */
import {useEffect, useSyncExternalStore} from 'react';
import type {Comparison, CompareTarget} from '../shared/domains/compare-protocol';
import {invoke, subscribe} from './bridge';

let list: readonly Comparison[] = [];
let loaded = false, loading: Promise<void> | null = null, wired = false;
const listeners = new Set<() => void>();
const publish = (next: readonly Comparison[]) => { list = next; for (const listener of listeners) listener(); };

function wire(): void {
  if (wired) return;
  wired = true;
  subscribe(event => {
    if (event.type !== 'comparison') return;
    const next = list.filter(entry => entry.id !== event.comparison.id);
    publish([event.comparison, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
}
export function loadComparisons(force = false): Promise<void> {
  wire();
  if ((loaded && !force) || loading) return loading ?? Promise.resolve();
  loading = invoke('compare.list', undefined).then(value => { loaded = true; publish(Array.isArray(value) ? value : []); }, () => undefined).finally(() => { loading = null; });
  return loading;
}
/** Every comparison, newest first. Loads on first use. */
export function useComparisons(): readonly Comparison[] {
  useEffect(() => { void loadComparisons(); }, []);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => list, () => list);
}
/** The comparison a chat is a run of, if any. */
export function comparisonOf(comparisons: readonly Comparison[], chatId: string | null | undefined): Comparison | undefined {
  return chatId ? comparisons.find(entry => entry.runs.some(run => run.chatId === chatId)) : undefined;
}
export async function startComparison(input: {chatId: string; text: string; targets: CompareTarget[]; attachmentIds?: string[]; skillIds?: string[]; pluginIds?: string[]; effort?: Parameters<typeof invoke<'compare.start'>>[1]['effort']}): Promise<Comparison> {
  wire();
  const comparison = await invoke('compare.start', {...input, requestId: crypto.randomUUID()});
  if (comparison) publish([comparison, ...list.filter(entry => entry.id !== comparison.id)]);
  return comparison;
}
