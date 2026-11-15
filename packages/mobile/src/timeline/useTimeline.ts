/** React bindings for the timeline store: the list follows the ids, each row follows only its own item. */
import {useSyncExternalStore} from 'react';
import type {MobileItem} from '../shared';
import type {TimelineStore} from './store';

export const useTimelineIds = (store: TimelineStore): readonly string[] => useSyncExternalStore(store.subscribeIds, store.getIds);
export function useTimelineItem(store: TimelineStore, id: string): MobileItem | undefined {
  return useSyncExternalStore(listener => store.subscribeItem(id, listener), () => store.getItem(id));
}
