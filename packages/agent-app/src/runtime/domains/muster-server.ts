/**
 * `musterServer.*` (#147, #204), now one face of the single "Muster Server" connection (runtime/server/connection.ts), which is also
 * what `paperclip.config.*` configures. Signing in here stores the token bound to the origin it was issued for, in the encrypted secret
 * store, and makes the connection active: its org and projects then show in the app's own Projects, Roster, Inbox and Ledger (no browser).
 * A password is used once to obtain a token and is never stored.
 */
import type { MusterServerConnectInput, MusterServerConnectionView, MusterServerProject } from '../../shared/domains/muster-server-protocol.ts';
import { MusterServerBackend } from '../server/muster-server-backend.ts';
import { connectionFor, serverOrigin, type ServerConnection } from '../server/connection.ts';
import type { SecretStore } from '../secret-store.ts';
import type { FetchLike } from '../paperclip-client.ts';
import type { DomainContext, DomainModule } from './types.ts';

export { serverOrigin };
export const MUSTER_SERVER_SECRET_ID = 'muster-server-token';

export function createMusterServerDomain(context: DomainContext, options: { fetch?: FetchLike; secrets?: () => SecretStore | undefined } = {}): DomainModule {
  const conn: ServerConnection = connectionFor(context, options);
  const view = (): MusterServerConnectionView => {
    const v = conn.view(), c = conn.config;
    const connected = v.hasToken && c.mode !== 'off' && c.backend === 'muster-server';
    return { connected, url: connected ? v.baseUrl : null, user: connected ? v.user ?? null : null, serverVersion: connected ? c.serverVersion : null, connectedAt: connected ? c.connectedAt : null, secureStorage: v.secureStorage };
  };
  const emit = () => context.emit({ type: 'musterServerChanged', view: view() });
  /** Another part of the app (Settings, the paperclip.* aliases) changed the connection: the Settings view follows. */
  conn.onChange(emit);

  return {
    handlers: {
      'musterServer.status': () => view(),
      'musterServer.connect': async raw => {
        const input = raw as unknown as MusterServerConnectInput;
        const origin = serverOrigin(input?.url);
        if (input.method === 'password') await conn.signIn({ baseUrl: origin, username: input.username, password: input.password, mode: input.mode === 'local' ? 'local' : 'custom' });
        else if (input.method === 'token') {
          if (typeof input.token !== 'string' || !/^mst_[A-Za-z0-9_-]{20,200}$/.test(input.token.trim())) throw new Error('Paste a Muster Server API token (it starts with mst_).');
          if (!conn.secrets().status(conn.config.tokenSecret).secureStorage) throw new Error('This computer has no secure keychain available, so the server token cannot be stored. Muster will not keep it in plain text.');
          await conn.adopt(origin, input.token.trim(), input.mode === 'local' ? 'local' : 'custom');
        } else throw new Error('Choose password or token sign-in.');
        return view();
      },
      'musterServer.disconnect': () => { conn.disconnect(); return view(); },
      'musterServer.projects': async () => {
        const endpoint = conn.endpoint();
        if (!endpoint?.token || conn.config.backend !== 'muster-server') throw new Error('Connect to a Muster Server first.');
        const backend = new MusterServerBackend(endpoint, { fetch: options.fetch });
        const projects = await backend.rpc<Array<{ id: string; name: string; goal: string; archived: boolean }>>('project.list');
        return { projects: projects.map((p): MusterServerProject => ({ id: p.id, name: p.name, goal: p.goal, archived: Boolean(p.archived), openUrl: `${endpoint.baseUrl}/?project=${encodeURIComponent(p.id)}` })) };
      },
    },
  };
}
