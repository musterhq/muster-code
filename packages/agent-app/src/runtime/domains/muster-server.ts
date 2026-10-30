/**
 * `musterServer.*` (#147, #204, #803): the servers in Settings › Integrations, several side by side (runtime/server/registry.ts). Each has its
 * own connection (runtime/server/connection.ts), which is also what `paperclip.config.*` configures for the server that feeds Projects.
 * Signing in stores the token bound to the origin it was issued for, in the encrypted secret store under that server's own entry. A
 * password is used once to obtain a token and is never stored.
 */
import type { MusterServerConnectInput, MusterServerConnectionView } from '../../shared/domains/muster-server-protocol.ts';
import { serverOrigin, type ServerConnection } from '../server/connection.ts';
import { registryFor } from '../server/registry.ts';
import type { SecretStore } from '../secret-store.ts';
import type { FetchLike } from '../paperclip-client.ts';
import type { DomainContext, DomainModule } from './types.ts';

export { serverOrigin };
export const MUSTER_SERVER_SECRET_ID = 'muster-server-token';

export function createMusterServerDomain(context: DomainContext, options: { fetch?: FetchLike; secrets?: () => SecretStore | undefined } = {}): DomainModule {
  const registry = registryFor(context, options);
  const view = (conn: ServerConnection = registry.workspace, serverId: string | null = registry.workspaceEntry()?.id ?? null): MusterServerConnectionView => {
    const v = conn.view(), c = conn.config;
    const connected = v.hasToken && c.mode !== 'off' && c.backend === 'muster-server';
    return { connected, url: connected ? v.baseUrl : null, user: connected ? v.user ?? null : null, serverVersion: connected ? c.serverVersion : null, connectedAt: connected ? c.connectedAt : null, secureStorage: v.secureStorage, serverId };
  };
  const secureStorage = () => registry.workspace.secrets().status(registry.workspace.config.tokenSecret).secureStorage;
  const emit = () => context.emit({ type: 'musterServerChanged', view: view() });
  /** Anything in the list changed (a sign-in, Settings, a check finishing, the paperclip.* aliases): the Settings views follow. */
  const off = registry.onChange(emit);
  const optionalId = (raw: unknown): string | undefined => { const id = (raw as { serverId?: unknown } | undefined)?.serverId; return typeof id === 'string' && id ? id : undefined; };
  const requiredId = (raw: unknown): string => { const id = optionalId(raw); if (!id) throw new Error('Choose a server.'); return id; };
  const idOf = (conn: ServerConnection, origin: string) => registry.byOrigin(origin)?.id ?? (conn === registry.workspace ? registry.workspaceEntry()?.id ?? null : null);

  return {
    dispose: () => { off(); },
    handlers: {
      'musterServer.status': raw => { const id = optionalId(raw); return id ? view(registry.connection(id), id) : view(); },
      'musterServer.connect': async raw => {
        const input = raw as unknown as MusterServerConnectInput;
        const origin = serverOrigin(input?.url);
        const conn = registry.target({ serverId: input?.serverId, origin });
        if (input.method === 'password') await conn.signIn({ baseUrl: origin, username: input.username, password: input.password, mode: input.mode === 'local' ? 'local' : 'custom' });
        else if (input.method === 'token') {
          if (typeof input.token !== 'string' || !/^mst_[A-Za-z0-9_-]{20,200}$/.test(input.token.trim())) throw new Error('Paste a Muster Server API token (it starts with mst_).');
          if (!conn.secrets().status(conn.config.tokenSecret).secureStorage) throw new Error('This computer has no secure keychain available, so the server token cannot be stored. Muster will not keep it in plain text.');
          await conn.adopt(origin, input.token.trim(), input.mode === 'local' ? 'local' : 'custom');
        } else throw new Error('Choose password or token sign-in.');
        return view(conn, idOf(conn, origin));
      },
      'musterServer.disconnect': raw => {
        const id = optionalId(raw), conn = id ? registry.connection(id) : registry.workspace, which = id ?? registry.workspaceEntry()?.id ?? null;
        conn.disconnect();
        return view(conn, which);
      },
      'musterServer.projects': raw => registry.projects(optionalId(raw)),
      'musterServer.list': () => ({ servers: registry.views(), secureStorage: secureStorage() }),
      'musterServer.check': async raw => { await registry.check(optionalId(raw)); return { servers: registry.views() }; },
      'musterServer.rename': raw => { const id = requiredId(raw); return registry.view(registry.rename(id, (raw as { name?: unknown }).name)); },
      'musterServer.remove': raw => { registry.remove(requiredId(raw)); return { servers: registry.views() }; },
      'musterServer.useForWorkspace': raw => { registry.useForWorkspace(requiredId(raw)); return { servers: registry.views() }; },
    },
  };
}
