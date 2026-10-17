/** How long an approval or question waits for the user. Long enough to step away; the deadline is stored on the item. */
export const ATTENTION_WINDOW_MS = 2 * 60 * 60_000;
/** One reminder notification is raised this long before a request expires. */
export const ATTENTION_REMINDER_LEAD_MS = 5 * 60_000;
/** While notifications are muted, a request stays open until the mute ends plus this grace period. */
export const MUTE_GRACE_MS = 10 * 60_000;

/** The deadline for a request raised at `now`. A mute window that outlasts it pushes the deadline to the end of the mute. */
export function attentionDeadline(now: number, mutedUntilMs: number | null): number {
  const base = now + ATTENTION_WINDOW_MS;
  return mutedUntilMs !== null && mutedUntilMs > now ? Math.max(base, mutedUntilMs + MUTE_GRACE_MS) : base;
}

export interface PendingReadInput { status?: string | null; data?: Record<string, unknown> | null }
/**
 * One decision for every read of a request that claims to be pending: past its stored deadline it is `expired`, with no live
 * handler (a previous process) it is `unavailable`, otherwise it stays `pending`. Restart and timeout share this path.
 */
export function pendingStatusAtRead(item: PendingReadInput, now: number, owned: boolean): { status: string; reason?: 'timeout' | 'restart' } {
  const status = item.status ?? '';
  if (status !== 'pending') return { status };
  const expiresAt = typeof item.data?.expiresAt === 'string' ? Date.parse(item.data.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) return { status: 'expired', reason: 'timeout' };
  return owned ? { status: 'pending' } : { status: 'unavailable', reason: 'restart' };
}
