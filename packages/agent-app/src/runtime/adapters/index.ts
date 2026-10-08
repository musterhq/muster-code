import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ProviderInfo} from '../../shared/protocol.ts';
import {activeCustomProviders, customRunnable, resolveCustomKey, CUSTOM_CHAT_ONLY, type CustomConnection} from '../custom-providers.ts';
import {validateEndpoint} from '../custom-providers.ts';
import {providerDataDir, type ProviderInstance} from '../provider-instances.ts';
import {claudeCodeAdapter, type Spawn} from './claude-code.ts';
import {claudeCodeModels} from './claude-models.ts';
import {ANTHROPIC_API, anthropicAdapter, CHAT_ONLY, WITH_TOOLS, listChatModels, openAICompatibleAdapter, refusedTools} from './http-chat.ts';
import {openCodeAdapter, openCodeCapabilities, probe} from './opencode.ts';
import {ConversationMemory, findBinary, Validator} from './shared.ts';
import {ENV_KEY_PROVIDERS, localServers} from '../env-providers.ts';
import {configuredProviderInstances} from '../provider-instances.ts';
import {existsSync} from 'node:fs';
import {claudeAuthStamp, claudeSignIn} from './claude-auth.ts';
import type {RunnableAdapter, Validation} from './types.ts';
import {cliAgent} from './cli-agents.ts';
import {cursorAdapter, cursorCapabilities, CURSOR_ENV} from './cursor-cli.ts';
import {geminiAdapter, geminiCapabilities, geminiSignIn} from './gemini-cli.ts';
import {grokAdapter, grokCapabilities} from './grok-cli.ts';
import type {AgentSpawn} from './cli-common.ts';

export type {RunnableAdapter} from './types.ts';
/** Provider ids served by these adapters; their runs never leave remote work behind. */
export const isAdapterProvider = (id: string) => id === 'claude-code' || id === 'opencode' || id === 'cursor-agent' || id === 'gemini-cli' || id === 'grok-cli' || id === 'antigravity' || id.startsWith('env-') || id.startsWith('local-') || id.startsWith('custom_');
const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const OPENAI_CHAT = /^(?:gpt-|chatgpt-|o[1-9])/, OPENAI_EXCLUDE = /(?:audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|dall-e|codex)/;

export interface AdapterCatalogOptions {
  env?: NodeJS.ProcessEnv; home?: string; fetch?: typeof fetch; spawn?: Spawn;
  /** Saved OpenAI-compatible connections; defaults to the runtime's open CustomProviders store. */
  customs?: () => CustomConnection[];
  /** Folder for stateless-provider conversation history; defaults to memory only. */
  historyDir?: () => string | undefined;
  /** R9: resolves when Claude Code is signed in, rejects with the reason when not. Never runs `claude`. */
  claudeSignIn?: () => Promise<string>;
  /** Endpoints the user's Codex routes already reach; a local server behind one is not offered twice. */
  codexEndpoints?: () => string[];
  /** Probe local model servers (Ollama, LM Studio, an installed OmniRoute) on localhost. Default true outside tests. */
  localProbes?: boolean;
  /** Cursor CLI, Gemini CLI, Grok Build and Antigravity. Default true outside tests. */
  cliAgents?: boolean;
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
  // An installed but signed-out Claude Code is not offered as ready. Re-checked at once when its account files change.
  const claudeAuth = new Validator(options.claudeSignIn ?? (() => claudeSignIn({env: env(), home})), 60_000);
  const openCodeCheck = new Validator(() => openCodeCapabilities(openCodeBinary()!, options.spawn));
  const openAIBase = () => { try { return env().OPENAI_BASE_URL ? validateEndpoint(env().OPENAI_BASE_URL) : 'https://api.openai.com/v1'; } catch { return 'https://api.openai.com/v1'; } };
  const openAICheck = new Validator(async () => (await listChatModels(`${openAIBase()}/models`, {authorization: `Bearer ${env().OPENAI_API_KEY}`}, 'OpenAI', request)).filter(model => OPENAI_CHAT.test(model.id) && !OPENAI_EXCLUDE.test(model.id)).sort((a, b) => b.id.localeCompare(a.id)));
  const anthropicCheck = new Validator(async () => listChatModels(`${ANTHROPIC_API}/models?limit=100`, {'x-api-key': env().ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01'}, 'Anthropic', request));
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
  // Other well-known API-key variables: OpenAI-compatible endpoints, models from their own /models list.
  const envChecks = new Map(ENV_KEY_PROVIDERS.filter(key => key.kind === 'openai-compatible').map(key => [key.id, new Validator(async () => listChatModels(`${endpointFor(key)}/models`, {authorization: `Bearer ${env()[key.env]}`}, key.name, request))]));
  const endpointFor = (key: (typeof ENV_KEY_PROVIDERS)[number]) => { const override = key.baseEnv ? env()[key.baseEnv] : undefined; try { return override ? validateEndpoint(override) : key.endpoint; } catch { return key.endpoint; } };
  // Local servers answer fast or not at all; a server that is not running is simply not listed.
  const localChecks = new Map<string, Validator<Array<{id: string; name: string}>>>();
  const localCheck = (bindingId: string, label: string, endpoint: string, key: string | undefined) => { let found = localChecks.get(bindingId); if (!found) { if (localChecks.size >= 16) localChecks.delete(localChecks.keys().next().value!); found = new Validator(async () => listChatModels(`${endpoint}/models`, key ? {authorization: `Bearer ${key}`} : {}, label, request, 1500), 60_000); localChecks.set(bindingId, found); } return found; };
  const hasOmniRoute = () => existsSync(env().OMNIROUTE_HOME || join(home, '.omniroute')) || Object.keys(env()).some(name => name.startsWith('OMNIROUTE_'));
  const codexEndpoints = options.codexEndpoints ?? (() => { try { return configuredProviderInstances({env: env(), home}).map(row => row.info.endpoint ?? '').filter(Boolean); } catch { return []; } });
  const origin = (url: string) => { try { const parsed = new URL(url); return `${parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname}:${parsed.port}`; } catch { return url; } };
  const localProbes = options.localProbes ?? !process.env.NODE_TEST_CONTEXT;
  const cliAgents = options.cliAgents ?? !process.env.NODE_TEST_CONTEXT;
  const agentSpawn = options.spawn as AgentSpawn | undefined;
  const cursorCheck = new Validator(() => cursorCapabilities(cliAgent('cursor-agent')!.detect(env(), home)!, {spawn: agentSpawn, env: env()}));
  const geminiCheck = new Validator(() => geminiCapabilities(cliAgent('gemini-cli')!.detect(env(), home)!, {spawn: agentSpawn, env: env(), home}));
  const grokCheck = new Validator(() => grokCapabilities(cliAgent('grok-cli')!.detect(env(), home)!, {spawn: agentSpawn, env: env()}));
  const validators = (): Array<Validator<unknown>> => [claudeCheck, openCodeCheck, ...(cliAgents ? [cursorCheck, geminiCheck, grokCheck] : []), openAICheck, anthropicCheck, ...envChecks.values(), ...localChecks.values()] as Array<Validator<unknown>>;

  const route = (info: ProviderInfo, run?: RunnableAdapter): ProviderInstance => ({info, command: '', env: {}, sessionsRoot: '', ...(run ? {adapter: run} : {})});
  /** Pending and failed checks stay visible but unavailable; nothing falls back to another provider. */
  const gate = <T>(base: ProviderInfo, check: Validation<T>, ready: (value: T) => {models: ProviderInfo['models']; detail: string}, run: () => RunnableAdapter): ProviderInstance => {
    if (check.status === 'ok') { const {models, detail} = ready(check.value!); if (models.length) return route({...base, models, available: true, status: 'ready', detail}, run()); return route({...base, status: 'error', error: 'No usable chat models were reported.', detail: 'No usable chat models were reported. No provider fallback will be used.'}); }
    if (check.status === 'error') return route({...base, status: 'error', error: check.reason, detail: `${check.reason} No provider fallback will be used.`});
    return route({...base, status: 'configured', detail: 'Checking this provider… Scan again in a moment.'});
  };

  /** The version check, held back to "not signed in" (or "checking") until the sign-in check passes. */
  const claudeReady = (claude: string): Validation<string> => {
    const version = claudeCheck.current(claude);
    if (version.status !== 'ok') return version;
    const auth = claudeAuth.current(`${claude}|${claudeAuthStamp({env: env(), home})}`);
    return auth.status === 'ok' ? version : auth.status === 'error' ? {status: 'error', reason: auth.reason!, checkedAt: auth.checkedAt!} : {status: 'pending'};
  };
  /** Anthropic's live model list, when ANTHROPIC_API_KEY is set (shares the env-anthropic check; the key is only hashed). */
  const liveAnthropic = () => { const key = env().ANTHROPIC_API_KEY; if (!key) return undefined; const check = anthropicCheck.current(hash('env-anthropic', hash(key))); return check.status === 'ok' ? check.value : undefined; };
  function instances(): ProviderInstance[] {
    const e = env(), rows: ProviderInstance[] = [];
    const claude = claudeBinary();
    if (claude) {
      const bindingId = hash('claude-code', claude);
      rows.push(gate({id: 'claude-code', name: 'Claude Code', driver: 'claude-code-cli', bindingId, identityMasked: 'Claude Code sign-in', models: [], available: false, source: claude},
        claudeReady(claude), version => ({models: claudeCodeModels({home, env: e, dataDir: providerDataDir(), live: liveAnthropic()}), detail: `Runs Claude Code ${version} in the chat folder with its own tools, settings and MCP servers. Read-only and Plan chats use plan mode.`}),
        () => adapter(`claude:${bindingId}`, () => claudeCodeAdapter({binary: claude, env: e, spawn: options.spawn}))));
    }
    const openCode = openCodeBinary();
    if (openCode) {
      const bindingId = hash('opencode', openCode);
      rows.push(gate({id: 'opencode', name: 'OpenCode', driver: 'opencode-cli', bindingId, identityMasked: 'OpenCode sign-in', models: [], available: false, source: openCode},
        openCodeCheck.current(openCode), value => ({models: value.models, detail: 'Runs OpenCode in the chat folder with its own tools and providers. Read-only chats use the plan agent.'}),
        () => adapter(`opencode:${bindingId}`, () => openCodeAdapter({binary: openCode, env: e, spawn: options.spawn}))));
    }
    if (cliAgents) {
      const meta = (id: string) => ({...cliAgent(id)!, binary: cliAgent(id)!.detect(e, home)});
      const cursor = meta('cursor-agent'), gemini = meta('gemini-cli'), grok = meta('grok-cli'), anti = meta('antigravity');
      const extra = (m: {installUrl: string; loginCommand: string}) => ({installUrl: m.installUrl, ...(m.loginCommand ? {loginCommand: m.loginCommand} : {})});
      if (cursor.binary) {
        const bindingId = hash('cursor-agent', cursor.binary), bin = cursor.binary;
        rows.push(gate({id: 'cursor-agent', name: cursor.name, driver: 'cursor-cli', bindingId, identityMasked: 'Cursor sign-in', models: [], available: false, source: bin, ...extra(cursor)},
          cursorCheck.current(`${bin}|${CURSOR_ENV.map(name => e[name] ? 1 : 0).join('')}`), value => ({models: value.models, detail: `Runs Cursor CLI ${value.version}${value.account ? ` (${value.account})` : ''} in the chat folder. Read-only chats use ask mode; Cursor decides approvals in print mode, so Muster's access level sets its force and sandbox flags.`}),
          () => adapter(`cursor:${bindingId}`, () => cursorAdapter({binary: bin, env: e, spawn: agentSpawn}))));
      }
      if (gemini.binary) {
        const bindingId = hash('gemini-cli', gemini.binary), bin = gemini.binary;
        rows.push(gate({id: 'gemini-cli', name: gemini.name, driver: 'gemini-cli', bindingId, identityMasked: 'Gemini sign-in', models: [], available: false, source: bin, ...extra(gemini)},
          geminiCheck.current(`${bin}|${geminiSignIn(e, home) ?? ''}`), value => ({models: value.models, detail: `Runs Gemini CLI ${value.version} (${value.account}) headless in the chat folder. Read-only uses plan mode, workspace auto-approves edits only, full access approves everything.`}),
          () => adapter(`gemini:${bindingId}`, () => geminiAdapter({binary: bin, flags: () => { const found = geminiCheck.current(`${bin}|${geminiSignIn(e, home) ?? ''}`); return found.value?.flags ?? {plan: false, resume: false, approvalMode: true}; }, env: e, spawn: agentSpawn}))));
      }
      if (grok.binary) {
        const bindingId = hash('grok-cli', grok.binary), bin = grok.binary;
        rows.push(gate({id: 'grok-cli', name: grok.name, driver: 'grok-acp', bindingId, identityMasked: 'Grok sign-in', models: [], available: false, source: bin, ...extra(grok)},
          grokCheck.current(`${bin}|${e.XAI_API_KEY ? 1 : 0}`), value => ({models: value.models, detail: `Runs Grok Build ${value.version} over its Agent Client Protocol. Read-only allows reads and searches, workspace also edits, full access approves everything.`}),
          () => adapter(`grok:${bindingId}`, () => grokAdapter({binary: bin, env: e, spawn: agentSpawn}))));
      }
      // Seen but not drivable: shown with the reason, never offered in the model picker.
      if (anti.binary) rows.push(route({id: 'antigravity', name: anti.name, driver: 'antigravity', identityMasked: '', models: [], available: false, status: 'error', source: anti.binary, error: 'Not supported yet.', detail: `Not supported yet. ${anti.unsupportedReason}`, ...extra(anti)}));
    }
    if (e.OPENAI_API_KEY) {
      const base = openAIBase(), bindingId = hash('env-openai', base, hash(e.OPENAI_API_KEY));
      rows.push(gate({id: 'env-openai', name: 'OpenAI API key (environment)', driver: 'openai-chat-completions', bindingId, identityMasked: 'Key set in environment', models: [], available: false, source: 'env:OPENAI_API_KEY', endpoint: base},
        openAICheck.current(bindingId), models => ({models, detail: `${WITH_TOOLS}. Streams chat completions with OPENAI_API_KEY from Muster’s environment.`}),
        () => adapter(`openai:${bindingId}`, () => openAICompatibleAdapter({endpoint: base, apiKey: () => env().OPENAI_API_KEY, label: 'OpenAI', fetch: request, memory: memory('env-openai')}))));
    }
    if (e.ANTHROPIC_API_KEY) {
      const bindingId = hash('env-anthropic', hash(e.ANTHROPIC_API_KEY));
      rows.push(gate({id: 'env-anthropic', name: 'Anthropic API key (environment)', driver: 'anthropic-messages', bindingId, identityMasked: 'Key set in environment', models: [], available: false, source: 'env:ANTHROPIC_API_KEY'},
        anthropicCheck.current(bindingId), models => ({models, detail: `${CHAT_ONLY}. Streams the Messages API with ANTHROPIC_API_KEY from Muster’s environment.`}),
        () => adapter(`anthropic:${bindingId}`, () => anthropicAdapter({apiKey: () => env().ANTHROPIC_API_KEY, fetch: request, memory: memory('env-anthropic')}))));
    }
    for (const key of ENV_KEY_PROVIDERS) {
      if (key.kind !== 'openai-compatible' || !e[key.env]) continue;
      const base = endpointFor(key), bindingId = hash(key.id, base, hash(e[key.env]));
      rows.push(gate({id: key.id, name: `${key.name} API key (environment)`, driver: 'openai-chat-completions', bindingId, identityMasked: 'Key set in environment', models: [], available: false, source: `env:${key.env}`, endpoint: base},
        envChecks.get(key.id)!.current(bindingId), models => ({models, detail: `${WITH_TOOLS}. Streams chat completions with ${key.env} from Muster’s environment.`}),
        () => adapter(`${key.id}:${bindingId}`, () => openAICompatibleAdapter({endpoint: base, apiKey: () => env()[key.env], label: key.name, fetch: request, memory: memory(key.id)}))));
    }
    if (localProbes) {
      const taken = new Set(codexEndpoints().map(origin));
      for (const server of localServers(e, home, hasOmniRoute())) {
        if (taken.has(origin(server.endpoint))) continue;
        const key = server.keyEnv ? e[server.keyEnv] : undefined, bindingId = hash(server.id, server.endpoint, key ? hash(key) : '');
        const check = localCheck(bindingId, server.name, server.endpoint, key).current(bindingId);
        // Not running (or nothing loaded): not offered, and no error row for software the user may not have.
        if (check.status !== 'ok' || !check.value?.length) continue;
        rows.push(route({id: server.id, name: server.name, driver: 'openai-chat-completions', bindingId, identityMasked: 'Local server', models: check.value, available: true, status: 'ready', source: server.endpoint, endpoint: server.endpoint,
          detail: `${WITH_TOOLS}. Local OpenAI-compatible server; models from its own /models list.`},
          adapter(`${server.id}:${bindingId}`, () => openAICompatibleAdapter({endpoint: server.endpoint, apiKey: () => server.keyEnv ? env()[server.keyEnv] : undefined, label: server.name, fetch: request, memory: memory(server.id)}))));
      }
    }
    const store = options.customs ? undefined : activeCustomProviders();
    store?.claim();
    for (const connection of options.customs?.() ?? store?.connections() ?? []) {
      // The key is resolved per request exactly as the connection check resolves it: the key pasted in Muster
      // (Keychain) first, then the connection's environment variable. Reading only the variable sent no
      // Authorization header for a pasted key, so every chat failed with 401 (#207).
      if (!customRunnable(connection, e)) continue;
      const bindingId = hash(connection.id, connection.endpoint, connection.apiKeyEnv);
      rows.push(route({id: connection.id, name: connection.name, driver: 'openai-chat-completions', bindingId, custom: true, endpoint: connection.endpoint, apiKeyEnv: connection.apiKeyEnv || undefined, ...(connection.checkedAt ? {checkedAt: connection.checkedAt} : {}),
        identityMasked: 'No account metadata', canReveal: false, source: 'Added in Muster', models: connection.models, available: true, status: 'ready', detail: `${CUSTOM_CHAT_ONLY}. OpenAI-compatible chat completions; model discovery succeeded.`},
        adapter(`custom:${bindingId}`, () => openAICompatibleAdapter({endpoint: connection.endpoint, apiKey: () => resolveCustomKey(connection, env()), label: connection.name, fetch: request, memory: memory(connection.id)}))));
    }
    // #319: a chat-only route (Anthropic Messages) or a model whose endpoint rejected tool definitions is marked per model, so the
    // composer can say "This model can't run commands or edit files" before the user sends.
    return rows.map(row => {
      const info = row.info, endpoint = info.endpoint;
      const chatOnly = info.driver === 'anthropic-messages';
      const refused = info.driver === 'openai-chat-completions' && !!endpoint && info.models.some(model => refusedTools(endpoint, model.id));
      if (!chatOnly && !refused) return row;
      return {...row, info: {...info, models: info.models.map(model => chatOnly || (endpoint && refusedTools(endpoint, model.id)) ? {...model, tools: false} : model)}};
    });
  }
  // The sign-in check starts only once the version check passed, so settle twice.
  return {instances, async ready() { instances(); await Promise.all(validators().map(check => check.settled())); instances(); await claudeAuth.settled(); }};
}
