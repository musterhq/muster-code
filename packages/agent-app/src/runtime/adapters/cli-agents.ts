import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {ProviderInfo} from '../../shared/protocol.ts';
import {findBinary} from './shared.ts';
import {deviceNoun} from '../../shared/device-noun.ts';

/**
 * The user's own agent CLIs Muster can drive, as plain data (name, description, install link, login command,
 * detection). A provider catalog can register these entries as they are; nothing here touches the UI.
 */
export interface CliAgentMeta {
  /** Provider id in the registry and model picker. */
  id: 'cursor-agent' | 'gemini-cli' | 'grok-cli' | 'antigravity';
  name: string; description: string;
  installUrl: string; loginCommand: string;
  /** Environment variable that points Muster at a specific binary. */
  commandEnv: string;
  /** False when Muster detects the app but cannot run it; `unsupportedReason` says why. */
  runnable: boolean; unsupportedReason?: string;
  /** The installed binary's path, or undefined. A PATH walk only; no process is started. */
  detect(env: NodeJS.ProcessEnv, home: string): string | undefined;
}

const override = (env: NodeJS.ProcessEnv, name: string) => env[name] && existsSync(env[name]!) ? env[name] : undefined;

export const CLI_AGENTS: readonly CliAgentMeta[] = [
  {id: 'cursor-agent', name: 'Cursor CLI', description: 'Runs your Cursor Agent CLI in the chat folder (print mode, streaming JSON) with your Cursor subscription.',
    installUrl: 'https://cursor.com/cli', loginCommand: 'cursor-agent login', commandEnv: 'MUSTER_CURSOR_COMMAND', runnable: true,
    // `agent` is Cursor's short alias, but too generic a name to look up on PATH: only its install folder is checked.
    detect: (env, home) => override(env, 'MUSTER_CURSOR_COMMAND') ?? findBinary('cursor-agent', env, home, [join(home, '.local/bin/cursor-agent'), join(home, '.local/bin/agent')])},
  {id: 'gemini-cli', name: 'Gemini CLI', description: 'Runs your Gemini CLI in the chat folder (headless, streaming JSON) with your Google sign-in or Gemini API key.',
    installUrl: 'https://github.com/google-gemini/gemini-cli#installation', loginCommand: 'gemini', commandEnv: 'MUSTER_GEMINI_COMMAND', runnable: true,
    detect: (env, home) => override(env, 'MUSTER_GEMINI_COMMAND') ?? findBinary('gemini', env, home)},
  {id: 'grok-cli', name: 'Grok Build', description: 'Runs your Grok Build CLI in the chat folder over the Agent Client Protocol, with your Grok account or XAI_API_KEY. Needs version 1.0.13 or newer.',
    installUrl: 'https://x.ai/cli', loginCommand: 'grok login', commandEnv: 'MUSTER_GROK_COMMAND', runnable: true,
    detect: (env, home) => override(env, 'MUSTER_GROK_COMMAND') ?? findBinary('grok', env, home, [join(home, '.grok/bin/grok')])},
  {id: 'antigravity', name: 'Google Antigravity', description: `Detected on ${deviceNoun().lower}, but not supported yet.`,
    installUrl: 'https://antigravity.google/download', loginCommand: '', commandEnv: 'MUSTER_ANTIGRAVITY_COMMAND', runnable: false,
    unsupportedReason: 'Antigravity is a desktop app. T3 Code drives it only through a private agent runtime that it downloads and signs in with its own Google OAuth flow; the installed app has no headless or local agent interface Muster can use.',
    detect: (env, home) => override(env, 'MUSTER_ANTIGRAVITY_COMMAND') ?? findBinary('antigravity', env, home, [join(home, '.antigravity/antigravity/bin/antigravity'), '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity'])},
];
export const cliAgent = (id: string) => CLI_AGENTS.find(meta => meta.id === id);

/** Registry rows for agent CLIs that are not installed: hidden from the model picker (not available), listed under
 *  "not detected" in Accounts & providers with a How to install link. */
export function absentCliAgentRows(env: NodeJS.ProcessEnv, home: string): ProviderInfo[] {
  return CLI_AGENTS.filter(meta => !meta.detect(env, home)).map(meta => ({id: meta.id, name: meta.name, available: false, identityMasked: '', models: [], status: 'not-detected' as const,
    source: 'Not installed', detail: `${meta.runnable ? meta.description : 'Not installed.'} Install it, sign in, then scan again.`, installUrl: meta.installUrl, ...(meta.loginCommand ? {loginCommand: meta.loginCommand} : {})}));
}
