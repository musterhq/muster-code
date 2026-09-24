/** Pure main-process shell policies: dock attention and renderer crash recovery.
 *  Electron-free so they run under node:test. */

export interface BadgeUpdate {
  /** '' clears the badge. */
  badge: string;
  bounce: boolean;
}

/** Badge the dock while input is pending and the window is not in front; bounce once per increase. */
export function attentionBadge(previous: number, next: number, focused: boolean): BadgeUpdate | null {
  if (focused) return previous === 0 && next === 0 ? null : { badge: '', bounce: false };
  if (next === previous) return null;
  return { badge: next > 0 ? String(next) : '', bounce: next > previous };
}

export type CrashDecision = 'reload' | 'ask';

/** One automatic reload per window; a second renderer loss inside the window asks the user instead of looping. */
export function createCrashTracker(windowMs = 60_000) {
  let lastCrashAt: number | null = null;
  return {
    record(now: number): CrashDecision {
      const repeat = lastCrashAt !== null && now - lastCrashAt < windowMs;
      lastCrashAt = now;
      return repeat ? 'ask' : 'reload';
    },
  };
}

/** Exit reasons that mean the renderer died rather than finished; a clean exit (reload, navigation) is not a crash. */
export function isRendererCrash(reason: string): boolean {
  return reason !== 'clean-exit';
}
