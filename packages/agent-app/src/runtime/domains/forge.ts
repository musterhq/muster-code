/**
 * `forge.*` (#329): the GitLab and Bitbucket Cloud accounts in Settings › Integrations. A token is saved in the encrypted
 * secret store under its kind and host, and used only for requests to that host (runtime/forge/http.ts). glab, when signed
 * in to a GitLab host, is used instead and needs nothing saved here.
 */
import type {ForgeAccounts} from '../../shared/domains/forge-protocol.ts';
import {configureForgeAccounts, forgeCredential, listForgeAccounts, removeForgeAccount, saveForgeAccount, secretStoreFor} from '../forge/accounts.ts';
import {glabInstalled, glabSignedIn, resetForgeHttp} from '../forge/http.ts';
import {resetHostedCache} from '../forge/common.ts';
import type {SecretStore} from '../secret-store.ts';
import type {DomainContext, DomainModule} from './types.ts';

export function createForgeDomain(context: DomainContext, options: {secrets?: () => SecretStore | undefined} = {}): DomainModule {
  configureForgeAccounts(context.dataDir, options.secrets);
  const view = async (): Promise<ForgeAccounts> => {
    const accounts = listForgeAccounts();
    const candidates = [...new Set(['gitlab.com', ...accounts.filter(row => row.kind === 'gitlab').map(row => row.host)])];
    const installed = await glabInstalled();
    const signedIn = installed ? await Promise.all(candidates.map(async host => (await glabSignedIn(host)) ? host : '')) : [];
    const store = secretStoreFor();
    return {
      accounts: accounts.map(row => ({kind: row.kind, host: row.host, ...(row.username ? {username: row.username} : {}), hasToken: !!forgeCredential(row.kind, row.host)})),
      glab: {installed, hosts: signedIn.filter(Boolean)},
      secureStorage: !!store?.secureStorage(),
    };
  };
  /** A changed account changes which credential a host uses: drop cached responses and glab checks. */
  const changed = () => { resetHostedCache(); resetForgeHttp(); };
  return {handlers: {
    'forge.accounts': () => view(),
    'forge.account.save': async input => { saveForgeAccount({kind: input.kind, host: input.host, username: input.username, token: input.token}); changed(); return view(); },
    'forge.account.remove': async input => { removeForgeAccount({kind: input.kind, host: input.host}); changed(); return view(); },
  }};
}
