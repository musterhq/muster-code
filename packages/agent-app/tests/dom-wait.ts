// Waits for the DOM suites: poll for the state the next assertion needs instead of sleeping a fixed time,
// because a loaded CI runner can starve React's render past any fixed sleep (#111, #276).
import {setTimeout as delay} from 'node:timers/promises';

/** Resolves once `ready()` is truthy; fails with `what` after `ms` (generous: it only costs time when something is really wrong). */
export async function until(ready: () => unknown, what: string, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; ; await delay(5)) {
    let value: unknown;
    try { value = ready(); } catch { value = false; }
    if (value) return;
    if (Date.now() >= end) throw new Error(`timed out waiting for ${what}`);
  }
}
