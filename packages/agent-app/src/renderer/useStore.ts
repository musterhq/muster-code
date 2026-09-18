import { useSyncExternalStore } from 'react';
import { getState, subscribeStore, type AppState } from './store';

export function useStore(): AppState {
  return useSyncExternalStore(subscribeStore, getState);
}
