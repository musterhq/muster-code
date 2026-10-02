/** Wave 4 data for the renderer: load something through `invoke`, reload it when the runtime says it changed. Events only, coalesced over 150 ms; no intervals. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../shared/protocol';
import { subscribe } from './bridge';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function useEventLoad<T>(relevant: (event: AgentEvent) => boolean, load: () => Promise<T>, deps: readonly unknown[] = []): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load); loadRef.current = load;
  const matchRef = useRef(relevant); matchRef.current = relevant;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe(event => { if (!matchRef.current(event) || timer) return; timer = setTimeout(() => { timer = null; setTick(n => n + 1); }, 150); });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);
  useEffect(() => {
    let live = true;
    loadRef.current().then(data => { if (live) setState({ data, error: '', loading: false }); }, cause => { if (live) setState(s => ({ data: s.data, error: errorText(cause), loading: false })); });
    return () => { live = false; };
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  return { ...state, reload };
}

/** A File as base64, in chunks so a large package does not overflow the call stack. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
/** Saves base64 bytes as a file through the browser's download (the desktop shell and the web UI both honour it). */
export function downloadBase64(name: string, base64: string, type = 'application/zip'): void {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
