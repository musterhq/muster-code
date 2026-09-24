/**
 * Bounded local provider discovery. Reads only known, fixed config paths
 * (regular files <= 1 MiB, no recursion, never modified) and reports presence
 * and coarse classification. Never returns tokens; `identity` carries at most
 * an account email taken from explicit account metadata. A local credential
 * means "configured", not a verified or active entitlement.
 */
import { promises as fs, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_KEY_PROVIDERS } from './env-providers.ts';
import { execFile } from 'node:child_process';
import { locateCli } from './adapters/shared.ts';

export interface DiscoveredProvider {
  id: string;
  name: string;
  status: 'configured' | 'installed' | 'not-detected' | 'error';
  source: string;
  identityMasked: string;
  detail: string;
  credentialPresent: boolean;
  identity?: string;
}

const MAX_BYTES = 1024 * 1024;

/** Read a regular file up to 1 MiB; null if absent/not a regular file, throws on other errors. */
async function readBounded(path: string): Promise<string | null> {
  // Read from one open descriptor with a hard cap, including concurrent growth.
  const info = await fs.lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (!info) return null;
  if (!info.isFile()) return null;
  // Do not follow a replacement symlink or block on a replacement FIFO after
  // the lstat. Verify the opened identity before reading any credential bytes.
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.dev !== info.dev || stat.ino !== info.ino) throw new Error('Configuration changed during discovery. Retry discovery.');
    if (stat.size > MAX_BYTES) throw new Error('file exceeds 1 MiB bound');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) { const r = await handle.read(buffer,count,buffer.length-count,null); if (!r.bytesRead) break; count += r.bytesRead; }
    if (count > MAX_BYTES) throw new Error('file exceeds 1 MiB bound');
    return buffer.subarray(0,count).toString('utf8');
  } finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

const isEmail = (v: unknown): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return `${email[0]}***${email.slice(at)}`;
}

function chatgptEmail(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string' || idToken.length > 16384) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const profile = claims['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
    const email = claims.email ?? profile?.email;
    return isEmail(email) && email.length <= 254 ? email : undefined;
  } catch { return undefined; }
}

/** The ChatGPT account email in `<codexHome>/auth.json` (the id_token's public claim), for an explicit reveal only. */
export async function codexAccountEmail(codexHome: string): Promise<string | undefined> {
  try {
    const raw = await readBounded(join(codexHome, 'auth.json'));
    return raw === null ? undefined : chatgptEmail(((JSON.parse(raw) as {tokens?: {id_token?: unknown}}).tokens)?.id_token);
  } catch { return undefined; }
}

function entry(base: Omit<DiscoveredProvider, 'identityMasked' | 'credentialPresent'> & Partial<DiscoveredProvider>): DiscoveredProvider {
  return { identityMasked: '', credentialPresent: false, ...base };
}

/** `codex login status` (exit 0 and "Logged in…") → a short label; undefined when absent, signed out, or unsupported.
 *  Never interactive: stdin is closed, it times out after 4s, and an older CLI without the subcommand just fails. */
const loginStatusCache = new Map<string, { at: number; value: Promise<string | undefined> }>();
export function codexLoginStatus(home: string, env: NodeJS.ProcessEnv, run: typeof execFile = execFile): Promise<string | undefined> {
  const cli = env.MUSTER_CODEX_COMMAND || locateCli('codex', env, home);
  if (!cli) return Promise.resolve(undefined);
  const key = `${cli}\0${env.CODEX_HOME ?? ''}`, hit = loginStatusCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = new Promise<string | undefined>(resolve => {
    const child = run(cli, ['login', 'status'], { timeout: 4000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { ...env, HOME: home, CODEX_HOME: env.CODEX_HOME || join(home, '.codex') } }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (error || !/logged in/i.test(out) || /not logged in/i.test(out)) { resolve(undefined); return; }
      resolve(/api key/i.test(out) ? 'API key sign-in (Codex)' : 'ChatGPT sign-in (Codex)');
    });
    child.stdin?.end();
  });
  loginStatusCache.set(key, { at: Date.now(), value });
  return value;
}

async function discoverCodex(home: string, env: NodeJS.ProcessEnv, loginStatus: LoginStatus): Promise<DiscoveredProvider> {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const source = join(codexHome, 'auth.json');
  const base = { id: 'codex', name: 'Codex CLI (ChatGPT)', source };
  try {
    const raw = await readBounded(source);
    if (raw === null) {
      // No auth.json: the sign-in may live in the Keychain (or belong to the ChatGPT app's bundled CLI). Ask the CLI
      // itself, non-interactively; a signed-in Codex is reused and never asked to sign in again.
      const status = await loginStatus(home, env);
      if (status) return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: status, detail: '`codex login status` reports a sign-in; not verified' });
      const installed = await exists(join(codexHome, 'config.toml'));
      return entry({ ...base, status: installed ? 'installed' : 'not-detected', detail: installed ? 'Local configuration found. File-based credentials were not detected; sign-in may be stored by the system.' : 'no auth.json found' });
    }
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const hasTokens = typeof auth?.tokens === 'object' && auth.tokens !== null && typeof (auth.tokens as Record<string, unknown>).access_token === 'string' && Boolean((auth.tokens as Record<string, unknown>).access_token);
    const hasApiKey = typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0;
    if (hasTokens) {
      // Same treatment as Claude Code: show the signed-in account masked, revealable on demand. Only the
      // id_token's public email claim is decoded; tokens themselves never leave this function.
      const identity = chatgptEmail((auth.tokens as Record<string, unknown>).id_token);
      return entry({ ...base, status: 'configured', credentialPresent: true, identity, identityMasked: identity ? maskEmail(identity) : 'ChatGPT account on file', detail: 'auth.json holds ChatGPT sign-in tokens (auth mode: chatgpt); not verified' });
    }
    if (hasApiKey) return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: 'API key on file', detail: 'auth.json holds an OpenAI API key (auth mode: apikey); not verified' });
    return entry({ ...base, status: 'installed', detail: 'auth.json present but holds no recognized credential' });
  } catch (error) {
    return entry({ ...base, status: 'error', detail: `auth.json unreadable: ${(error as Error).message === 'file exceeds 1 MiB bound' ? 'file exceeds 1 MiB bound' : 'invalid or inaccessible configuration'}` });
  }
}

async function discoverClaude(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredProvider> {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const credsPath = join(configDir, '.credentials.json');
  const metaPath = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json');
  const base = { id: 'claude-code', name: 'Claude Code', source: credsPath };
  const credentialPresent = await exists(credsPath); // presence only; never read token contents
  let identity: string | undefined;
  let metaError: string | undefined;
  try {
    const raw = await readBounded(metaPath);
    if (raw !== null) {
      const meta = JSON.parse(raw) as Record<string, unknown>;
      const account = meta.oauthAccount as Record<string, unknown> | undefined;
      if (account && isEmail(account.emailAddress) && account.emailAddress.length <= 254) identity = account.emailAddress;
    }
  } catch {
    metaError = '.claude.json unreadable (malformed or over 1 MiB)';
  }
  if (!credentialPresent && identity === undefined) {
    const installed = await exists(configDir) || await exists(metaPath);
    return entry({ ...base, status: installed ? 'installed' : 'not-detected', detail: installed ? 'Local configuration found. File-based credentials were not detected; sign-in may be stored in Keychain.' : 'no Claude Code files found' });
  }
  return entry({
    ...base,
    status: 'configured',
    credentialPresent,
    identity,
    identityMasked: identity ? maskEmail(identity) : 'Credential on file',
    detail: [credentialPresent ? '.credentials.json present; not verified' : 'account metadata only, no credential file', metaError].filter(Boolean).join('; '),
  });
}

/** `[model_providers.<id>]` tables (with their `name`) and a profile's own `model_provider`, read line by line. */
function codexProviderTables(text: string): { selected?: string; tables: Map<string, string | undefined> } {
  const tables = new Map<string, string | undefined>(); let current: string | undefined, selected: string | undefined, top = true;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*model_providers\.(?:"([^"]{1,64})"|([A-Za-z0-9_-]{1,64}))(\.[^\]]*)?\s*\]/.exec(line);
    if (header) { top = false; current = header[1] ?? header[2]; if (current && !tables.has(current)) tables.set(current, undefined); if (header[3]) current = undefined; continue; }
    if (/^\s*\[/.test(line)) { top = false; current = undefined; continue; }
    const field = /^\s*(model_provider|name)\s*=\s*"([^"\n]{1,120})"/.exec(line);
    if (!field) continue;
    if (top && field[1] === 'model_provider') selected = field[2];
    else if (current && field[1] === 'name') tables.set(current, field[2]!.replace(/[\x00-\x1f]/g, ''));
  }
  return { selected, tables };
}

/** Every gateway the user's Codex configuration names: `[model_providers.*]` tables in config.toml and the
 *  `<name>.config.toml` profiles beside it. Ids and names come from that configuration, never from Muster. */
async function discoverCodexGateways(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredProvider[]> {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  let names: string[] = [];
  try { names = (await fs.readdir(codexHome)).filter(name => /^[A-Za-z0-9_.-]{1,64}\.config\.toml$/.test(name) && name !== 'config.toml').sort().slice(0, 32); } catch { names = []; }
  const rows = new Map<string, DiscoveredProvider>();
  for (const file of ['config.toml', ...names]) {
    const source = join(codexHome, file);
    let text: string | null;
    try { text = await readBounded(source); } catch { continue; }
    if (text === null) continue;
    const { selected, tables } = codexProviderTables(text);
    const ids = new Set([...tables.keys(), ...(file !== 'config.toml' && selected ? [selected] : [])]);
    for (const id of ids) {
      if (id === 'openai' || rows.has(id)) continue;
      rows.set(id, entry({ id, name: tables.get(id) || id, source, status: 'configured', credentialPresent: true, identityMasked: 'Gateway in Codex config', detail: `[model_providers.${id}] in ${file}; not verified` }));
    }
  }
  return [...rows.values()];
}

/** OmniRoute, found by its own data folder or OMNIROUTE_* environment. Labelled by the name the user's Codex config
 *  gives it when a gateway there points at it; the runtime route (if any) replaces this row. */
async function discoverOmniRoute(home: string, env: NodeJS.ProcessEnv, gateways: DiscoveredProvider[]): Promise<DiscoveredProvider | undefined> {
  const dir = env.OMNIROUTE_HOME || join(home, '.omniroute');
  const envNames = Object.keys(env).filter(name => name.startsWith('OMNIROUTE_') && env[name]);
  const hasDir = await exists(dir);
  if (!hasDir && !envNames.length) return undefined;
  if (gateways.some(row => /omni-?route/i.test(`${row.id} ${row.name}`))) return undefined;
  return entry({ id: 'omniroute', name: 'OmniRoute', source: hasDir ? dir : `env:${envNames[0]}`, status: envNames.length || await exists(join(dir, '.env')) ? 'configured' : 'installed',
    credentialPresent: Boolean(env.OMNIROUTE_API_KEY), identityMasked: env.OMNIROUTE_API_KEY ? 'Key set in environment' : '',
    detail: hasDir ? 'OmniRoute data folder found; Muster lists its models from the local router when it is running' : `${envNames.join(', ')} set in the environment` });
}

async function discoverOpenCode(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredProvider> {
  const dataDir = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const configDir = env.XDG_CONFIG_HOME || join(home, '.config');
  const authPath = join(dataDir, 'opencode', 'auth.json');
  const configPath = join(configDir, 'opencode', 'opencode.json');
  const base = { id: 'opencode', name: 'OpenCode', source: authPath };
  try {
    const raw = await readBounded(authPath);
    const hasConfig = await exists(configPath);
    if (raw === null) {
      return entry({ ...base, status: hasConfig ? 'installed' : 'not-detected', source: hasConfig ? configPath : authPath, detail: hasConfig ? 'opencode.json present, no auth.json; not signed in' : 'no OpenCode files found' });
    }
    const auth = JSON.parse(raw) as Record<string, unknown>;
    if (!auth || Array.isArray(auth) || typeof auth !== 'object') throw new Error('Invalid auth configuration');
    const providers = Object.keys(auth);
    if (providers.length === 0) return entry({ ...base, status: 'installed', detail: 'auth.json present but empty' });
    return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: 'Credentials on file', detail: `auth.json holds credentials for ${providers.length} provider(s); not verified` });
  } catch (error) {
    return entry({ ...base, status: 'error', detail: `auth.json unreadable: ${(error as Error).message === 'file exceeds 1 MiB bound' ? 'file exceeds 1 MiB bound' : 'invalid or inaccessible configuration'}` });
  }
}

function discoverEnvKey(env: NodeJS.ProcessEnv, key: string, id: string, name: string): DiscoveredProvider {
  const set = typeof env[key] === 'string' && env[key].length > 0;
  return entry({
    id, name,
    source: `env:${key}`,
    status: set ? 'configured' : 'not-detected',
    credentialPresent: set,
    identityMasked: set ? 'Key set in environment' : '',
    detail: set ? `${key} is set in the environment; value not read beyond presence; not verified` : `${key} not set`,
  });
}

type LoginStatus = (home: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
/** Discover locally configured providers. Read-only; never returns secret material. `loginStatus` asks a CLI whether it is
 *  signed in (default: `codex login status`; test runs inject it so they never run a real CLI). */
export async function discoverLocalProviders(options?: { home?: string; env?: NodeJS.ProcessEnv; loginStatus?: LoginStatus }): Promise<DiscoveredProvider[]> {
  const home = options?.home ?? homedir();
  const env = options?.env ?? process.env;
  const loginStatus: LoginStatus = options?.loginStatus ?? (process.env.NODE_TEST_CONTEXT ? async () => undefined : (h, e) => codexLoginStatus(h, e));
  const [codex, claude, gateways, openCode] = await Promise.all([
    discoverCodex(home, env, loginStatus),
    discoverClaude(home, env),
    discoverCodexGateways(home, env),
    discoverOpenCode(home, env),
  ]);
  const omniroute = await discoverOmniRoute(home, env, gateways);
  return [codex, claude, ...gateways, ...(omniroute ? [omniroute] : []), openCode,
    ...ENV_KEY_PROVIDERS.map(key => discoverEnvKey(env, key.env, key.id, `${key.name} API key (environment)`))];
}
