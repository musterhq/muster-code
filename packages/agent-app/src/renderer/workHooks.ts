/**
 * Work-layer data for the renderer (Wave 2): one hook that loads something through `invoke` and reloads it when the runtime
 * says that part of the work layer changed (`workChanged`). No intervals: events only, coalesced over 150 ms.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkEvent } from '../shared/domains/work-protocol';
import { subscribe } from './bridge';

export type WorkScope = WorkEvent['scopes'][number];
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function useWorkLoad<T>(projectId: string | null, scopes: readonly WorkScope[], load: () => Promise<T>, deps: readonly unknown[] = []): { data: T | null; error: string; reload: () => void; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe(event => {
      if (event.type !== 'workChanged') return;
      if (projectId !== null && event.projectId !== null && event.projectId !== projectId) return;
      if (!event.scopes.some(s => scopes.includes(s))) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; setTick(n => n + 1); }, 150);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [projectId, scopes.join(',')]);
  useEffect(() => {
    let live = true;
    loadRef.current().then(data => { if (live) setState({ data, error: '', loading: false }); }, cause => { if (live) setState(s => ({ data: s.data, error: errorText(cause), loading: false })); });
    return () => { live = false; };
  }, [tick, projectId, ...deps]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  return { ...state, reload };
}
