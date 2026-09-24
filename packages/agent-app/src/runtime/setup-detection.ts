/**
 * R9 first-run detection. Answers "can this Mac run a chat yet, and what is missing?" from what Muster already
 * knows (provider discovery, CLI maintenance, the provider list) plus two cheap probes: `git --version` and
 * `docker version`. Read-only and prompt-free: it never signs in, installs, starts Docker, or asks macOS for a
 * permission. On macOS `/usr/bin/git` is a shim that pops the Command Line Tools installer when they are missing,
 * so it is only run once `xcode-select -p` says the tools are there.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ProviderInfo } from '../shared/protocol.ts';
import type { CliStatus, CliTool } from '../shared/domains/providers-protocol.ts';
import type { SetupCli, SetupConnection, SetupDocker, SetupGit, SetupStatus } from '../shared/domains/setup-protocol.ts';
import type { DiscoveredProvider } from './provider-discovery.ts';
import { extractVersion } from './cli-maintenance.ts';
import { which } from './provider-diagnostics.ts';

export interface RunResult { ok: boolean; stdout: string; stderr: string; timedOut?: boolean }
export interface SetupDetectionDeps {
  providers(): Promise<ProviderInfo[]>;
  cliStatus(): Promise<CliStatus[]>;
  discovered(): Promise<DiscoveredProvider[]>;
  run?(file: string, args: string[], timeoutMs: number): Promise<RunResult>;
  exists?(path: string): boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: string;
  now?(): number;
}

/** Which CLI a provider runs through, if any. Every route from the user's Codex config (a ChatGPT sign-in or any
 *  gateway they configured) runs through the Codex CLI. */
export function cliForProvider(provider: string | Pick<ProviderInfo, 'id' | 'codex' | 'driver'>): CliTool | undefined {
  const row = typeof provider === 'string' ? {id: provider} as Pick<ProviderInfo, 'id' | 'codex' | 'driver'> : provider;
  if (row.codex || row.driver === 'codex-app-server' || row.id === 'codex') return 'codex';
  if (row.id === 'claude-code') return 'claude';
  if (row.id === 'opencode') return 'opencode';
  return undefined;
}
const DISCOVERY_ID: Record<CliTool, string> = { codex: 'codex', claude: 'claude-code', opencode: 'opencode' };
const LOGIN_ARGS: Record<CliTool, string> = { codex: 'login', claude: 'auth login', opencode: 'auth login' };
const BIN: Record<CliTool, string> = { codex: 'codex', claude: 'claude', opencode: 'opencode' };

/** POSIX single-quote, only when the word needs it. */
export const shellWord = (word: string): string => /^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/** The sign-in command for a CLI. A Muster-managed copy is not on the user's PATH, so it is named by its full path. */
export function loginCommand(tool: CliTool, status?: Pick<CliStatus, 'installed'>): string {
  const path = status?.installed.managed && status.installed.path ? shellWord(status.installed.path) : BIN[tool];
  return `${path} ${LOGIN_ARGS[tool]}`;
}

/** One row per CLI Muster supports, whether or not it is installed. */
export function summarizeClis(statuses: readonly CliStatus[], discovered: readonly DiscoveredProvider[], providers: readonly ProviderInfo[]): SetupCli[] {
  const order: CliTool[] = ['codex', 'claude', 'opencode'];
  return order.map(tool => {
    const status = statuses.find(row => row.tool === tool);
    const found = discovered.find(row => row.id === DISCOVERY_ID[tool]);
    const ready = providers.some(provider => provider.available && cliForProvider(provider) === tool);
    const installed = Boolean(status?.installed.path);
    const signedIn = found?.status === 'configured' && found.credentialPresent || ready;
    // Codex and Claude Code can keep the sign-in in the Keychain; with config files present but no credential file,
    // "not signed in" is a guess. The provider list (a real probe) still wins when it says ready.
    const signInUnknown = !signedIn && found?.status === 'installed' && tool !== 'opencode';
    const label = status?.label ?? (tool === 'codex' ? 'Codex CLI' : tool === 'claude' ? 'Claude Code' : 'OpenCode');
    const detail = ready ? 'Ready for chats.'
      : !installed ? `${label} is not installed.`
      : signedIn ? 'Signed in locally, but no chat model is available yet. Check again, or open Settings › Providers.'
      : signInUnknown ? 'Installed. A sign-in may be stored in the Keychain; if chats do not start, sign in.'
      : 'Installed, not signed in.';
    return {
      tool, label, installed, version: status?.installed.version ?? null, managed: Boolean(status?.installed.managed),
      signedIn, signInUnknown, ready,
      account: signedIn ? found?.identityMasked || 'Signed in' : '',
      loginCommand: loginCommand(tool, status), detail,
    };
  });
}

/** Non-CLI connections worth listing: the gateway, connections added in Muster, and API keys in the environment. */
export function summarizeConnections(providers: readonly ProviderInfo[]): SetupConnection[] {
  const rows: SetupConnection[] = [];
  for (const provider of providers) {
    const kind: SetupConnection['kind'] | undefined = provider.custom ? 'custom' : provider.codex?.kind === 'gateway' ? 'gateway' : provider.id.startsWith('env-') ? 'env' : provider.id.startsWith('local-') ? 'local' : undefined;
    if (!kind) continue;
    if (!provider.available && (provider.status === 'not-detected' || provider.status === undefined && kind !== 'custom')) continue;
    rows.push({ id: provider.id, name: provider.name, kind, ready: provider.available, detail: provider.available ? 'Ready for chats.' : provider.error ?? provider.detail ?? 'Not available for chats yet.' });
  }
  return rows;
}

const defaultRun = (file: string, args: string[], timeoutMs: number): Promise<RunResult> => new Promise(resolve => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed ? { timedOut: true } : {}) });
  });
});

export async function detectGit(deps: Pick<SetupDetectionDeps, 'run' | 'env' | 'platform' | 'exists'>): Promise<SetupGit> {
  const run = deps.run ?? defaultRun, env = deps.env ?? process.env, platform = deps.platform ?? process.platform;
  const git = which('git', env, ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
  if (!git) return { available: false, version: null, detail: 'Git was not found. Install it (for example with the Xcode Command Line Tools) to review changes and clone repositories.' };
  if (platform === 'darwin' && git === '/usr/bin/git') {
    const tools = await run('/usr/bin/xcode-select', ['-p'], 3_000);
    if (!tools.ok) return { available: false, version: null, detail: 'Git comes with the Xcode Command Line Tools, which are not installed. Run `xcode-select --install` in Terminal.' };
  }
  const result = await run(git, ['--version'], 3_000);
  const version = result.ok ? extractVersion(result.stdout) ?? result.stdout.trim().slice(0, 60) : null;
  return result.ok ? { available: true, version, detail: `Git ${version ?? ''}`.trim() } : { available: false, version: null, detail: 'Git is installed but did not run.' };
}

export const DOCKER_CANDIDATES = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
export async function detectDocker(deps: Pick<SetupDetectionDeps, 'run' | 'env' | 'exists'>): Promise<SetupDocker> {
  const run = deps.run ?? defaultRun, exists = deps.exists ?? existsSync, env = deps.env ?? process.env;
  const bin = DOCKER_CANDIDATES.find(path => exists(path)) ?? which('docker', env);
  if (!bin) return { installed: false, running: null, version: null, detail: 'Docker is not installed. Sandboxes run agents in an isolated Linux container and need Docker Desktop.' };
  // `docker version` asks the daemon for its version; it never starts Docker Desktop.
  const result = await run(bin, ['version', '--format', '{{.Server.Version}}'], 4_000);
  const version = result.ok ? extractVersion(result.stdout) ?? (result.stdout.trim().slice(0, 40) || null) : null;
  if (result.ok && version) return { installed: true, running: true, version, detail: `Docker ${version} is running.` };
  if (result.timedOut) return { installed: true, running: null, version: null, detail: 'Docker did not answer in time. It may still be starting.' };
  return { installed: true, running: false, version: null, detail: 'Docker Desktop is installed but not running. Start it to use sandboxes.' };
}

/** Everything the first run and the Setup checklist show. A part that fails reads as "not detected", never as a crash. */
export async function detectSetup(deps: SetupDetectionDeps): Promise<SetupStatus> {
  const now = deps.now ?? Date.now;
  const [providers, statuses, discovered, git, docker] = await Promise.all([
    deps.providers().catch(() => [] as ProviderInfo[]),
    deps.cliStatus().catch(() => [] as CliStatus[]),
    deps.discovered().catch(() => [] as DiscoveredProvider[]),
    detectGit(deps).catch(() => ({ available: false, version: null, detail: 'Git could not be checked.' })),
    detectDocker(deps).catch(() => ({ installed: false, running: null, version: null, detail: 'Docker could not be checked.' })),
  ]);
  return {
    checkedAt: new Date(now()).toISOString(), platform: deps.platform ?? process.platform,
    clis: summarizeClis(statuses, discovered, providers),
    connections: summarizeConnections(providers),
    readyProviders: providers.filter(provider => provider.available).map(provider => { const cli = cliForProvider(provider); return { id: provider.id, name: provider.name, ...(cli ? { cli } : {}) }; }),
    git, docker,
  };
}
export const defaultHome = () => homedir();
