/**
 * How people sign in, per kind of server. Browser approval is the backend-agnostic `ServerAuth` seam in runtime/server-auth.ts (one
 * adapter today: Paperclip's CLI challenge in runtime/paperclip-signin.ts; a Muster Server browser or device flow plugs in by implementing
 * the same calls and being listed here). Muster Server's own sign-in today is a password, exchanged once for a server-issued token that is
 * stored; the password never is.
 */
import { hostname } from 'node:os';
import type { ServerBackendKind, ServerSignInMethod } from '../../shared/domains/paperclip-protocol.ts';
import type { FetchLike } from '../paperclip-client.ts';

export const SIGN_IN_METHODS: Record<ServerBackendKind, readonly ServerSignInMethod[]> = { paperclip: ['browser'], 'muster-server': ['password'] };
export const signInMethods = (backend: ServerBackendKind | null): ServerSignInMethod[] => backend ? [...SIGN_IN_METHODS[backend]] : [];

/** Username and password to a server-issued API token (Muster Server's `POST /api/auth/token`). */
export async function passwordToken(origin: string, credentials: { username: string; password: string }, fetcher: FetchLike): Promise<string> {
  const response = await fetcher(`${origin}/api/auth/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...credentials, name: `Muster desktop (${hostname().slice(0, 40)})` }),
  }).catch(cause => { throw new Error(`Could not reach ${origin}: ${cause instanceof Error ? cause.message : String(cause)}`); });
  const json = await response.json().catch(() => null) as { ok?: boolean; error?: string; token?: string } | null;
  if (!json) throw new Error(`${origin} is not a Muster Server (HTTP ${response.status}).`);
  if (!response.ok || json.ok === false || !json.token) throw new Error(json.error ?? `Muster Server answered ${response.status}.`);
  return json.token;
}
