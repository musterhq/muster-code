/**
 * Automatic retry for provider admission rejections (503/429 "at capacity")
 * that provably never dispatched a turn. Resending is safe only then, so every
 * other failure passes straight through.
 */
export const ADMISSION_RETRY_SCHEDULE_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const ADMISSION_RETRY_MAX = ADMISSION_RETRY_SCHEDULE_MS.length;
/** Longest Retry-After Muster waits out inside a run. A longer wait ends the run with the time to try again
 *  (never an earlier retry than the provider asked for, and never a chat held "running" for hours). */
export const RETRY_AFTER_CAP_MS = 5 * 60_000;

export interface AdmissionOutcome { errorMessage?: string; recovery?: {kind: string; retryable?: boolean; reason?: string}; dispatchState?: string; turnId?: string; failure?: {retryAfterMs?: number; statusCode?: number} }
export interface AdmissionWait { attempt: number; max: number; delayMs: number; retryAt: string; reason?: 'admission' | 'transient'; detail?: string }
/** Bounded exponential schedule (1, 2, 4, 8, 16 s) for transient launch/handshake/network failures that provably never dispatched. */
export const TRANSIENT_RETRY_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const TRANSIENT_RETRY_MAX = TRANSIENT_RETRY_SCHEDULE_MS.length;

/** A failed attempt that never reached the provider (no turn id, not dispatched) is safe to resend. */
export function isSafeTransientFailure(result: AdmissionOutcome): boolean {
  return result.recovery?.kind === 'failed' && result.recovery.retryable === true && result.dispatchState === 'not-dispatched' && !result.turnId;
}

export function isSafeAdmissionRejection(result: AdmissionOutcome): boolean {
  return result.recovery?.kind === 'admission-rejected' && result.dispatchState === 'not-dispatched' && !result.turnId;
}

/** attempt is 1-based. Retry-After wins when present (at least 1 s, never shortened); otherwise the schedule with ±20% jitter. */
export function admissionRetryDelay(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.max(Math.ceil(retryAfterMs), 1_000);
  const base = ADMISSION_RETRY_SCHEDULE_MS[Math.min(Math.max(attempt, 1), ADMISSION_RETRY_MAX) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Ends `text` with a full stop unless it already ends a sentence, so a provider's own words read cleanly before ours. */
export const asSentence = (text: string): string => { const trimmed = text.trim(); return !trimmed || /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`; };
/** "3:45:10 PM" today; "Sat, Oct 19, 3:45 PM" on another day. */
export function retryClock(at: string | number, now: number = Date.now()): string {
  const date = new Date(at);
  return date.toDateString() === new Date(now).toDateString() ? date.toLocaleTimeString() : date.toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

export function admissionRetryText(wait: Pick<AdmissionWait, 'attempt' | 'max' | 'delayMs' | 'reason' | 'detail'> & {retryAt?: string}): string {
  if (wait.reason === 'transient') return `Provider attempt did not start. Retrying in ${Math.max(1, Math.round(wait.delayMs / 1000))}s (attempt ${wait.attempt}/${wait.max})`;
  if (wait.detail && wait.retryAt) return `${asSentence(wait.detail)} Retrying at ${retryClock(wait.retryAt)} (attempt ${wait.attempt}/${wait.max})`;
  return `The provider is temporarily unavailable. Retrying in ${Math.max(1, Math.round(wait.delayMs / 1000))}s (attempt ${wait.attempt}/${wait.max})`;
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = (value: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value); };
    const abort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', abort, {once: true});
  });
}

/**
 * Run `attempt`, retrying safe admission rejections up to ADMISSION_RETRY_MAX
 * times. `onWait` fires before each wait. When retries run out or `signal`
 * aborts, the last result is returned with `cancelled` set on abort.
 */
export async function withAdmissionRetry<R extends AdmissionOutcome>(attempt: () => Promise<R>, options: {signal: AbortSignal; onWait(wait: AdmissionWait): void; random?: () => number; now?: () => number}): Promise<{result: R; retries: number; cancelled: boolean; /** Set when the provider's Retry-After exceeded RETRY_AFTER_CAP_MS: the ISO time it asked to be retried at. */ retryAt?: string}> {
  let retries = 0, transient = 0;
  for (;;) {
    const result = await attempt();
    if (isSafeTransientFailure(result) && transient < TRANSIENT_RETRY_MAX && !options.signal.aborted) {
      const delayMs = TRANSIENT_RETRY_SCHEDULE_MS[transient]!;
      transient++;
      options.onWait({attempt: transient, max: TRANSIENT_RETRY_MAX, delayMs, retryAt: new Date((options.now ?? Date.now)() + delayMs).toISOString(), reason: 'transient'});
      if (!(await waitForRetry(delayMs, options.signal))) return {result, retries: retries + transient, cancelled: true};
      continue;
    }
    if (!isSafeAdmissionRejection(result) || retries >= ADMISSION_RETRY_MAX || options.signal.aborted) return {result, retries: retries + transient, cancelled: options.signal.aborted && (isSafeAdmissionRejection(result) || isSafeTransientFailure(result))};
    const delayMs = admissionRetryDelay(retries + 1, result.failure?.retryAfterMs, options.random);
    const now = (options.now ?? Date.now)();
    // Too long to hold the run open (and past 2^31 ms a timer would fire at once): stop and say when to try again.
    if (delayMs > RETRY_AFTER_CAP_MS) return {result, retries: retries + transient, cancelled: false, retryAt: new Date(Math.min(now + delayMs, 8.64e15)).toISOString()};
    retries++;
    options.onWait({attempt: retries, max: ADMISSION_RETRY_MAX, delayMs, retryAt: new Date(now + delayMs).toISOString(), reason: 'admission', ...(result.failure?.statusCode === 429 ? {detail: result.errorMessage ?? result.recovery?.reason} : {})});
    if (!(await waitForRetry(delayMs, options.signal))) return {result, retries, cancelled: true};
  }
}
