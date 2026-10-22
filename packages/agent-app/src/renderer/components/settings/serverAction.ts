import { useCallback, useRef, useState } from 'react';

export type Guarded = <T>(run: () => Promise<T>) => Promise<T | undefined>;

/**
 * One Muster Server settings action at a time per section: a second click while the section's action is running is
 * ignored (a double click makes one invite, not two), and `busy` disables that section's buttons so the wait is visible.
 * Each section has its own lock, so a slow action (a connector test) never holds up the rest of the page. The lock
 * opens when the action settles, failed or not, and also when `run` throws before returning a promise.
 */
export function useServerAction(): { busy: boolean; guarded: Guarded } {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const guarded = useCallback(<T,>(run: () => Promise<T>): Promise<T | undefined> => {
    if (pending.current) return Promise.resolve(undefined);
    pending.current = true; setBusy(true);
    const release = () => { pending.current = false; setBusy(false); };
    try { return run().finally(release); } catch (error) { release(); return Promise.reject(error); }
  }, []) as Guarded;
  return { busy, guarded };
}
