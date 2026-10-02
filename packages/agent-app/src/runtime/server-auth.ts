/**
 * "Sign in to Muster Server" (#285): a browser-approval sign-in that does not care which backend answers.
 * `ServerAuth` is the seam. One adapter exists now (Paperclip's CLI auth challenge, in paperclip-signin.ts); a Muster Server adapter
 * with its own browser-approval or device flow plugs in by implementing the same five calls. The controller below owns everything
 * else: one request at a time, polling only while waiting (at the interval the server suggests, with backoff), expiry by the
 * clock, Cancel, and what the UI sees. The password never reaches Muster; the challenge secret and the key never leave this
 * closure except the key going to `approved()` and the approval link going to the renderer.
 */
import type { PaperclipSignInState } from '../shared/domains/paperclip-protocol.ts';

export interface SignedInUser { name: string | null; email: string | null; userId: string | null; /** Muster Server also says the account name and role. */ username?: string; role?: string }
/** What `start` returns. `secret` and `key` stay inside the controller. (`key` is the board key a Paperclip challenge issues up front; a Muster Server fills it in when the approval completes.) */
export interface ServerChallenge { id: string; secret: string; key: string; approvalUrl: string; expiresAt: number; pollIntervalMs: number }
export type ChallengeStatus = 'pending' | 'approved' | 'cancelled' | 'expired' | 'gone';
/** Thrown by an adapter when the server cannot be reached (the controller backs off). Any other Error from `start` is shown as is. */
export class Unreachable extends Error {}
export interface ServerAuth {
  /** Normalises and checks the address, creates the challenge. Throws a sentence for anything the person must fix. */
  start(baseUrl: unknown): Promise<{ baseUrl: string; origin: string; challenge: ServerChallenge }>;
  /** Throws Unreachable when the server does not answer; a server that answers with something else is `gone`. */
  poll(baseUrl: string, challenge: ServerChallenge): Promise<ChallengeStatus | 'invalid'>;
  /** Best effort. */
  cancel(baseUrl: string, challenge: ServerChallenge): Promise<void>;
  /** Who the new key belongs to; null when the server does not accept it. */
  whoami(baseUrl: string, key: string): Promise<SignedInUser | null>;
  /** Revokes the key the server issued to this Mac. */
  revoke(baseUrl: string, key: string): Promise<{ revoked: boolean; message?: string }>;
}

export interface SignInDeps {
  now?: () => number;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Called once per state change (the UI refetches the state). */
  changed(): void;
  /** Called on approval with the new key, bound to `origin`. Throwing fails the sign-in with that message. */
  approved(result: { origin: string; baseUrl: string; token: string; user: SignedInUser }): void | Promise<void>;
}

const MIN_POLL_MS = 500, MAX_BACKOFF_MS = 8_000, MAX_FAILURES = 6;
export const SIGNED_OUT_BY_SERVER = 'Signed out by Muster Server — sign in again.';
const IDLE: PaperclipSignInState = { phase: 'idle' };
const hostOf = (base: string) => new URL(base).host;

export function createServerSignIn(auth: ServerAuth, deps: SignInDeps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  let state: PaperclipSignInState = IDLE;
  let live: { challenge: ServerChallenge; base: string; origin: string; intervalMs: number; failures: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  let generation = 0;
  const set = (next: PaperclipSignInState) => { state = next; deps.changed(); };
  const stop = () => { if (live?.timer) timers.clearTimeout(live.timer); if (live) live.timer = null; };
  const finish = (next: PaperclipSignInState) => { stop(); live = null; generation++; set(next); };

  async function poll(mine: number): Promise<void> {
    const current = live;
    if (!current || mine !== generation) return;
    current.timer = null;
    const { base, challenge } = current;
    if (now() >= challenge.expiresAt) return finish({ phase: 'expired', baseUrl: base, message: 'The sign-in request expired before you approved it. Start again.' });
    let status: ChallengeStatus | 'invalid' | undefined;
    try { status = await auth.poll(base, challenge); } catch { current.failures++; }
    if (mine !== generation || live !== current) return;
    if (status !== undefined) {
      if (status === 'gone') return finish({ phase: 'failed', baseUrl: base, message: 'The server no longer knows this sign-in request. Start again.' });
      if (status === 'invalid') return finish({ phase: 'failed', baseUrl: base, message: `${hostOf(base)} does not look like a Muster Server. Check the address.` });
      current.failures = status === 'pending' || status === 'approved' || status === 'cancelled' || status === 'expired' ? 0 : current.failures + 1;
      if (status === 'cancelled') return finish({ phase: 'cancelled', baseUrl: base, message: 'The request was cancelled on the server, so Muster was not connected.' });
      if (status === 'expired') return finish({ phase: 'expired', baseUrl: base, message: 'The sign-in request expired before you approved it. Start again.' });
      if (status === 'approved') return complete(current, mine);
    }
    if (current.failures >= MAX_FAILURES) return finish({ phase: 'failed', baseUrl: base, message: `Muster lost contact with ${hostOf(base)} while waiting. Check that the server is running, then start again.` });
    schedule(current, mine);
  }
  function schedule(current: NonNullable<typeof live>, mine: number) {
    // Back off while the server is not answering; never wait past the expiry.
    const backoff = current.failures ? Math.min(MAX_BACKOFF_MS, current.intervalMs * 2 ** current.failures) : current.intervalMs;
    const delay = Math.max(50, Math.min(backoff, current.challenge.expiresAt - now() + 50));
    current.timer = timers.setTimeout(() => { void poll(mine); }, delay);
  }
  async function complete(current: NonNullable<typeof live>, mine: number): Promise<void> {
    const { base, challenge } = current;
    let who: SignedInUser | null;
    try { who = await auth.whoami(base, challenge.key); }
    catch { return finish({ phase: 'failed', baseUrl: base, message: `The server approved the request but stopped answering at ${hostOf(base)}. Start again.` }); }
    if (mine !== generation) return;
    if (!who) return finish({ phase: 'failed', baseUrl: base, message: 'The server approved the request but did not accept the new key. Start again.' });
    try { await deps.approved({ origin: current.origin, baseUrl: base, token: challenge.key, user: who }); }
    catch (cause) { return finish({ phase: 'failed', baseUrl: base, message: cause instanceof Error ? cause.message : 'Muster could not save the key.' }); }
    finish({ phase: 'signed-in', baseUrl: base, user: { name: who.name, email: who.email } });
  }

  return {
    state: (): PaperclipSignInState => state,
    /** Creates the challenge. Resolves with the waiting state (with the approval link) or throws a sentence. */
    async start(input: unknown): Promise<PaperclipSignInState> {
      if (live) await this.cancel();
      const { baseUrl, origin, challenge } = await auth.start(input);
      const mine = ++generation;
      live = { challenge, base: baseUrl, origin, intervalMs: Math.max(MIN_POLL_MS, challenge.pollIntervalMs), failures: 0, timer: null };
      set({ phase: 'waiting', baseUrl, approvalUrl: challenge.approvalUrl, expiresAt: new Date(challenge.expiresAt).toISOString() });
      schedule(live, mine);
      return state;
    },
    /** The Cancel button: tells the server (best effort) and stops waiting. */
    async cancel(): Promise<PaperclipSignInState> {
      const current = live;
      if (!current) return state;
      finish({ phase: 'cancelled', baseUrl: current.base, message: 'Sign-in cancelled.' });
      try { await auth.cancel(current.base, current.challenge); } catch { /* the request expires on its own */ }
      return state;
    },
    reset(): void { if (!live) { state = IDLE; deps.changed(); } },
    dispose(): void { stop(); live = null; generation++; },
    revoke: (baseUrl: string, key: string) => auth.revoke(baseUrl, key),
  };
}
