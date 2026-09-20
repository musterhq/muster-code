import { useSyncExternalStore } from 'react';
import { getState, subscribeStore, type AppState } from './store';

export function useStore(): AppState {
  return useSyncExternalStore(subscribeStore, getState);
}

/** Select a stable stored value; do not allocate an object in the selector. */
export function useStoreSelector<T>(select:(state:AppState)=>T):T {
  return useSyncExternalStore(subscribeStore,()=>select(getState()));
}
