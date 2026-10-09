import {useEffect, useState} from 'react';

/**
 * Idle work gate (#356). A window the user is not looking at (hidden, minimized, or visible but without focus) must cost
 * ~nothing: CSS animations pause (styles.css, `:root[data-window-active='false']`), and polling or clock timers started through
 * `startActiveInterval` skip their ticks and catch up once when the window is active again.
 */
export function windowActive(doc: Pick<Document, 'visibilityState' | 'hasFocus'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  if (!doc) return true;
  if (doc.visibilityState === 'hidden') return false;
  return typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
}

const listeners = new Set<(active: boolean) => void>();
let installed = 0, last = true, detach: (() => void) | undefined;

function sync(): void {
  const next = windowActive();
  if (typeof document !== 'undefined') document.documentElement.dataset.windowActive = String(next);
  if (next === last) return;
  last = next;
  for (const listener of [...listeners]) listener(next);
}

/** Starts mirroring activity onto `<html data-window-active>`; returns a disposer. Idempotent (ref-counted). */
export function installWindowActivity(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  if (!installed++) {
    last = windowActive();
    document.documentElement.dataset.windowActive = String(last);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    detach = () => { document.removeEventListener('visibilitychange', sync); window.removeEventListener('focus', sync); window.removeEventListener('blur', sync); };
  }
  return () => { if (!--installed) { detach?.(); detach = undefined; } };
}

export function isWindowActive(): boolean { return installed ? last : windowActive(); }
export function onWindowActivity(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * setInterval that only does work while the window is active. A tick that was skipped runs once when the window returns
 * (if at least `ms` have passed), so a label or poll is fresh the moment the user looks again.
 */
export function startActiveInterval(run: () => void, ms: number): () => void {
  let lastRun = Date.now();
  const fire = () => { lastRun = Date.now(); run(); };
  const timer = setInterval(() => { if (isWindowActive()) fire(); }, ms);
  const off = onWindowActivity(active => { if (active && Date.now() - lastRun >= ms) fire(); });
  return () => { clearInterval(timer); off(); };
}

/** `Date.now()` refreshed every `ms` (30-60 s for relative-time labels), only while the window is active. */
export function useActiveNow(ms = 60_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return startActiveInterval(() => setNow(Date.now()), ms);
  }, [ms, enabled]);
  return now;
}
