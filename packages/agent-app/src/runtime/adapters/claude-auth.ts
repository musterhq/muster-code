/**
 * Is Claude Code signed in? Answered without running `claude` at all: an unknown subcommand is a prompt to
 * `claude`, so executing it could start a model session. Instead, in order:
 *   1. an API key or OAuth token in the environment (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN);
 *   2. local account files through provider discovery (.credentials.json, or oauthAccount in .claude.json);
 *   3. on macOS, whether the Keychain holds a "Claude Code-credentials" item. `security find-generic-password`
 *      without -w/-g reads the item's attributes only; it never returns the secret and never shows a prompt.
 * Nothing here reads a token.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverLocalProviders } from '../provider-discovery.ts';

export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
export interface ClaudeAuthOptions {
  env?: NodeJS.ProcessEnv; home?: string; platform?: string;
  /** Exit status of `security find-generic-password -s <service>` (0 = the item exists). */
  keychain?: (service: string) => Promise<boolean>;
  /** `claude auth status` exit status (0 = signed in). Off under node:test unless a test injects it. */
  authStatus?: () => Promise<boolean>;
}
const defaultKeychain = (service: string) => new Promise<boolean>(resolve => {
  execFile('/usr/bin/security', ['find-generic-password', '-s', service], { timeout: 3_000, maxBuffer: 64 * 1024 }, error => resolve(!error));
});

// `claude auth status` is non-interactive and fast (~0.1s): it never starts a model session or prompts.
const defaultAuthStatus = () => new Promise<boolean>(resolve => {
  execFile('claude', ['auth', 'status'], { timeout: 5_000, maxBuffer: 64 * 1024 }, error => resolve(!error));
});

/** Resolves to how Claude Code is signed in; rejects with a user-facing sentence when it is not. */
export async function claudeSignIn(options: ClaudeAuthOptions = {}): Promise<string> {
  const env = options.env ?? process.env, home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'OAuth token in the environment';
  if (env.ANTHROPIC_API_KEY) return 'Anthropic API key in the environment';
  const local = (await discoverLocalProviders({ home, env }).catch(() => [])).find(row => row.id === 'claude-code');
  if (local?.status === 'configured') return local.credentialPresent ? 'Credential file on this Mac' : 'Account on this Mac';
  if (platform === 'darwin' && await (options.keychain ?? defaultKeychain)(CLAUDE_KEYCHAIN_SERVICE).catch(() => false)) return 'Signed in (Keychain)';
  const status = options.authStatus ?? (process.env.NODE_TEST_CONTEXT ? undefined : defaultAuthStatus);
  if (status && await status().catch(() => false)) return 'Signed in (claude auth status)';
  throw new Error('Claude Code is installed but not signed in. Run `claude auth login` in Terminal, then scan again.');
}

/** Changes when a sign-in or sign-out rewrites Claude Code's account files, so a cached answer is re-checked at once. */
export function claudeAuthStamp(options: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const files = [join(dir, '.credentials.json'), env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json')];
  const stamp = files.map(file => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
  return `${stamp}|${env.ANTHROPIC_API_KEY ? 'k' : ''}${env.CLAUDE_CODE_OAUTH_TOKEN ? 't' : ''}`;
}
