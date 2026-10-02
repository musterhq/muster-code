/**
 * The hosted-server session that makes updates instant (pure helpers; Electron-free so main, runtime and tests share them).
 *
 * A hosted Paperclip lets only a browser SESSION (Better Auth) or an agent key onto its live-events socket: the board key that browser
 * approval issues is refused there. So "Sign in to Muster Server" signs in inside the app, in a window whose cookie jar is a persistent
 * partition of its own PER SERVER ORIGIN, still on the server's own page (Muster never sees the password). The session cookie is read
 * from that partition, kept in the encrypted secret store bound to the origin, and sent only to that origin: as the socket's Cookie and
 * to refresh the session. When the session expires or the socket is refused, updates fall back to ETag polling and a quiet
 * "Reconnect for live updates" re-opens the window (the board key stays valid, so there is no full sign-in).
 */
import { createHash } from 'node:crypto';

/** The partition of a server's sign-in window: one per origin, never shared with another server or with the app's own webviews. */
export function sessionPartition(origin: string): string {
  return `persist:muster-server-${createHash('sha256').update(new URL(origin).origin).digest('hex').slice(0, 24)}`;
}

export interface CookieLike { name: string; value: string; domain?: string; path?: string; secure?: boolean; expirationDate?: number }
/** Better Auth's session token cookie: `<prefix>.session_token` (Paperclip's prefix is its instance, e.g. `paperclip-default`), with the __Secure- / __Host- prefix it takes over https. Never `session_data` or any other cookie. */
export const isSessionCookie = (name: string): boolean => /^(__Secure-|__Host-)?[\w-]+(\.[\w-]+)*\.session_token$/.test(name);

/** The `Cookie` header value for the server's own session: only session-token cookies that belong to this origin (host, path, scheme) and have not expired. */
export function sessionCookieHeader(cookies: readonly CookieLike[], origin: string, now = Date.now()): string | null {
  const url = new URL(origin), host = url.hostname.toLowerCase();
  const belongs = (c: CookieLike): boolean => {
    if (!isSessionCookie(c.name) || !c.value) return false;
    if (c.expirationDate !== undefined && c.expirationDate * 1000 <= now) return false;
    if (c.secure && url.protocol !== 'https:') return false;
    const domain = (c.domain ?? '').toLowerCase().replace(/^\./, '');
    if (domain && host !== domain && !(c.domain?.startsWith('.') && host.endsWith(`.${domain}`))) return false;
    return (c.path ?? '/') === '/' || '/'.startsWith(c.path ?? '/');
  };
  const mine = cookies.filter(belongs);
  return mine.length ? mine.map(c => `${c.name}=${c.value}`).join('; ') : null;
}
/** A cookie header the runtime will accept from the app's main process: session-token cookies only, no other cookie rides along. */
export function validSessionCookie(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('That is not a session cookie.');
  const pairs = value.split('; ');
  if (!pairs.every(p => { const eq = p.indexOf('='); return eq > 0 && isSessionCookie(p.slice(0, eq)) && /^[^\s;,"\\]+$/.test(p.slice(eq + 1)); })) throw new Error('That is not a session cookie.');
  return value;
}

export type SessionState = 'none' | 'active' | 'expired';
export type LiveMode = 'socket' | 'poll' | 'reconnect';
/**
 * What the screens say about updates. `socket`: instant. `reconnect`: a browser sign-in whose session is missing or expired, so updates are
 * near-real-time polling and a quiet Reconnect is offered. `poll`: polling is all this server offers (or all the credential allows).
 */
export function liveMode(input: { channel: 'socket' | 'poll' | 'events' | 'off'; browserSignIn: boolean; session: SessionState }): LiveMode {
  if (input.channel === 'socket') return 'socket';
  return input.browserSignIn && input.session !== 'active' ? 'reconnect' : 'poll';
}
