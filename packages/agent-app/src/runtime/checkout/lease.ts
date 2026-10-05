/**
 * The check-out lease (#117), as a state machine with no I/O.
 *
 * Paperclip has no time-based lock and no way for a client to hold a run-bound one, so Muster builds the lease from what every Paperclip has:
 * the task's human assignee (assigneeUserId) plus a structured footer on Muster's own check-out comment. "Checked out" means: the task is
 * assigned to the person AND the newest Muster lease comment on it is a check-out. Agents do not wake on a human-assigned task, which is the
 * exclusion. A local record on this Mac adds what the server never needs (worktree, chat, queued posts). Nothing new lives on the server.
 *
 *   (none) --checkout--> checked_out --handback--> handed_back
 *                            |  ^                   (assignee changes to the reviewer)
 *                            |  +--activity (touches lastActivityAt)
 *                            +--release--> released (assignee goes back as the person chose)
 *
 * A lease silent for `staleHours` is stale: the app shows a reminder; it never changes the task by itself.
 */
import type { CheckoutBadge, CheckoutLease, LeaseState, LeaseView, ModelChoice } from '../../shared/domains/checkout-protocol.ts';

/**
 * The markers (the contract with the optional Paperclip plugin, `packages/paperclip-plugin-muster`): HTML comments that Paperclip hides, appended to
 * comments Muster posts as the person. Attribute values are double-quoted; `"` is written `&quot;` and `&` `&amp;`.
 *   <!-- muster:checkout device="…" device-id="…" by="…" at="…" -->   checked out
 *   <!-- muster:activity at="…" -->                                    progress, decision, evidence, cost
 *   <!-- muster:release at="…" -->                                     let go without handing back
 *   <!-- muster:handback at="…" -->                                    finished and handed to review
 * Only the person's own comments count, and the server's timestamp (not `at`) orders them, so a skewed clock cannot fake activity.
 */
export const DEFAULT_STALE_HOURS = 8;
export type LeaseEventName = 'checkout' | 'handback' | 'release';
export type MarkerKind = LeaseEventName | 'activity';
export interface LeaseMarker { v: 1; event: LeaseEventName; deviceId: string; device: string; by: string; at: string }
const encode = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/-->/g, '--&gt;');
const decode = (value: string): string => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export const markerFor = (kind: MarkerKind, attrs: Record<string, string | undefined> = {}): string => {
  const rendered = Object.entries(attrs).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '').map(([k, v]) => `${k}="${encode(v)}"`).join(' ');
  return `<!-- muster:${kind}${rendered ? ` ${rendered}` : ''} -->`;
};

/** The visible words of a check-out comment, before the machine-readable marker. */
export const checkoutText = (device: string): string => `Checked out · working locally on ${device} · via Muster`;
/** The comment Muster posts as the person when they check a task out. */
export const checkoutComment = (device: string, deviceId: string, by: string, at: string): string => `${checkoutText(device)}\n\n${markerFor('checkout', { device, 'device-id': deviceId, by, at })}`;

const MARKER = /<!--\s*muster:([a-z][a-z-]*)((?:\s+[a-z][\w-]*="[^"]*")*)\s*-->/gi;
/** The newest lease marker (check-out, release or hand-back) in a comment body, or null (a person typing the words is not a lease). */
export function parseLeaseMarker(body: string): LeaseMarker | null {
  let found: LeaseMarker | null = null;
  for (const m of body.matchAll(MARKER)) {
    const kind = m[1]!.toLowerCase();
    if (kind !== 'checkout' && kind !== 'release' && kind !== 'handback') continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([a-z][\w-]*)="([^"]*)"/gi)) attrs[a[1]!.toLowerCase()] = decode(a[2]!);
    found = { v: 1, event: kind, deviceId: attrs['device-id'] ?? '', device: attrs.device ?? '', by: attrs.by ?? '', at: attrs.at ?? '' };
  }
  return found;
}

export interface DerivedLease { state: 'checked_out'; deviceId: string; device: string; since: string; thisMac: boolean }
/**
 * The check-out the SERVER shows: the task is assigned to the person and the newest lease marker on one of their own comments is a check-out.
 * Comments are `{ body, authorUserId, createdAt }`; they are ordered by the server's timestamp.
 */
export function deriveLease(task: { assigneeUserId: string | null }, comments: readonly { body: string; authorUserId?: string | null; createdAt?: string }[], meId: string, deviceId: string): DerivedLease | null {
  if (task.assigneeUserId !== meId) return null;
  let last: { marker: LeaseMarker; at: string } | null = null;
  for (const c of comments) {
    if (c.authorUserId && c.authorUserId !== meId) continue;
    if (!c.authorUserId) continue;
    const m = parseLeaseMarker(c.body);
    const at = c.createdAt || m?.at || '';
    if (m && (!last || at >= last.at)) last = { marker: m, at };
  }
  if (!last || last.marker.event !== 'checkout') return null;
  return { state: 'checked_out', deviceId: last.marker.deviceId, device: last.marker.device, since: last.at || last.marker.at, thisMac: last.marker.deviceId === deviceId };
}

export class LeaseError extends Error { constructor(message: string, readonly code: 'conflict' | 'none' | 'ended') { super(message); this.name = 'LeaseError'; } }

export interface LeaseEvent { type: 'checkout' | 'activity' | 'remind' | 'handback' | 'release' | 'run-on-server' | 'offline' | 'online' | 'conflict' | 'resolve'; at: string; mode?: 'manual' | 'auto'; conflict?: CheckoutLease['conflict']; deviceId?: string; device?: string; on?: boolean; prUrl?: string | null }
export interface NewLease { taskId: string; orgId: string; key: string; title: string; projectId: string | null; deviceId: string; device: string; model: ModelChoice; modelLabel: string; at: string; previous: CheckoutLease['previous'] }
export const newLease = (n: NewLease): CheckoutLease => ({
  taskId: n.taskId, orgId: n.orgId, key: n.key, title: n.title, projectId: n.projectId, state: 'checked_out', deviceId: n.deviceId, device: n.device, since: n.at, lastActivityAt: n.at, endedAt: null,
  worktree: null, branch: null, chatId: null, folderId: null, baseSha: null, model: n.model, modelLabel: n.modelLabel, runOnServer: false, prUrl: null, previous: n.previous, remindedAt: null, reviewLocally: false, reviewChats: [], pending: 0, offline: null, recheck: false, conflict: null,
});

/** The transition function. It never mutates; invalid moves throw a LeaseError the screens turn into a sentence. */
export function transition(lease: CheckoutLease | null, event: LeaseEvent): CheckoutLease {
  switch (event.type) {
    case 'checkout': throw new LeaseError('Use newLease to start a check-out.', 'conflict');
    case 'offline':
      if (!lease) throw new LeaseError('This task is not checked out.', 'none');
      // The most recent reason wins, but a manual switch is never replaced by an automatic one (only the person switches it off).
      return { ...lease, offline: lease.offline === 'manual' ? 'manual' : event.mode ?? 'manual', recheck: true };
    case 'online':
      if (!lease) throw new LeaseError('This task is not checked out.', 'none');
      return { ...lease, offline: null };
    case 'conflict':
      if (!lease) throw new LeaseError('This task is not checked out.', 'none');
      return { ...lease, conflict: event.conflict ?? null };
    case 'resolve':
      if (!lease) throw new LeaseError('This task is not checked out.', 'none');
      return { ...lease, conflict: null, recheck: false };
    case 'remind':
      if (!lease || lease.state !== 'checked_out') throw new LeaseError('This task is not checked out.', 'none');
      return { ...lease, remindedAt: event.at };
    case 'activity':
      if (!lease || lease.state !== 'checked_out') throw new LeaseError('This task is not checked out.', 'none');
      return { ...lease, lastActivityAt: event.at };
    case 'run-on-server':
      if (!lease || lease.state !== 'checked_out') throw new LeaseError('This task is not checked out.', 'none');
      return { ...lease, runOnServer: Boolean(event.on), lastActivityAt: event.at };
    case 'handback':
      if (!lease) throw new LeaseError('This task is not checked out.', 'none');
      if (lease.state !== 'checked_out') throw new LeaseError('This task was already handed back or released.', 'ended');
      return { ...lease, state: 'handed_back', endedAt: event.at, lastActivityAt: event.at, prUrl: event.prUrl ?? lease.prUrl, runOnServer: false };
    case 'release':
      if (!lease) throw new LeaseError('This task is not checked out.', 'none');
      if (lease.state !== 'checked_out') throw new LeaseError('This task was already handed back or released.', 'ended');
      return { ...lease, state: 'released', endedAt: event.at, lastActivityAt: event.at, runOnServer: false };
  }
}

/** Whether a new check-out may start: not while another Mac holds it (release it there, or take it over on purpose). */
export function canCheckout(derived: DerivedLease | null, deviceId: string, takeOver = false): { ok: true } | { ok: false; reason: string } {
  if (!derived || derived.deviceId === deviceId || takeOver) return { ok: true };
  return { ok: false, reason: `Already checked out on ${derived.device} since ${derived.since.slice(0, 16).replace('T', ' ')}. Release it there, or take it over.` };
}

export const hoursSince = (iso: string, now: number): number => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : 0; };
/** Checked out but silent for `staleHours` or more. Handed back and released leases are never stale. */
export const isStale = (lease: Pick<CheckoutLease, 'state' | 'lastActivityAt'> & { remindedAt?: string | null }, now: number, staleHours: number): boolean => {
  const last = lease.remindedAt && lease.remindedAt > lease.lastActivityAt ? lease.remindedAt : lease.lastActivityAt;
  return lease.state === 'checked_out' && staleHours > 0 && hoursSince(last, now) >= staleHours;
};

export const toView = (lease: CheckoutLease, deviceId: string, now: number, staleHours: number): LeaseView => ({ ...lease, thisMac: lease.deviceId === deviceId, stale: isStale(lease, now, staleHours), staleHours });
/** The line a task row shows: "Checked out · this Mac" (or the other Mac's name). */
export const badgeText = (b: Pick<CheckoutBadge, 'thisMac' | 'device'>): string => `Checked out · ${b.thisMac ? 'this Mac' : b.device}`;
export const badgeOf = (lease: LeaseView | CheckoutLease | null, deviceId: string, now: number, staleHours: number): CheckoutBadge | null =>
  lease && lease.state === 'checked_out' ? { state: 'checked_out', thisMac: lease.deviceId === deviceId, device: lease.device, since: lease.since, stale: isStale(lease, now, staleHours) } : null;
export const isOpen = (state: LeaseState): boolean => state === 'checked_out';
