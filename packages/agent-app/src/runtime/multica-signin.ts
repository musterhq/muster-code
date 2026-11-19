/** Multica's CLI sign-in opens its login page and receives a session on an ephemeral loopback port.
 * Exchange it on the selected server for a personal access token dedicated to this installation. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { isLoopback, normalizeBaseUrl, PaperclipError, type FetchLike } from './paperclip-client.ts';
import type { ServerAuth } from './server-auth.ts';
import { MulticaBackend } from './server/multica-backend.ts';

const fallback = 'In Multica, create a personal access token and paste it under Other ways to connect.';

export function createMulticaAuth(fetch: FetchLike, timeoutMs = 300_000): ServerAuth {
  const client = (baseUrl: string, token: string) => new MulticaBackend({ baseUrl, token }, { fetch });
  const remove = (api: MulticaBackend, id: string) => api.call('DELETE', '/api/tokens/' + encodeURIComponent(id));

  return {
    async start(input) {
      const baseUrl = normalizeBaseUrl(input), login = new URL(baseUrl + '/login');
      if (login.protocol !== 'https:' && !isLoopback(baseUrl)) throw new Error('Use https:// to sign in to Multica.');
      const state = randomBytes(16).toString('hex');
      const result = Promise.withResolvers<string>();
      let accepted: ServerResponse | undefined;
      let finished = false;
      let minted: { api: MulticaBackend; id: string } | undefined;
      const expiresAt = Date.now() + timeoutMs;
      const listener = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Connection', 'close');
        const callback = new URL(login.searchParams.get('cli_callback')!);
        let url: URL;
        try { url = new URL(req.url ?? '/', callback); } catch { res.writeHead(400).end(); return; }
        const received = Buffer.from(url.searchParams.get('state') ?? '');
        const token = url.searchParams.get('token');
        if (req.method !== 'GET' || req.headers.host !== callback.host || url.origin !== callback.origin ||
            url.pathname !== '/callback' || !token || received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
          res.writeHead(400).end('Invalid sign-in callback.'); return;
        }
        if (accepted || finished || Date.now() >= expiresAt) { res.writeHead(409).end(); return; }
        accepted = res;
        try {
          const made = await client(baseUrl, token).call<{ id: string; token: string }>('POST', '/api/tokens', {
            body: { name: 'Muster Agent on ' + hostname(), expires_in_days: 90 },
          });
          if (typeof made?.id !== 'string' || !made.token?.startsWith('mul_')) throw new Error();
          minted = { api: client(baseUrl, made.token), id: made.id };
          if (finished) { await remove(minted.api, minted.id).catch(() => undefined); return; }
          result.resolve(made.token);
        } catch (cause) {
          // Only known HTTP status text is safe to send to the renderer. A proxy could echo a credential.
          const why = cause instanceof PaperclipError && cause.status === 404
            ? '404 page not found. This Multica server may be too old to sign in from Muster.'
            : 'Multica could not issue a personal access token.';
          result.reject(new Error(why + ' ' + fallback));
        }
      });
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
      const addr = listener.address();
      if (!addr || typeof addr === 'string') { listener.close(); throw new Error('Could not open the Multica sign-in callback.'); }
      login.searchParams.set('cli_callback', 'http://127.0.0.1:' + addr.port + '/callback');
      login.searchParams.set('cli_state', state);
      const timer = setTimeout(() => result.reject(new Error('Multica did not send the sign-in back in time. ' + fallback)), timeoutMs);
      return { baseUrl, origin: login.origin, challenge: {
        id: state, secret: '', key: '', approvalUrl: login.href, expiresAt, pollIntervalMs: 0,
        callback: { key: result.promise, finish(success) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          accepted?.writeHead(success ? 200 : 400).end(success ? 'You are signed in. Return to Muster.' : 'Sign-in ended. Return to Muster.');
          listener.close();
          result.reject(new Error('Sign-in cancelled.'));
          if (!success && minted) void remove(minted.api, minted.id).catch(() => undefined);
        } },
      } };
    },
    async poll() { return 'pending'; }, // Callback challenges are never polled.
    async cancel() {},
    async whoami(base, key) {
      const me = await client(base, key).whoami();
      return me && { name: me.name, email: me.email, userId: me.id };
    },
    async revoke(base, key) {
      try {
        const api = client(base, key);
        const tokens = await api.call<{ id: string; token_prefix: string }[]>('GET', '/api/tokens');
        const matches = tokens.filter(t => t.token_prefix === key.slice(0, 12));
        if (matches.length === 1) { await remove(api, matches[0]!.id); return { revoked: true }; }
      } catch { /* Offline or permissions changed. */ }
      return { revoked: false, message: 'Remove the Muster Agent token in Multica Settings › Tokens.' };
    },
  };
}
