/** How the outbox retries (#394): 30 s after the first failure, doubling to a 30 minute cap, and giving up on an update after about a day. */
export const RETRY_BASE_MS = 30_000, RETRY_MAX_MS = 30 * 60_000, GIVE_UP_MS = 24 * 3_600_000;
/** The wait before the next try after `failures` failed tries in a row (0 failures: the base wait). */
export const retryDelay = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(failures, 16)));
/** The failure count behind the outbox's retry wait. It starts over whenever the outbox is empty, however it got empty (sent, discarded, ended). */
export class OutboxBackoff {
  private failures = 0;
  wait(authBlocked: boolean): number { return authBlocked ? RETRY_BASE_MS : retryDelay(this.failures); }
  /** After a timed flush: one more failure if it ended in an error with posts still waiting, otherwise a fresh start. */
  settled(failed: boolean, pending: number): void { this.failures = failed && pending > 0 ? this.failures + 1 : 0; }
  /** Called whenever the queue is looked at: an empty one resets the wait. */
  observe(pending: number): void { if (pending === 0) this.failures = 0; }
}
/** A short, stable id of the credential a server answered 401 to: a changed key is a different one. Never the key itself. */
export const credentialId = (token: string | undefined): string => { let h = 5381; for (const ch of token ?? '') h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return `${token ? 'key' : 'session'}:${h.toString(36)}:${(token ?? '').length}`; };
/** What a lease-ending change expects to find on the server: it is only sent when the task still looks like this. */
export interface Expect { status?: string; statusNot?: string[]; assigneeUserId?: string | null; assigneeAgentId?: string | null }
/** Why a lease-ending change must not be sent (null when the task still looks as expected). `label`: who holds it now. */
export function whyNotSend(task: { key: string; status: string; assigneeId?: string | null; assigneeUserId?: string | null; assigneeLabel?: string | null } | null, key: string, expect: Expect): string | null {
  if (!task) return `${key} is no longer on the server`;
  if (task.status === 'cancelled') return `${task.key} was cancelled on Muster Server`;
  if (task.status === 'done') return `${task.key} was closed on Muster Server`;
  if (expect.statusNot?.includes(task.status)) return `${task.key} is now ${task.status.replace('_', ' ')} on Muster Server`;
  const agent = task.assigneeId && !task.assigneeId.startsWith('user:') ? task.assigneeId : null;
  if (expect.assigneeUserId !== undefined && (task.assigneeUserId ?? null) !== expect.assigneeUserId) return `${task.key} was reassigned to ${task.assigneeLabel ?? 'someone else'} on Muster Server`;
  if (expect.assigneeAgentId !== undefined && agent !== expect.assigneeAgentId) return `${task.key} was reassigned to ${task.assigneeLabel ?? 'someone else'} on Muster Server`;
  if (expect.status !== undefined && task.status !== expect.status) return `${task.key} is now ${task.status.replace('_', ' ')} on Muster Server`;
  return null;
}
