/**
 * Bounded local provider discovery. Reads only known, fixed config paths
 * (regular files <= 1 MiB, no recursion, never modified) and reports presence
 * and coarse classification. Never returns tokens; `identity` carries at most
 * an account email taken from explicit account metadata. A local credential
 * means "configured", not a verified or active entitlement.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_BYTES) throw new Error('file exceeds 1 MiB bound');
  return fs.readFile(path, 'utf8');
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

function entry(base: Omit<DiscoveredProvider, 'identityMasked' | 'credentialPresent'> & Partial<DiscoveredProvider>): DiscoveredProvider {
  return { identityMasked: '', credentialPresent: false, ...base };
}

async function discoverCodex(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredProvider> {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const source = join(codexHome, 'auth.json');
  const base = { id: 'codex', name: 'Codex CLI (ChatGPT)', source };
  try {
    const raw = await readBounded(source);
    if (raw === null) {
      const installed = await exists(join(codexHome, 'config.toml'));
      return entry({ ...base, status: installed ? 'installed' : 'not-detected', detail: installed ? 'config.toml present, no auth.json; not signed in' : 'no auth.json found' });
    }
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const hasTokens = typeof auth.tokens === 'object' && auth.tokens !== null;
    const hasApiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0;
    if (hasTokens) return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: 'ChatGPT account on file', detail: 'auth.json holds ChatGPT sign-in tokens (auth mode: chatgpt); not verified' });
    if (hasApiKey) return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: 'API key on file', detail: 'auth.json holds an OpenAI API key (auth mode: apikey); not verified' });
    return entry({ ...base, status: 'installed', detail: 'auth.json present but holds no recognized credential' });
  } catch (error) {
    return entry({ ...base, status: 'error', detail: `auth.json unreadable: ${(error as Error).message.includes('JSON') ? 'malformed JSON' : (error as Error).message}` });
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
      if (account && isEmail(account.emailAddress)) identity = account.emailAddress;
    }
  } catch {
    metaError = '.claude.json unreadable (malformed or over 1 MiB)';
  }
  if (!credentialPresent && identity === undefined) {
    const installed = await exists(configDir) || await exists(metaPath);
    return entry({ ...base, status: installed ? 'installed' : 'not-detected', detail: installed ? 'config directory present, no credentials; not signed in' : 'no Claude Code files found' });
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

async function discoverHybrow(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredProvider> {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const gateway = join(codexHome, 'hybrow-gateway.config.toml');
  const omniroute = join(home, '.omniroute');
  const base = { id: 'hybrow', name: 'OmniRoute / Hybrow Gateway', source: gateway };
  const [hasGateway, hasOmniroute] = await Promise.all([exists(gateway), exists(omniroute)]);
  if (hasGateway) return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: 'Gateway config on file', detail: 'hybrow-gateway.config.toml present; not verified' });
  if (hasOmniroute) return entry({ ...base, source: omniroute, status: 'installed', detail: '~/.omniroute present, no gateway config' });
  return entry({ ...base, status: 'not-detected', detail: 'no gateway or OmniRoute config found' });
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
    const providers = Object.keys(auth);
    if (providers.length === 0) return entry({ ...base, status: 'installed', detail: 'auth.json present but empty' });
    return entry({ ...base, status: 'configured', credentialPresent: true, identityMasked: 'Credentials on file', detail: `auth.json holds credentials for ${providers.length} provider(s); not verified` });
  } catch (error) {
    return entry({ ...base, status: 'error', detail: `auth.json unreadable: ${(error as Error).message.includes('JSON') ? 'malformed JSON' : (error as Error).message}` });
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

/** Discover locally configured providers. Read-only; never returns secret material. */
export async function discoverLocalProviders(options?: { home?: string; env?: NodeJS.ProcessEnv }): Promise<DiscoveredProvider[]> {
  const home = options?.home ?? homedir();
  const env = options?.env ?? process.env;
  const results = await Promise.all([
    discoverCodex(home, env),
    discoverClaude(home, env),
    discoverHybrow(home, env),
    discoverOpenCode(home, env),
  ]);
  results.push(
    discoverEnvKey(env, 'OPENAI_API_KEY', 'env-openai', 'OpenAI API key (environment)'),
    discoverEnvKey(env, 'ANTHROPIC_API_KEY', 'env-anthropic', 'Anthropic API key (environment)'),
  );
  return results;
}
