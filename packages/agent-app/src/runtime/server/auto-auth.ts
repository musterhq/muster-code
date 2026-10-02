/**
 * "Connect" never asks which kind of server this is: the address decides. The address is probed (detect.ts), then the matching ServerAuth adapter
 * (Paperclip's CLI approval, or Muster Server's connect approval) runs the browser approval. Later calls (poll, cancel, who, revoke) go to the
 * adapter that started it, or, after a restart, to the one for the saved connection's backend.
 */
import type { ServerBackendKind } from '../../shared/domains/paperclip-protocol.ts';
import { normalizeBaseUrl, type FetchLike } from '../paperclip-client.ts';
import { createMusterServerAuth } from '../muster-server-signin.ts';
import { createPaperclipAuth } from '../paperclip-signin.ts';
import type { ServerAuth } from '../server-auth.ts';
import { detectBackend } from './detect.ts';

export interface AutoAuth extends ServerAuth { backendFor(origin: string): ServerBackendKind | undefined }

export function createAutoAuth(fetcher: FetchLike, saved: (origin: string) => ServerBackendKind | null): AutoAuth {
  const adapters: Record<ServerBackendKind, ServerAuth> = { paperclip: createPaperclipAuth(fetcher), 'muster-server': createMusterServerAuth(fetcher) };
  const chosen = new Map<string, ServerBackendKind>();
  const originOf = (base: string) => new URL(base).origin;
  const adapterFor = (base: string): ServerAuth => adapters[chosen.get(originOf(base)) ?? saved(originOf(base)) ?? 'paperclip'];
  return {
    backendFor: origin => chosen.get(origin) ?? saved(origin) ?? undefined,
    async start(input) {
      const base = normalizeBaseUrl(input), host = new URL(base).host;
      const found = await detectBackend(base, fetcher);
      if (!found.ok) throw new Error(found.stage === 'network' ? `Muster can’t reach ${host}. Check the address and that the server is running.` : `${host} isn’t a Muster server. Check the address.`);
      const started = await adapters[found.kind].start(base);
      chosen.set(started.origin, found.kind);
      return started;
    },
    poll: (base, c) => adapterFor(base).poll(base, c),
    cancel: (base, c) => adapterFor(base).cancel(base, c),
    whoami: (base, key) => adapterFor(base).whoami(base, key),
    revoke: (base, key) => adapterFor(base).revoke(base, key),
  };
}
