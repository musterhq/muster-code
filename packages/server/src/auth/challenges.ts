/**
 * Connect approval for the Muster desktop app (and other clients): the same browser-approval idea Paperclip uses for its CLI.
 *   1. The app asks for a challenge (no credentials) and opens `/connect/<id>` in a window.
 *   2. That page is this server's own: the person signs in on /login (the app never sees the password) and presses Approve.
 *   3. The app polls with the challenge secret and receives an API token once. Nothing is stored in clear text: only the secret's hash is kept,
 *      and a token waiting for pickup lives in memory for a few minutes.
 * Challenges expire after 10 minutes, at most 100 are pending, and the secret is compared in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ChallengeStatus = 'pending' | 'approved' | 'cancelled';
interface Entry { id: string; secretHash: Buffer; clientName: string; expiresAt: number; status: ChallengeStatus; token?: string; user?: { username: string; displayName: string } }
const TTL_MS = 10 * 60_000, MAX_PENDING = 100;
const hash = (secret: string) => createHash('sha256').update(secret).digest();
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export class Challenges {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}
  private purge(): void { const t = this.now(); for (const [id, e] of this.entries) if (e.expiresAt < t - 60_000) this.entries.delete(id); }
  create(clientName: string): { id: string; secret: string; expiresAt: number } {
    this.purge();
    if ([...this.entries.values()].filter(e => e.status === 'pending' && e.expiresAt > this.now()).length >= MAX_PENDING) throw new Error('Too many sign-in requests are waiting. Try again in a few minutes.');
    const id = randomBytes(18).toString('base64url'), secret = randomBytes(24).toString('base64url');
    const entry: Entry = { id, secretHash: hash(secret), clientName: clientName.replace(/[^\p{L}\p{N} ._()@-]/gu, '').slice(0, 80) || 'Muster app', expiresAt: this.now() + TTL_MS, status: 'pending' };
    this.entries.set(id, entry);
    return { id, secret, expiresAt: entry.expiresAt };
  }
  /** What the approval page may show without signing in: who is asking, and whether it is still open. */
  info(id: string): { clientName: string; status: ChallengeStatus | 'expired'; expiresAt: number } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return { clientName: e.clientName, status: e.status === 'pending' && e.expiresAt < this.now() ? 'expired' : e.status, expiresAt: e.expiresAt };
  }
  /** The signed-in person approved: `issue` creates the token, kept in memory until the app picks it up. */
  async approve(id: string, user: { username: string; displayName: string }, issue: (clientName: string) => Promise<string>): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.expiresAt < this.now()) throw new Error('This sign-in request has expired. Start again in the Muster app.');
    if (e.status !== 'pending') throw new Error(e.status === 'approved' ? 'This request was already approved.' : 'This request was cancelled.');
    e.token = await issue(e.clientName); e.status = 'approved'; e.user = user;
  }
  poll(id: string, secret: string): { status: ChallengeStatus | 'expired' | 'gone'; token?: string; user?: { username: string; displayName: string } } {
    const e = this.entries.get(id);
    if (!e || !same(e.secretHash, hash(secret))) return { status: 'gone' };
    if (e.status === 'approved') { const out = { status: 'approved' as const, token: e.token, user: e.user }; e.token = undefined; this.entries.delete(id); return out; }
    if (e.status === 'pending' && e.expiresAt < this.now()) return { status: 'expired' };
    return { status: e.status };
  }
  cancel(id: string, secret: string): boolean {
    const e = this.entries.get(id);
    if (!e || !same(e.secretHash, hash(secret))) return false;
    if (e.status === 'pending') e.status = 'cancelled';
    return true;
  }
  /** The approval page's Cancel. */
  decline(id: string): void { const e = this.entries.get(id); if (e?.status === 'pending') e.status = 'cancelled'; }
}
