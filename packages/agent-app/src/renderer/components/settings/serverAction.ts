import { useSyncExternalStore } from 'react';

let pending = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Runs one Muster Server settings action at a time; a second click while one is in flight is ignored. */
export function guarded<T>(run: () => Promise<T>): Promise<T | undefined> {
  if (pending > 0) return Promise.resolve(undefined);
  pending++; emit();
  return run().finally(() => { pending--; emit(); });
}

export function useActionPending(): boolean {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => pending > 0, () => false);
}
