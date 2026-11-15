/**
 * #329: GitLab and Bitbucket accounts saved in Settings › Integrations. The host (and a Bitbucket username) live in
 * dataDir/forge-accounts.json; the token or app password lives only in the encrypted secret store, under an id bound to
 * that kind and host, so a token is looked up for (and sent to) exactly the host it was saved for.
 */
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ForgeKind} from '../../shared/forge.ts';
import {activeSecretStore, type SecretStore} from '../secret-store.ts';
import type {ForgeCredential} from './http.ts';
import {setKnownGitLabHosts} from './remote.ts';

export type HostedForge = Exclude<ForgeKind, 'github'>;
export interface ForgeAccount {kind: HostedForge; host: string; username?: string}

let file: string | undefined;
let secrets: () => SecretStore | undefined = activeSecretStore;
let accounts: ForgeAccount[] = [];

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function validHost(value: unknown): string {
  const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!HOST.test(host)) throw new Error('Enter the host name only, like gitlab.com or git.example.com (no https:// or path).');
  return host;
}
/** Secret-store id for a host's token. Host names have no `_`, so mapping `.` to `_` keeps ids distinct. */
export const forgeSecretId = (kind: HostedForge, host: string) => `forge-${kind}-${host.replace(/\./g, '_')}`;

function publish(): void { setKnownGitLabHosts(accounts.filter(account => account.kind === 'gitlab').map(account => account.host)); }

/** Called by the forge domain at start-up: where accounts are kept and which secret store holds their tokens. */
export function configureForgeAccounts(dataDir: string, store: () => SecretStore | undefined = activeSecretStore): void {
  file = join(dataDir, 'forge-accounts.json'); secrets = store;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {accounts?: unknown};
    accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).flatMap((row: unknown): ForgeAccount[] => {
      const value = row as Partial<ForgeAccount> | null;
      if (!value || (value.kind !== 'gitlab' && value.kind !== 'bitbucket') || typeof value.host !== 'string' || !HOST.test(value.host)) return [];
      return [{kind: value.kind, host: value.host, ...(typeof value.username === 'string' && value.username ? {username: value.username} : {})}];
    });
  } catch { accounts = []; }
  publish();
}

function save(): void {
  if (!file) throw new Error('Accounts are not available yet.');
  mkdirSync(join(file, '..'), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({version: 1, accounts}, null, 2), {mode: 0o600});
  renameSync(temp, file);
  publish();
}

export const listForgeAccounts = (): ForgeAccount[] => accounts.map(account => ({...account}));
export const secretStoreFor = (): SecretStore | undefined => secrets();

export function saveForgeAccount(input: {kind: unknown; host: unknown; username?: unknown; token: unknown}): ForgeAccount {
  if (input.kind !== 'gitlab' && input.kind !== 'bitbucket') throw new Error('Choose GitLab or Bitbucket.');
  const kind = input.kind;
  const host = kind === 'bitbucket' ? 'bitbucket.org' : validHost(input.host);
  if (kind === 'bitbucket' && input.host !== undefined && input.host !== '' && validHost(input.host) !== 'bitbucket.org') throw new Error('Only Bitbucket Cloud (bitbucket.org) is supported.');
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (username.length > 200 || /[\s:]/.test(username)) throw new Error('Enter the username or email without spaces.');
  const store = secrets();
  if (!store || !store.secureStorage()) throw new Error('This computer has no secure keychain available, so the token cannot be stored. Muster will not keep it in plain text.');
  store.set(forgeSecretId(kind, host), input.token);
  const account: ForgeAccount = {kind, host, ...(username ? {username} : {})};
  accounts = [...accounts.filter(row => !(row.kind === kind && row.host === host)), account];
  save();
  return account;
}

export function removeForgeAccount(input: {kind: unknown; host: unknown}): void {
  if (input.kind !== 'gitlab' && input.kind !== 'bitbucket') throw new Error('Choose GitLab or Bitbucket.');
  const host = input.kind === 'bitbucket' ? 'bitbucket.org' : validHost(input.host);
  secrets()?.clear(forgeSecretId(input.kind, host));
  accounts = accounts.filter(row => !(row.kind === input.kind && row.host === host));
  save();
}

/** The credential saved for exactly this kind and host, if any. */
export function forgeCredential(kind: HostedForge, host: string): ForgeCredential | undefined {
  const account = accounts.find(row => row.kind === kind && row.host === host);
  const token = secrets()?.get(forgeSecretId(kind, host));
  if (!token) return undefined;
  return {token, ...(account?.username ? {username: account.username} : {})};
}
