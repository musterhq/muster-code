/**
 * Automatic retry for provider admission rejections (503/429 "at capacity")
 * that provably never dispatched a turn. Resending is safe only then, so every
 * other failure passes straight through.
 */
export const ADMISSION_RETRY_SCHEDULE_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const ADMISSION_RETRY_MAX = ADMISSION_RETRY_SCHEDULE_MS.length;
const RETRY_AFTER_CAP_MS = 5 * 60_000;

export interface AdmissionOutcome { recovery?: {kind: string; retryable?: boolean}; dispatchState?: string; turnId?: string; failure?: {retryAfterMs?: number} }
export interface AdmissionWait { attempt: number; max: number; delayMs: number; retryAt: string; reason?: 'admission' | 'transient' }
/** Short, bounded schedule for transient launch/handshake failures that provably never dispatched. */
export const TRANSIENT_RETRY_SCHEDULE_MS = [750, 2_000] as const;
export const TRANSIENT_RETRY_MAX = TRANSIENT_RETRY_SCHEDULE_MS.length;

/** A failed attempt that never reached the provider (no turn id, not dispatched) is safe to resend. */
export function isSafeTransientFailure(result: AdmissionOutcome): boolean {
  return result.recovery?.kind === 'failed' && result.recovery.retryable === true && result.dispatchState === 'not-dispatched' && !result.turnId;
}

export function isSafeAdmissionRejection(result: AdmissionOutcome): boolean {
  return result.recovery?.kind === 'admission-rejected' && result.dispatchState === 'not-dispatched' && !result.turnId;
}

/** attempt is 1-based. Retry-After wins when present; otherwise the schedule with ±20% jitter. */
export function admissionRetryDelay(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(Math.max(Math.round(retryAfterMs), 1_000), RETRY_AFTER_CAP_MS);
  const base = ADMISSION_RETRY_SCHEDULE_MS[Math.min(Math.max(attempt, 1), ADMISSION_RETRY_MAX) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

export function admissionRetryText(wait: Pick<AdmissionWait, 'attempt' | 'max' | 'delayMs' | 'reason'>): string {
  if (wait.reason === 'transient') return `Provider attempt did not start. Retrying in ${Math.max(1, Math.round(wait.delayMs / 1000))}s (attempt ${wait.attempt}/${wait.max})`;
  return `Provider at capacity. Retrying in ${Math.max(1, Math.round(wait.delayMs / 1000))}s (attempt ${wait.attempt}/${wait.max})`;
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
export async function withAdmissionRetry<R extends AdmissionOutcome>(attempt: () => Promise<R>, options: {signal: AbortSignal; onWait(wait: AdmissionWait): void; random?: () => number; now?: () => number}): Promise<{result: R; retries: number; cancelled: boolean}> {
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
    retries++;
    const delayMs = admissionRetryDelay(retries, result.failure?.retryAfterMs, options.random);
    options.onWait({attempt: retries, max: ADMISSION_RETRY_MAX, delayMs, retryAt: new Date((options.now ?? Date.now)() + delayMs).toISOString(), reason: 'admission'});
    if (!(await waitForRetry(delayMs, options.signal))) return {result, retries, cancelled: true};
  }
}
