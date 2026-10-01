/** Hash-chained server audit log: auth events, access changes, connector changes and turn attribution. Same scheme as the turn Ledger. */
import { createHash } from 'node:crypto';
import type { AuditInput, AuditRecord, ServerStore } from './store/types.ts';

export const GENESIS = '0'.repeat(64);
export const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]])) : v);
export const auditHash = (prev: string, body: Omit<AuditRecord, 'seq' | 'prevHash' | 'hash'>) => createHash('sha256').update(prev).update('\n').update(canonical(body)).digest('hex');
const SECRETISH = /(password|secret|token|cookie|authorization|apikey|api_key)/i;

/** Strips anything that looks like a credential before it is written (defence in depth; callers never pass secrets). */
export function scrub(detail: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) out[k] = SECRETISH.test(k) ? '[redacted]' : v && typeof v === 'object' && !Array.isArray(v) ? scrub(v as Record<string, unknown>) : v;
  return out;
}

export class AuditLog {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: ServerStore) {}
  /** Appends are serialized so concurrent requests cannot fork the chain. */
  append(input: AuditInput): Promise<AuditRecord> {
    const next = this.chain.then(async () => {
      const body = { at: input.at ?? new Date().toISOString(), actor: input.actor, action: input.action, target: input.target ?? null, detail: scrub(input.detail) };
      const prevHash = await this.store.auditHead();
      return this.store.appendAudit({ ...body, prevHash, hash: auditHash(prevHash, body) });
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
  async verify(): Promise<{ ok: boolean; entries: number; head: string; brokenAt: number | null }> {
    let prev = GENESIS, count = 0;
    for (const row of await this.store.iterateAudit()) {
      count++;
      const body = { at: row.at, actor: row.actor, action: row.action, target: row.target, detail: row.detail };
      if (row.prevHash !== prev || auditHash(prev, body) !== row.hash) return { ok: false, entries: count, head: prev, brokenAt: row.seq };
      prev = row.hash;
    }
    return { ok: true, entries: count, head: prev, brokenAt: null };
  }
}
