import { useRef, useSyncExternalStore } from 'react';
import { getState, subscribeStore, type AppState } from './store';

export function useStore(): AppState {
  return useSyncExternalStore(subscribeStore, getState);
}

/** Select a stable stored value; do not allocate an object in the selector. */
export function useStoreSelector<T>(select:(state:AppState)=>T):T {
  return useSyncExternalStore(subscribeStore,()=>select(getState()));
}

/**
 * Subscribe to a few top-level store keys. The returned object keeps its identity until one of
 * those keys changes (Object.is), so a keystroke (`composerDrafts`) or a timeline patch
 * (`timelines`) only re-renders the components that actually read it.
 */
export function useStoreSlice<K extends keyof AppState>(...keys:K[]):Pick<AppState,K> {
  const last=useRef<Pick<AppState,K>|null>(null);
  return useSyncExternalStore(subscribeStore,()=>{
    const state=getState(),prev=last.current;
    if(prev&&keys.every(key=>Object.is(prev[key],state[key])))return prev;
    const next={} as Pick<AppState,K>;
    for(const key of keys)next[key]=state[key];
    last.current=next;
    return next;
  });
}
