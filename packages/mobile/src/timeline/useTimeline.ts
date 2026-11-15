/** React bindings for the timeline store: the list follows the ids, each row follows only its own item. */
import {useCallback, useMemo, useSyncExternalStore} from 'react';
import type {MobileItem} from '../shared';
import type {TimelineStore} from './store';

export const useTimelineIds = (store: TimelineStore): readonly string[] => useSyncExternalStore(store.subscribeIds, store.getIds);
export function useTimelineItem(store: TimelineStore, id: string): MobileItem | undefined {
  return useSyncExternalStore(listener => store.subscribeItem(id, listener), () => store.getItem(id));
}
/** Several items, followed together (a work capsule's steps): a new array only when one of them changed. */
export function useTimelineItems(store: TimelineStore, ids: readonly string[]): MobileItem[] {
  const key = ids.join('\n');
  const cache = useMemo(() => ({items: [] as MobileItem[]}), [key]);
  const subscribe = useCallback((listener: () => void) => { const offs = ids.map(id => store.subscribeItem(id, listener)); return () => { for (const off of offs) off(); }; }, [store, key]);
  return useSyncExternalStore(subscribe, () => {
    const now = ids.map(id => store.getItem(id)).filter((item): item is MobileItem => Boolean(item));
    if (now.length !== cache.items.length || now.some((item, index) => item !== cache.items[index])) cache.items = now;
    return cache.items;
  });
}
