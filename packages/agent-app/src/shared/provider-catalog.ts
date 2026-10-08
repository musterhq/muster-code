/**
 * The "Add provider" catalog: one entry per card in Settings > Accounts & providers > Add provider.
 *
 * The card grid, the sheet fields, the status chip and the save flow are all driven from {@link PROVIDER_CATALOG}, so a
 * new adapter (Cursor, Gemini, Grok, Antigravity, ...) is one entry here and nothing in the renderer. Register extra
 * entries with {@link registerCatalogEntries} or append to the array below. Pure data and pure functions: no React, no
 * Electron, no network, so it is importable from the runtime, the renderer and tests alike.
 */
import type { ProviderInfo } from './protocol.ts';
import { device } from './device-noun.ts';

/** subscription-cli: sign in with a vendor CLI. api-key: hosted API with one key. local: self-hosted URL plus optional key. custom: any OpenAI-compatible URL. */
export type CatalogAuthKind = 'subscription-cli' | 'api-key' | 'local' | 'custom';
/** Glyph keys that ProviderLogo ships (simple-icons, CC0). An entry without one gets a monogram. */
export type CatalogLogo = 'anthropic' | 'claude' | 'openai' | 'ollama' | 'lmstudio' | 'opencode'
  | 'mistral' | 'openrouter' | 'deepseek' | 'gemini' | 'cursor';
/** connected: usable now. installed: CLI present, not signed in. missing: CLI absent. not-connected: API/local with no live connection yet. */
export type CatalogStatus = 'connected' | 'installed' | 'missing' | 'not-connected';

export interface CatalogEntry {
  /** Stable id, unique across the catalog. */
  id: string;
  name: string;
  /** One line shown on the card. */
  description: string;
  /** Brand glyph key, or omitted for a monogram. */
  logo?: CatalogLogo;
  authKind: CatalogAuthKind;
  /** Where to install the CLI (subscription-cli). */
  installUrl?: string;
  /** Shell command that installs the CLI (subscription-cli). */
  installCommand?: string;
  /** Shell command that signs in (subscription-cli). The runtime diagnosis may supply a more exact one. */
  loginCommand?: string;
  /** Provider ids in `providers.list` that mean this CLI is present (subscription-cli). */
  providerIds?: string[];
  /** Link-out to the page where the key is created (api-key). */
  keyUrl?: string;
  /** Prefilled base URL (api-key, local); empty for custom. */
  defaultEndpoint?: string;
  /** Maps the current provider listing to the card's status chip. */
  detect(providers: readonly ProviderInfo[]): CatalogStatus;
}

export const STATUS_LABEL: Record<CatalogStatus, string> = {
  connected: 'Connected', installed: 'Installed, not signed in', missing: 'Not installed', 'not-connected': 'Not connected',
};

/** Which sheet fields an auth kind shows. `advanced` fields live in the collapsed Advanced section. */
export interface FieldRules {
  signIn: boolean;
  key: 'none' | 'required' | 'optional';
  endpoint: 'none' | 'advanced' | 'shown';
  /** Name, base URL override and key environment variable always sit in the collapsed Advanced section. */
  advanced: boolean;
}
export function fieldRules(kind: CatalogAuthKind): FieldRules {
  switch (kind) {
    case 'subscription-cli': return {signIn: true, key: 'none', endpoint: 'none', advanced: false};
    case 'api-key': return {signIn: false, key: 'required', endpoint: 'advanced', advanced: true};
    case 'local': return {signIn: false, key: 'optional', endpoint: 'shown', advanced: true};
    case 'custom': return {signIn: false, key: 'optional', endpoint: 'shown', advanced: true};
  }
}

const norm = (url?: string) => (url ?? '').trim().toLowerCase().replace(/\/+$/, '').replace('localhost', '127.0.0.1');

const cliStatus = (ids: string[]) => (providers: readonly ProviderInfo[]): CatalogStatus => {
  const mine = providers.filter(p => ids.includes(p.id) || ids.some(id => p.id.startsWith(`${id}_`)));
  if (mine.some(p => p.available)) return 'connected';
  if (mine.some(p => p.status && p.status !== 'not-detected')) return 'installed';
  return 'missing';
};
/** An API/local card is connected when a live provider already points at the card's endpoint. */
const endpointStatus = (endpoint: string) => (providers: readonly ProviderInfo[]): CatalogStatus =>
  providers.some(p => p.available && norm(p.endpoint) === norm(endpoint)) ? 'connected' : 'not-connected';
const never = (): CatalogStatus => 'not-connected';

export const PROVIDER_CATALOG: CatalogEntry[] = [
  {id: 'codex', name: 'Codex (ChatGPT)', description: 'Use your ChatGPT plan through the Codex CLI.', logo: 'openai', authKind: 'subscription-cli',
    installUrl: 'https://developers.openai.com/codex/cli', installCommand: 'npm install -g @openai/codex', loginCommand: 'codex login',
    providerIds: ['codex', 'openai-direct'], detect: cliStatus(['codex', 'openai-direct'])},
  {id: 'claude-code', name: 'Claude Code', description: 'Use your Claude plan through the Claude Code CLI.', logo: 'claude', authKind: 'subscription-cli',
    installUrl: 'https://docs.claude.com/en/docs/claude-code/setup', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude auth login',
    providerIds: ['claude-code'], detect: cliStatus(['claude-code'])},
  {id: 'opencode', name: 'OpenCode', description: 'Open-source coding agent with many model providers.', logo: 'opencode', authKind: 'subscription-cli',
    installUrl: 'https://opencode.ai/docs', installCommand: 'npm install -g opencode-ai', loginCommand: 'opencode auth login',
    providerIds: ['opencode'], detect: cliStatus(['opencode'])},
  {id: 'openai-api', name: 'OpenAI API', description: 'GPT models with an OpenAI API key.', logo: 'openai', authKind: 'api-key',
    keyUrl: 'https://platform.openai.com/api-keys', defaultEndpoint: 'https://api.openai.com/v1', detect: endpointStatus('https://api.openai.com/v1')},
  {id: 'anthropic-api', name: 'Anthropic API', description: 'Claude models with an Anthropic API key.', logo: 'anthropic', authKind: 'api-key',
    keyUrl: 'https://console.anthropic.com/settings/keys', defaultEndpoint: 'https://api.anthropic.com/v1', detect: endpointStatus('https://api.anthropic.com/v1')},
  {id: 'openrouter', name: 'OpenRouter', description: 'One key for hundreds of hosted models.', logo: 'openrouter', authKind: 'api-key',
    keyUrl: 'https://openrouter.ai/keys', defaultEndpoint: 'https://openrouter.ai/api/v1', detect: endpointStatus('https://openrouter.ai/api/v1')},
  {id: 'groq', name: 'Groq', description: 'Very fast open models on Groq hardware.', authKind: 'api-key',
    keyUrl: 'https://console.groq.com/keys', defaultEndpoint: 'https://api.groq.com/openai/v1', detect: endpointStatus('https://api.groq.com/openai/v1')},
  {id: 'mistral', name: 'Mistral', description: 'Mistral and Codestral models.', logo: 'mistral', authKind: 'api-key',
    keyUrl: 'https://console.mistral.ai/api-keys', defaultEndpoint: 'https://api.mistral.ai/v1', detect: endpointStatus('https://api.mistral.ai/v1')},
  {id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek chat and reasoning models.', logo: 'deepseek', authKind: 'api-key',
    keyUrl: 'https://platform.deepseek.com/api_keys', defaultEndpoint: 'https://api.deepseek.com/v1', detect: endpointStatus('https://api.deepseek.com/v1')},
  {id: 'ollama', name: 'Ollama', description: `Models running on ${device().lower}.`, logo: 'ollama', authKind: 'local',
    installUrl: 'https://ollama.com/download', defaultEndpoint: 'http://127.0.0.1:11434/v1', detect: endpointStatus('http://127.0.0.1:11434/v1')},
  {id: 'lmstudio', name: 'LM Studio', description: 'Local models served by LM Studio.', logo: 'lmstudio', authKind: 'local',
    installUrl: 'https://lmstudio.ai', defaultEndpoint: 'http://127.0.0.1:1234/v1', detect: endpointStatus('http://127.0.0.1:1234/v1')},
  {id: 'omniroute', name: 'OmniRoute', description: 'A local or self-hosted model gateway.', authKind: 'local',
    defaultEndpoint: 'http://127.0.0.1:20128/v1', detect: endpointStatus('http://127.0.0.1:20128/v1')},
  {id: 'custom', name: 'Custom endpoint', description: 'Any OpenAI-compatible URL.', authKind: 'custom', defaultEndpoint: '', detect: never},
];

/** Adds entries from another adapter package. Ids already present are replaced, never duplicated. */
export function registerCatalogEntries(...entries: CatalogEntry[]): void {
  for (const entry of entries) {
    const at = PROVIDER_CATALOG.findIndex(row => row.id === entry.id);
    if (at >= 0) PROVIDER_CATALOG[at] = entry; else PROVIDER_CATALOG.splice(Math.max(0, PROVIDER_CATALOG.length - 1), 0, entry);
  }
}

/** Returns the message without Electron's IPC wrapper, in the plain sentence the runtime wrote. */
export function plainError(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const text = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '').trim();
  return text || fallback;
}

/** A name for a custom endpoint when the user does not give one: its host. */
export function nameFromEndpoint(endpoint: string): string {
  try { return new URL(endpoint).host || 'Custom endpoint'; } catch { return 'Custom endpoint'; }
}

/**
 * The sentence under an API key field, true for the OS it runs on. Mirrors what the runtime's secret store does with
 * Electron safeStorage: macOS Keychain, Windows DPAPI, Linux libsecret or KWallet. Where Linux has no keyring Electron
 * falls back to a hard-coded key ("basic_text"); the store refuses that and keeps the key for the session only.
 */
export function secretStorageNote(platform: string): string {
  if (/mac/i.test(platform)) return 'Stored encrypted in your macOS Keychain and never shown again.';
  if (/win/i.test(platform)) return 'Stored encrypted with Windows data protection (DPAPI) and never shown again.';
  return 'Stored encrypted in your desktop keyring (libsecret or KWallet) and never shown again. If no keyring is running, Muster keeps the key for this session only and does not write it to disk.';
}
