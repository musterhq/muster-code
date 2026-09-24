import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInfo } from '../../shared/protocol.ts';
import type { ProviderAccountRow, ProviderUsage } from '../../shared/domains/providers-protocol.ts';
import { activeCustomProviders } from '../custom-providers.ts';
import { importLoginShellEnv } from '../login-shell-env.ts';
import { codexHomeFor, diagnoseProvider } from '../provider-diagnostics.ts';
import { codexAccountEmail, discoverLocalProviders } from '../provider-discovery.ts';
import { accountHash, configuredProviderInstances, invalidateProviderInstances, parseProviderAccounts, providerAccountsFile, removeProviderAccount, saveProviderAccount } from '../provider-instances.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { liveProviderUsage, onProviderUsage, sessionRateLimits } from '../provider-usage.ts';
import { SecretStore } from '../secret-store.ts';
import { CLI_TOOLS, createCliMaintenance, isCliTool, type CliMaintenance } from '../cli-maintenance.ts';
import type { DomainContext, DomainModule } from './types.ts';

const id = (value: unknown, field = 'id'): string => { if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(value)) throw new Error(`Invalid ${field}.`); return value; };
const USAGE_TTL_MS = 30_000;

export interface ProvidersDomainOptions { cli?: CliMaintenance; secrets?: SecretStore; shellEnv?: boolean; list?: () => Promise<ProviderInfo[]>; home?: string; env?: NodeJS.ProcessEnv; /** Launcher directory for configuredProviderInstances (tests). */ directory?: string }

/** Providers domain: in-app keys, staged diagnosis, reveal-on-demand identity and Codex usage windows. */
export function createProvidersDomain(context: DomainContext, options: ProvidersDomainOptions = {}): DomainModule {
  const secrets = options.secrets ?? new SecretStore(context.dataDir);
  const env = options.env ?? process.env, home = options.home ?? homedir();
  // Finder launches miss ~/.zshrc exports; import them once so env-based keys and CLIs resolve.
  if (options.shellEnv ?? Boolean(process.versions.electron)) void importLoginShellEnv().then(names => { if (names.length) invalidateProviderInstances(); });
  const off = onProviderUsage(usage => context.emit({type: 'providerUsage', usage}));
  // PRO-11: managed CLI installs update only while no chat is running; deferred updates apply when the last run settles.
  const activeSessions = () => { try { return Number((context.db().prepare("SELECT COUNT(*) AS n FROM chats WHERE status IN ('running','stopping')").get() as {n?: number} | undefined)?.n ?? 0); } catch { return 0; } };
  const cli = options.cli ?? createCliMaintenance({root: join(context.dataDir, 'managed-cli'), env, home, activeSessions, onActivate: () => invalidateProviderInstances(), onChange: status => context.emit({type: 'providerCliChanged', status})});
  const offSettled = context.hooks?.onRunSettled?.(() => cli.idle().catch(() => {}));
  const tool = (value: unknown) => { if (!isCliTool(value)) throw new Error('Choose Codex, Claude Code or OpenCode.'); return value; };
  const list = options.list ?? (() => context.invoke('providers.list', undefined));
  const provider = async (key: string) => { const found = (await list()).find(row => row.id === key); if (!found) throw new Error('That provider is no longer listed. Scan again.'); return found; };
  const custom = (value: unknown) => {
    const key = id(value, 'providerId');
    if (!/^custom_[A-Za-z0-9-]+$/.test(key)) throw new Error('API keys can be stored for connections added in Muster.');
    const store = activeCustomProviders();
    if (store && !store.has(key)) throw new Error('Connection no longer exists.');
    return key;
  };
  let usageCache: {at: number; roots: Map<string, Map<string, ProviderUsage>>} | undefined;
  const sessionUsage = (root: string) => {
    if (!usageCache || Date.now() - usageCache.at > USAGE_TTL_MS) usageCache = {at: Date.now(), roots: new Map()};
    let found = usageCache.roots.get(root);
    if (!found) { found = sessionRateLimits(root); usageCache.roots.set(root, found); }
    return found;
  };
  const usageFor = (providerId: string, sessionsRoot: string, modelProvider = 'openai'): ProviderUsage | undefined => {
    const logs = sessionUsage(sessionsRoot);
    // Codex records each rollout under the route's model_provider id ("openai" for a ChatGPT sign-in, a gateway's own id otherwise).
    const logged = logs.get(modelProvider);
    const live = liveProviderUsage(providerId);
    const best = live && (!logged || live.updatedAt >= logged.updatedAt) ? live : logged;
    return best && {...best, providerId};
  };
  const accountsFile = providerAccountsFile(context.dataDir);
  const storedAccounts = () => { try { return parseProviderAccounts(readFileSync(accountsFile, 'utf8')); } catch { return []; } };
  const accountRows = (): { accounts: ProviderAccountRow[] } => {
    const instances = configuredProviderInstances({env, home, accountsFile, ...(options.directory ? {directory: options.directory} : {})}).filter(row => row.info.codex);
    const row = (id: string, label: string, suffix: string, removable: boolean): ProviderAccountRow => {
      const mine = instances.filter(instance => (instance.info.codex?.account ?? '') === suffix);
      return {id, label, providerIds: mine.map(instance => instance.info.id), ready: mine.some(instance => instance.info.available), removable};
    };
    const main = env.CODEX_HOME || join(home, '.codex');
    return {accounts: [row('default', 'Default sign-in', '', false), ...storedAccounts().filter(account => account.codexHome !== main).map((account, index) => { const hash = accountHash(account.codexHome); return row(hash, account.label ?? `Account ${index + 2}`, hash, true); })]};
  };
  const codexHomeInput = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Enter the folder that holds the Codex sign-in.');
    const raw = value.trim(), path = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
    if (!isAbsolute(path)) throw new Error('Use a full path such as ~/.codex-work.');
    let directory = false; try { directory = statSync(path).isDirectory(); } catch { directory = false; }
    if (!directory) throw new Error('That folder does not exist.');
    if (path === (env.CODEX_HOME || join(home, '.codex'))) throw new Error('That is already the default sign-in.');
    let profiles: string[] = []; try { profiles = readdirSync(path).filter(name => name.endsWith('.config.toml')); } catch { profiles = []; }
    if (!existsSync(join(path, 'auth.json')) && !existsSync(join(path, 'config.toml')) && !profiles.length) throw new Error('No Codex sign-in was found there. Run `CODEX_HOME=<folder> codex login` first.');
    return path;
  };
  return {
    handlers: {
      'providers.accounts.list': () => accountRows(),
      'providers.accounts.add': input => {
        const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : undefined;
        saveProviderAccount(context.dataDir, {codexHome: codexHomeInput(input.codexHome), ...(label ? {label} : {})});
        return accountRows();
      },
      'providers.accounts.remove': input => {
        if (typeof input.id !== 'string' || !/^[0-9a-f]{10}$/.test(input.id)) throw new Error('Choose an added account.');
        const found = storedAccounts().find(account => accountHash(account.codexHome) === input.id);
        if (!found) throw new Error('That account is no longer listed.');
        removeProviderAccount(context.dataDir, found.codexHome);
        return accountRows();
      },
      'providers.secret.status': input => secrets.status(custom(input.providerId)),
      'providers.secret.set': input => { const key = custom(input.providerId), status = secrets.set(key, input.value); invalidateProviderInstances(); return status; },
      'providers.secret.clear': input => { const status = secrets.clear(custom(input.providerId)); invalidateProviderInstances(); return status; },
      'providers.diagnose': async input => diagnoseProvider(await provider(id(input.id)), {env, home}),
      'providers.identity': async input => {
        const key = id(input.id);
        const listed = key === 'codex' ? {id: key} : (await list()).find(row => row.id === key);
        const codexHome = listed ? codexHomeFor(listed, env, home) : undefined;
        const identity = codexHome ? await codexAccountEmail(codexHome) : key === 'claude-code' ? (await discoverLocalProviders({home, env})).find(row => row.id === key)?.identity : undefined;
        if (!identity) throw new Error(codexHome ? 'No ChatGPT account email is on file for this sign-in.' : 'This connection has no account email to reveal.');
        return {identity};
      },
      'providers.usage': input => {
        const only = input.id === undefined ? undefined : id(input.id);
        const rows: ProviderUsage[] = [];
        for (const instance of configuredProviderInstances({env, home})) {
          if (!instance.info.codex || (only && instance.info.id !== only)) continue;
          const usage = usageFor(instance.info.id, instance.sessionsRoot, instance.info.codex.modelProvider);
          if (usage) rows.push(usage);
        }
        if (only === 'codex' || (!only && !rows.some(row => row.providerId === 'openai-direct'))) {
          const usage = usageFor('codex', join(env.CODEX_HOME || join(home, '.codex'), 'sessions'));
          if (usage && (only === 'codex' || !only)) rows.push(usage);
        }
        return rows;
      },
      'providers.cli.status': () => Promise.all((Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]).map(name => cli.status(name))),
      'providers.cli.check': input => cli.check(tool(input.tool)),
      'providers.cli.update': input => cli.update(tool(input.tool), input.version === undefined ? undefined : String(input.version).slice(0, 64)),
      'providers.cli.rollback': input => cli.rollback(tool(input.tool)),
      'providers.cli.cancel': input => cli.cancel(tool(input.tool)),
      'providers.captureStatus': () => {
        try {
          const electron = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js'))('electron') as {webContents?: {getAllWebContents(): {isBeingCaptured?(): boolean; isDestroyed(): boolean}[]}};
          return {captured: Boolean(electron.webContents?.getAllWebContents().some(contents => !contents.isDestroyed() && contents.isBeingCaptured?.()))};
        } catch { return {captured: false}; }
      },
    },
    dispose() { off(); offSettled?.(); if (!options.secrets) secrets.close(); },
  };
}
