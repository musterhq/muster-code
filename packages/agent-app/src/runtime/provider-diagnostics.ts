/**
 * Staged provider diagnosis (PRO-03/PRO-11). Walks the same local prerequisites the provider routes need,
 * in order, and stops at the first failing stage with a concrete fix. Read-only: nothing is authenticated,
 * launched (except `<cli> --version`, cached) or written. Tokens are inspected only for presence and expiry.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ProviderInfo } from '../shared/protocol.ts';
import type { ProviderDiagnosis, ProviderStage } from '../shared/domains/providers-protocol.ts';
import { accountHash, parseProviderAccounts, providerAccountsFile, providerDataDir } from './provider-instances.ts';
import { ENV_KEY_PROVIDERS } from './env-providers.ts';

export interface DiagnoseOptions { home?: string; env?: NodeJS.ProcessEnv; directory?: string; now?: () => number; version?: (cli: string) => Promise<string | null>; dataDir?: string }
type Step = Omit<ProviderDiagnosis, 'id' | 'version' | 'checkedAt' | 'diagnostics'>;
const ok = (summary: string): Step => ({stage: 'ok', summary});

const MAX = 1024 * 1024;
function readSmall(file: string): string { const info = statSync(file); if (!info.isFile() || info.size > MAX) throw new Error('unsupported'); return readFileSync(file, 'utf8'); }
const executable = (file: string) => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
/** First executable named `name` on PATH (the login-shell PATH once imported). */
export function which(name: string, env: NodeJS.ProcessEnv, extra: string[] = []): string | undefined {
  for (const dir of [...(env.PATH ?? '').split(delimiter), ...extra]) if (dir && isAbsolute(dir) && executable(join(dir, name))) return join(dir, name);
  return undefined;
}
function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string' || token.length > 16384) return undefined;
  try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return undefined; }
}

/** auth.json → a stage. Access tokens are refreshed by the CLI, so only an expired token with no refresh token is "expired". */
export function authStage(text: string | null, now: number, login: string, requireAccount = true): Step {
  if (text === null) return {stage: 'auth-missing', summary: 'No sign-in found (auth.json is missing).', hint: `Run \`${login}\` in Terminal, then scan again.`, command: login};
  let auth: {OPENAI_API_KEY?: unknown; tokens?: {access_token?: unknown; refresh_token?: unknown; account_id?: unknown; id_token?: unknown}};
  try { auth = JSON.parse(text); } catch { return {stage: 'auth-missing', summary: 'auth.json is not valid JSON.', hint: `Run \`${login}\` to sign in again.`, command: login}; }
  const tokens = auth?.tokens;
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token) {
    if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY && !requireAccount) return ok('Signed in with an API key.');
    return {stage: 'auth-missing', summary: typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY ? 'auth.json holds an API key, but this route needs a ChatGPT sign-in.' : 'auth.json holds no sign-in.', hint: `Run \`${login}\` in Terminal and choose “Sign in with ChatGPT”.`, command: login};
  }
  if (requireAccount && (typeof tokens.account_id !== 'string' || !tokens.account_id)) return {stage: 'auth-missing', summary: 'The ChatGPT sign-in has no account id.', hint: `Run \`${login}\` again to refresh it.`, command: login};
  const exp = jwtClaims(tokens.access_token)?.exp;
  const hasRefresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
  if (typeof exp === 'number' && exp * 1000 < now && !hasRefresh) return {stage: 'auth-expired', summary: `The ChatGPT sign-in expired ${new Date(exp * 1000).toLocaleDateString()} and cannot refresh itself.`, hint: `Run \`${login}\` in Terminal to sign in again.`, command: login};
  return ok(typeof exp === 'number' && exp * 1000 < now ? 'Signed in; the access token refreshes on the next run.' : 'Signed in.');
}

/** Codex-run routes carry `codex` metadata; `codex` itself is the plain Codex CLI sign-in row. */
const isCodexRoute = (p: Pick<ProviderInfo, 'id' | 'codex'>) => p.id === 'codex' || Boolean(p.codex);
/** The CODEX_HOME behind a Codex route: the default home, or the extra account its `codex.account` hash names. */
export function codexHomeFor(p: Pick<ProviderInfo, 'id' | 'codex'>, env: NodeJS.ProcessEnv, home: string, dataDir = providerDataDir()): string | undefined {
  if (!isCodexRoute(p)) return undefined;
  const base = env.CODEX_HOME || join(home, '.codex'), account = p.codex?.account;
  if (!account) return base;
  if (!dataDir) return undefined;
  try { return parseProviderAccounts(readSmall(providerAccountsFile(dataDir))).find(entry => accountHash(entry.codexHome) === account)?.codexHome; } catch { return undefined; }
}

function codexSteps(p: ProviderInfo, options: Required<Pick<DiagnoseOptions, 'home' | 'env' | 'directory'>> & {now: number; dataDir?: string}): {step: Step; cli?: string; facts: string[]} {
  const {env, home, directory, now} = options, facts: string[] = [];
  const family = p.id === 'codex' || !p.codex ? 'codex' : p.codex.kind;
  const codexHome = codexHomeFor(p, env, home, options.dataDir);
  if (!codexHome) return {step: {stage: 'profile-invalid', summary: 'This extra Codex account is no longer listed in provider-accounts.json.', hint: 'Add the account again, then scan again.'}, facts};
  const login = codexHome === join(home, '.codex') ? 'codex login' : `CODEX_HOME=${JSON.stringify(codexHome)} codex login`;
  facts.push(`codexHome: ${codexHome}`);
  const cli = env.MUSTER_CODEX_COMMAND || which('codex', env, [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']);
  facts.push(`cli: ${cli ?? 'not found'}`);
  if (!cli || !executable(cli)) return {step: {stage: 'executable-missing', summary: `The Codex CLI was not found${cli ? ` at ${cli}` : ' on PATH'}.`, hint: 'Install the Codex CLI (or set MUSTER_CODEX_COMMAND to its path), then scan again.', command: 'npm install -g @openai/codex'}, facts};
  const authFile = join(codexHome, 'auth.json');
  const readAuth = () => { try { return readSmall(authFile); } catch { return null; } };
  if (family === 'codex') return {step: authStage(readAuth(), now, login, false), cli, facts};
  const launcher = join(directory, 'resources', 'codex-launch.sh');
  if (!executable(launcher)) return {step: {stage: 'executable-missing', summary: 'Muster’s bundled Codex launcher is missing or not executable.', hint: 'Reinstall Muster to restore its launcher scripts.'}, cli, facts};
  const profile = p.codex?.profile;
  // Routes from config.toml or the plain ChatGPT sign-in have no profile file: their own status says what is missing.
  if (!profile) {
    if (family === 'chatgpt') { const signIn = authStage(readAuth(), now, login, false); if (signIn.stage !== 'ok') return {step: signIn, cli, facts}; }
    return {step: p.available ? ok('Codex CLI and configuration are in place. Upstream access is checked when you run.') : {stage: p.error ? stageForMessage(p.error) : 'profile-invalid', summary: p.error ?? p.detail ?? 'Unavailable.'}, cli, facts};
  }
  const profilePath = join(codexHome, `${profile}.config.toml`);
  facts.push(`profile: ${profilePath}`);
  let text: string;
  try { text = readSmall(profilePath); } catch { return {step: {stage: 'profile-invalid', summary: `${profile}.config.toml was not found in the Codex home.`, hint: `Create ${profilePath} with a model_catalog_json entry, then scan again.`}, cli, facts}; }
  let catalogPath: unknown;
  try {
    const validator = createRequire(join(directory, 'provider-diagnostics.cjs'))(join(directory, 'resources', 'codex-profile.cjs')) as {profileOverrides(profile: string, text: string): string[]};
    const field = validator.profileOverrides(profile, text).find(value => value.startsWith('model_catalog_json='));
    catalogPath = JSON.parse(field?.slice('model_catalog_json='.length) ?? 'null');
  } catch (error) { return {step: {stage: 'profile-invalid', summary: `${profile}.config.toml did not validate${error instanceof Error && error.message.length < 160 ? `: ${error.message}` : '.'}`, hint: `Fix ${profilePath}; Muster only runs validated profiles.`}, cli, facts}; }
  if (typeof catalogPath !== 'string' || !isAbsolute(catalogPath)) return {step: {stage: 'profile-invalid', summary: 'The profile has no absolute model_catalog_json path.', hint: `Add model_catalog_json = "/absolute/path/models.json" to ${profilePath}.`}, cli, facts};
  facts.push(`catalog: ${catalogPath}`);
  try { const catalog = JSON.parse(readSmall(catalogPath)) as {models?: unknown}; if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('empty'); }
  catch { return {step: {stage: 'catalog-unreadable', summary: 'The local model catalog is missing, unreadable or lists no models.', hint: `Check ${catalogPath}: it must be JSON with a non-empty "models" array.`}, cli, facts}; }
  // The gateway authenticates upstream itself; only the direct route needs a local ChatGPT sign-in.
  if (family === 'chatgpt') return {step: authStage(readAuth(), now, login, profile === 'openai-direct'), cli, facts};
  return {step: ok('Launcher, profile and model catalog are in place. Upstream access is checked when you run.'), cli, facts};
}

function otherSteps(p: ProviderInfo, env: NodeJS.ProcessEnv, home: string): {step: Step; cli?: string; facts: string[]} {
  if (p.id === 'claude-code' || p.id === 'opencode') {
    const name = p.id === 'claude-code' ? 'claude' : 'opencode', login = p.id === 'claude-code' ? 'claude auth login' : 'opencode auth login';
    const cli = which(name, env, p.id === 'claude-code' ? [join(home, '.claude/local'), join(home, '.local/bin')] : [join(home, '.opencode/bin'), join(home, '.local/bin')]);
    if (!cli) return {step: {stage: 'executable-missing', summary: `The ${name} CLI was not found on PATH.`, hint: `Install ${p.name}, then scan again.`}, facts: []};
    if (p.status === 'installed' || p.status === 'not-detected') return {step: {stage: 'auth-missing', summary: `${p.name} is installed but not signed in.`, hint: `Run \`${login}\` in Terminal, then scan again.`, command: login}, cli, facts: [`cli: ${cli}`]};
    if (p.status === 'error') return {step: {stage: 'profile-invalid', summary: p.detail ?? `${p.name} configuration is unreadable.`, hint: `Run \`${login}\` to rewrite it.`, command: login}, cli, facts: [`cli: ${cli}`]};
    return {step: ok('Signed in locally. Upstream access is checked when you run.'), cli, facts: [`cli: ${cli}`]};
  }
  const envKey = ENV_KEY_PROVIDERS.find(entry => entry.id === p.id);
  if (envKey) {
    const key = envKey.env;
    if (!env[key]) return {step: {stage: 'auth-missing', summary: `${key} is not set in Muster’s environment.`, hint: `Export ${key} in your shell profile (~/.zshrc). Muster reads your login shell environment at startup; restart Muster afterwards.`}, facts: []};
    if (p.error) return {step: {stage: stageForMessage(p.error), summary: p.error}, facts: []};
    return {step: ok(`${key} is set.`), facts: []};
  }
  if (p.custom) {
    if (p.error || (p.detail && /not set|could not be read/.test(p.detail) && !p.available)) return {step: {stage: 'auth-missing', summary: p.error ?? p.detail!, hint: 'Paste the API key under “API key”, then check the connection.'}, facts: [`endpoint: ${p.endpoint}`]};
    if (!p.models.length) return {step: {stage: 'catalog-unreadable', summary: p.checkedAt ? 'Model discovery found no models.' : 'Models have not been discovered yet.', hint: 'Use “Check connection” to read the endpoint’s /models catalog.'}, facts: [`endpoint: ${p.endpoint}`]};
    return {step: ok('Model discovery succeeded.'), facts: [`endpoint: ${p.endpoint}`]};
  }
  return {step: p.available ? ok('Ready.') : {stage: 'profile-invalid', summary: p.error ?? p.detail ?? 'Unavailable.'}, facts: []};
}

/** Maps a check or run error message onto a stage, for errors that only arrive as text. */
export function stageForMessage(message: string): ProviderStage {
  if (/HTTP (401|403)|rejected the API key|not (set|available) (in|to) Muster|sign-?in|unauthori[sz]ed|expired/i.test(message)) return /expired/i.test(message) ? 'auth-expired' : 'auth-missing';
  if (/catalog|no models/i.test(message)) return 'catalog-unreadable';
  if (/executable|not found|ENOENT/i.test(message)) return 'executable-missing';
  if (/profile|config/i.test(message)) return 'profile-invalid';
  return 'transport';
}

/** Emails, bearer-ish tokens and the home directory are removed; the report is safe to paste into an issue. */
export function redactDiagnostics(text: string, home = homedir()): string {
  let out = text.replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, '[email]').replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/\b[A-Za-z0-9_\-]{32,}(\.[A-Za-z0-9_\-]{8,}){0,2}\b/g, '[redacted]');
  if (home.length > 1) out = out.split(home).join('~');
  return out;
}

const versions = new Map<string, {stamp: string; value: Promise<string | null>}>();
/** `<cli> --version`, cached per path and mtime, 3s cap. */
export function cliVersion(cli: string): Promise<string | null> {
  let stamp = ''; try { const s = statSync(cli); stamp = `${s.mtimeMs}:${s.size}`; } catch { return Promise.resolve(null); }
  const hit = versions.get(cli); if (hit?.stamp === stamp) return hit.value;
  const value = new Promise<string | null>(resolve => execFile(cli, ['--version'], {timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8'}, (error, stdout) => {
    const line = !error && typeof stdout === 'string' ? stdout.trim().split('\n')[0]!.slice(0, 120) : '';
    resolve(line || null);
  }));
  versions.set(cli, {stamp, value});
  return value;
}

export async function diagnoseProvider(p: ProviderInfo, options: DiagnoseOptions = {}): Promise<ProviderDiagnosis> {
  const env = options.env ?? process.env, home = options.home ?? homedir(), now = (options.now ?? Date.now)();
  const directory = options.directory ?? (typeof __dirname === 'string' ? __dirname : process.cwd());
  const run = isCodexRoute(p) ? codexSteps(p, {env, home, directory, now, ...(options.dataDir ? {dataDir: options.dataDir} : {})}) : otherSteps(p, env, home);
  const version = run.cli ? await (options.version ?? cliVersion)(run.cli) : null;
  const checkedAt = new Date(now).toISOString();
  const report = [`Muster provider diagnostics`, `provider: ${p.name} (${p.id})`, `status: ${p.status ?? 'unknown'}${p.available ? ' · available' : ''}`, `stage: ${run.step.stage}`, `summary: ${run.step.summary}`,
    ...(run.step.hint ? [`hint: ${run.step.hint}`] : []), `version: ${version ?? 'unknown'}`, ...run.facts, ...(p.error ? [`error: ${p.error}`] : []), `models: ${p.models.length}`, `platform: ${process.platform} ${process.arch}`, `checked: ${checkedAt}`].join('\n');
  return {id: p.id, ...run.step, version, checkedAt, diagnostics: redactDiagnostics(report, home)};
}
