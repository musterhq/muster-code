/** Insight data for the renderer (Wave 3): loads something through `invoke` and reloads it when the runtime says the coach or the studio changed. Events only, coalesced over 150 ms; no intervals. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InsightEvent } from '../shared/domains/insight-protocol';
import { subscribe } from './bridge';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export function useInsightLoad<T>(projectId: string | null, scope: InsightEvent['scopes'][number], load: () => Promise<T>, deps: readonly unknown[] = []): { data: T | null; error: string; reload: () => void; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe(event => {
      if (event.type !== 'insightChanged' || !event.scopes.includes(scope)) return;
      if (projectId !== null && event.projectId !== null && event.projectId !== projectId) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; setTick(n => n + 1); }, 150);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [projectId, scope]);
  useEffect(() => {
    let live = true;
    loadRef.current().then(data => { if (live) setState({ data, error: '', loading: false }); }, cause => { if (live) setState(s => ({ data: s.data, error: errorText(cause), loading: false })); });
    return () => { live = false; };
  }, [tick, projectId, ...deps]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  return { ...state, reload };
}
