/**
 * Well-known API-key environment variables and local model servers Muster can offer without any setup.
 * Nothing here is assumed to exist: an env route appears only when its variable is set, and a local server
 * only when it answers on its default localhost port (or the port its own configuration names). Models always
 * come from the provider's own `/models` endpoint; there is no built-in model list.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface EnvKeyProvider {
  /** Muster provider id (`env-<name>`). */
  id: string; env: string; name: string;
  /** OpenAI-compatible base URL (`/models`, `/chat/completions`); the OpenAI and Anthropic rows have their own adapters. */
  endpoint: string;
  /** Environment variable that overrides the endpoint, when the vendor documents one. */
  baseEnv?: string;
  kind: 'openai' | 'anthropic' | 'openai-compatible';
}
export const ENV_KEY_PROVIDERS: readonly EnvKeyProvider[] = [
  { id: 'env-openai', env: 'OPENAI_API_KEY', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', baseEnv: 'OPENAI_BASE_URL', kind: 'openai' },
  { id: 'env-anthropic', env: 'ANTHROPIC_API_KEY', name: 'Anthropic', endpoint: 'https://api.anthropic.com/v1', kind: 'anthropic' },
  { id: 'env-openrouter', env: 'OPENROUTER_API_KEY', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', kind: 'openai-compatible' },
  { id: 'env-groq', env: 'GROQ_API_KEY', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', kind: 'openai-compatible' },
  { id: 'env-mistral', env: 'MISTRAL_API_KEY', name: 'Mistral', endpoint: 'https://api.mistral.ai/v1', kind: 'openai-compatible' },
  { id: 'env-deepseek', env: 'DEEPSEEK_API_KEY', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', kind: 'openai-compatible' },
  { id: 'env-gemini', env: 'GEMINI_API_KEY', name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai-compatible' },
  { id: 'env-xai', env: 'XAI_API_KEY', name: 'xAI', endpoint: 'https://api.x.ai/v1', kind: 'openai-compatible' },
  { id: 'env-together', env: 'TOGETHER_API_KEY', name: 'Together AI', endpoint: 'https://api.together.xyz/v1', kind: 'openai-compatible' },
  { id: 'env-fireworks', env: 'FIREWORKS_API_KEY', name: 'Fireworks AI', endpoint: 'https://api.fireworks.ai/inference/v1', kind: 'openai-compatible' },
];

export interface LocalServer {
  /** Muster provider id (`local-<name>`). */
  id: string; name: string; endpoint: string;
  /** Environment variable holding a key for the server, if it needs one. */
  keyEnv?: string;
}
const port = (value: string | undefined): number | undefined => { const n = Number(value); return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined; };
/** Only a loopback host: Muster never probes another machine. */
const loopback = (value: string | undefined): string | undefined => value && /^(?:127\.0\.0\.1|localhost|\[?::1\]?)$/.test(value) ? value : undefined;
/** `PORT=`/`OMNIROUTE_PORT=` from OmniRoute's own `.env`; no other line of that file is kept. */
function omniRoutePort(dir: string): number | undefined {
  try {
    const file = join(dir, '.env');
    if (statSync(file).size > 64 * 1024) return undefined;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) { const match = /^\s*(?:export\s+)?(?:OMNIROUTE_)?PORT\s*=\s*"?(\d{1,5})"?\s*$/.exec(line); if (match) return port(match[1]); }
  } catch { /* no .env */ }
  return undefined;
}
/** Local model servers worth one quick localhost probe. OmniRoute is only probed when the user has it installed
 *  (its data folder or OMNIROUTE_* environment); Ollama and LM Studio on their documented default ports. */
export function localServers(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), hasOmniRoute: boolean): LocalServer[] {
  const servers: LocalServer[] = [];
  const ollama = env.OLLAMA_HOST && /^(?:https?:\/\/)?(127\.0\.0\.1|localhost)(?::(\d{1,5}))?\/?$/.exec(env.OLLAMA_HOST);
  servers.push({ id: 'local-ollama', name: 'Ollama (this Mac)', endpoint: `http://${ollama ? ollama[1] : '127.0.0.1'}:${ollama && port(ollama[2]) || 11434}/v1` });
  servers.push({ id: 'local-lmstudio', name: 'LM Studio (this Mac)', endpoint: `http://127.0.0.1:${port(env.LMSTUDIO_PORT) ?? 1234}/v1` });
  if (hasOmniRoute) {
    const dir = env.OMNIROUTE_HOME || join(home, '.omniroute');
    const host = loopback(env.OMNIROUTE_HOST) ?? '127.0.0.1';
    servers.push({ id: 'local-omniroute', name: 'OmniRoute (this Mac)', endpoint: `http://${host}:${port(env.OMNIROUTE_PORT) ?? omniRoutePort(dir) ?? 20128}/v1`, keyEnv: 'OMNIROUTE_API_KEY' });
  }
  return servers;
}
