import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ProviderInfo} from '../../shared/protocol.ts';
import {activeCustomProviders, customRunnable, CUSTOM_CHAT_ONLY, type CustomConnection} from '../custom-providers.ts';
import {validateEndpoint} from '../custom-providers.ts';
import {providerDataDir, type ProviderInstance} from '../provider-instances.ts';
import {claudeCodeAdapter, CLAUDE_CODE_MODELS, type Spawn} from './claude-code.ts';
import {ANTHROPIC_API, anthropicAdapter, CHAT_ONLY, fetchModelList, openAICompatibleAdapter} from './http-chat.ts';
import {openCodeAdapter, openCodeCapabilities, probe} from './opencode.ts';
import {ConversationMemory, findBinary, Validator} from './shared.ts';
import type {RunnableAdapter, Validation} from './types.ts';

export type {RunnableAdapter} from './types.ts';
/** Provider ids served by these adapters; their runs never leave remote work behind. */
export const isAdapterProvider = (id: string) => id === 'claude-code' || id === 'opencode' || id === 'env-openai' || id === 'env-anthropic' || id.startsWith('custom_');
const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const OPENAI_CHAT = /^(?:gpt-|chatgpt-|o[1-9])/, OPENAI_EXCLUDE = /(?:audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|dall-e|codex)/;

export interface AdapterCatalogOptions {
  env?: NodeJS.ProcessEnv; home?: string; fetch?: typeof fetch; spawn?: Spawn;
  /** Saved OpenAI-compatible connections; defaults to the runtime's open CustomProviders store. */
  customs?: () => CustomConnection[];
  /** Folder for stateless-provider conversation history; defaults to memory only. */
  historyDir?: () => string | undefined;
}
export interface AdapterCatalog { instances(): ProviderInstance[]; ready(): Promise<void> }

/** Claude Code, OpenCode, env API keys and custom endpoints. A row is available only once its adapter validated. */
export function createAdapterCatalog(options: AdapterCatalogOptions = {}): AdapterCatalog {
  const env = () => options.env ?? process.env, home = options.home ?? homedir();
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const memories = new Map<string, ConversationMemory>();
  const memory = (id: string) => { let found = memories.get(id); if (!found) { found = new ConversationMemory(64, 400_000, () => { const dir = (options.historyDir ?? providerDataDir)(); return dir ? join(dir, 'provider-conversations', id) : undefined; }); memories.set(id, found); } return found; };
  const adapters = new Map<string, RunnableAdapter>();
  const adapter = (key: string, make: () => RunnableAdapter) => { let found = adapters.get(key); if (!found) { found = make(); adapters.set(key, found); } return found; };
  const claudeCheck = new Validator(async () => (await probe(claudeBinary()!, ['--version'], options.spawn)).trim().split('\n')[0]!.slice(0, 80));
  const openCodeCheck = new Validator(() => openCodeCapabilities(openCodeBinary()!, options.spawn));
  const openAIBase = () => { try { return env().OPENAI_BASE_URL ? validateEndpoint(env().OPENAI_BASE_URL) : 'https://api.openai.com/v1'; } catch { return 'https://api.openai.com/v1'; } };
  const openAICheck = new Validator(async () => (await fetchModelList(`${openAIBase()}/models`, {authorization: `Bearer ${env().OPENAI_API_KEY}`}, 'OpenAI', request)).filter(model => OPENAI_CHAT.test(model.id) && !OPENAI_EXCLUDE.test(model.id)).sort((a, b) => b.id.localeCompare(a.id)));
  const anthropicCheck = new Validator(async () => fetchModelList(`${ANTHROPIC_API}/models?limit=100`, {'x-api-key': env().ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01'}, 'Anthropic', request));
  // info() runs on every send and listing; a PATH walk is re-done at most every 5s.
  const found = new Map<string, {at: number; key: string; value?: string}>();
  const binary = (name: string, override: string | undefined, candidate: string) => {
    if (override) return override;
    const key = env().PATH ?? '', hit = found.get(name), at = Date.now();
    if (hit && hit.key === key && at - hit.at < 5000) return hit.value;
    const value = findBinary(name, env(), home, [candidate]); found.set(name, {at, key, value}); return value;
  };
  const claudeBinary = () => binary('claude', env().MUSTER_CLAUDE_COMMAND, join(home, '.claude/local/claude'));
  const openCodeBinary = () => binary('opencode', env().MUSTER_OPENCODE_COMMAND, join(home, '.opencode/bin/opencode'));
  const validators = [claudeCheck, openCodeCheck, openAICheck, anthropicCheck];

  const route = (info: ProviderInfo, run?: RunnableAdapter): ProviderInstance => ({info, command: '', env: {}, sessionsRoot: '', ...(run ? {adapter: run} : {})});
  /** Pending and failed checks stay visible but unavailable; nothing falls back to another provider. */
  const gate = <T>(base: ProviderInfo, check: Validation<T>, ready: (value: T) => {models: ProviderInfo['models']; detail: string}, run: () => RunnableAdapter): ProviderInstance => {
    if (check.status === 'ok') { const {models, detail} = ready(check.value!); if (models.length) return route({...base, models, available: true, status: 'ready', detail}, run()); return route({...base, status: 'error', error: 'No usable chat models were reported.', detail: 'No usable chat models were reported. No provider fallback will be used.'}); }
    if (check.status === 'error') return route({...base, status: 'error', error: check.reason, detail: `${check.reason} No provider fallback will be used.`});
    return route({...base, status: 'configured', detail: 'Checking this provider… Scan again in a moment.'});
  };

  function instances(): ProviderInstance[] {
    const e = env(), rows: ProviderInstance[] = [];
    const claude = claudeBinary();
    if (claude) {
      const bindingId = hash('claude-code', claude);
      rows.push(gate({id: 'claude-code', name: 'Claude Code', driver: 'claude-code-cli', bindingId, identityMasked: 'Claude Code sign-in', models: [], available: false, source: claude},
        claudeCheck.current(claude), version => ({models: CLAUDE_CODE_MODELS, detail: `Runs Claude Code ${version} in the chat folder with its own tools, settings and MCP servers. Read-only and Plan chats use plan mode.`}),
        () => adapter(`claude:${bindingId}`, () => claudeCodeAdapter({binary: claude, env: e, spawn: options.spawn}))));
    }
    const openCode = openCodeBinary();
    if (openCode) {
      const bindingId = hash('opencode', openCode);
      rows.push(gate({id: 'opencode', name: 'OpenCode', driver: 'opencode-cli', bindingId, identityMasked: 'OpenCode sign-in', models: [], available: false, source: openCode},
        openCodeCheck.current(openCode), value => ({models: value.models, detail: 'Runs OpenCode in the chat folder with its own tools and providers. Read-only chats use the plan agent.'}),
        () => adapter(`opencode:${bindingId}`, () => openCodeAdapter({binary: openCode, env: e, spawn: options.spawn}))));
    }
    if (e.OPENAI_API_KEY) {
      const base = openAIBase(), bindingId = hash('env-openai', base, hash(e.OPENAI_API_KEY));
      rows.push(gate({id: 'env-openai', name: 'OpenAI API key (environment)', driver: 'openai-chat-completions', bindingId, identityMasked: 'Key set in environment', models: [], available: false, source: 'env:OPENAI_API_KEY', endpoint: base},
        openAICheck.current(bindingId), models => ({models, detail: `${CHAT_ONLY}. Streams chat completions with OPENAI_API_KEY from Muster’s environment.`}),
        () => adapter(`openai:${bindingId}`, () => openAICompatibleAdapter({endpoint: base, apiKey: () => env().OPENAI_API_KEY, label: 'OpenAI', fetch: request, memory: memory('env-openai')}))));
    }
    if (e.ANTHROPIC_API_KEY) {
      const bindingId = hash('env-anthropic', hash(e.ANTHROPIC_API_KEY));
      rows.push(gate({id: 'env-anthropic', name: 'Anthropic API key (environment)', driver: 'anthropic-messages', bindingId, identityMasked: 'Key set in environment', models: [], available: false, source: 'env:ANTHROPIC_API_KEY'},
        anthropicCheck.current(bindingId), models => ({models, detail: `${CHAT_ONLY}. Streams the Messages API with ANTHROPIC_API_KEY from Muster’s environment.`}),
        () => adapter(`anthropic:${bindingId}`, () => anthropicAdapter({apiKey: () => env().ANTHROPIC_API_KEY, fetch: request, memory: memory('env-anthropic')}))));
    }
    const store = options.customs ? undefined : activeCustomProviders();
    store?.claim();
    for (const connection of options.customs?.() ?? store?.connections() ?? []) {
      if (!customRunnable(connection, e)) continue;
      const bindingId = hash(connection.id, connection.endpoint, connection.apiKeyEnv);
      rows.push(route({id: connection.id, name: connection.name, driver: 'openai-chat-completions', bindingId, custom: true, endpoint: connection.endpoint, apiKeyEnv: connection.apiKeyEnv || undefined, ...(connection.checkedAt ? {checkedAt: connection.checkedAt} : {}),
        identityMasked: 'No account metadata', canReveal: false, source: 'Added in Muster', models: connection.models, available: true, status: 'ready', detail: `${CUSTOM_CHAT_ONLY}. OpenAI-compatible chat completions; model discovery succeeded.`},
        adapter(`custom:${bindingId}`, () => openAICompatibleAdapter({endpoint: connection.endpoint, apiKey: () => connection.apiKeyEnv ? env()[connection.apiKeyEnv] : undefined, label: connection.name, fetch: request, memory: memory(connection.id)}))));
    }
    return rows;
  }
  return {instances, async ready() { instances(); await Promise.all(validators.map(check => check.settled())); }};
}
