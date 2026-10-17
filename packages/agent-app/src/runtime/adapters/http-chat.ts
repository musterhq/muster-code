import {randomUUID} from 'node:crypto';
import {ConversationMemory, loadImages, responseError, sseEvents, type ChatMessage} from './shared.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';
import {HISTORY_WINDOW_EVENT, TOOLS_UNAVAILABLE_EVENT} from '../context-budget.ts';
import {browserOffered, executeTool, toolInstructions, toolSpecs, type ToolCall} from './http-tools.ts';

export const CHAT_ONLY = 'Chat only · no tools';
export const WITH_TOOLS = 'Shell and file tools';
type Fetch = typeof fetch;
interface HttpOptions {endpoint: string; apiKey: () => string | undefined; label: string; fetch?: Fetch; memory?: ConversationMemory}

const MAX_TOOL_ROUNDS = 400, MAX_CALLS_PER_ROUND = 16, MAX_CALLS_PER_TURN = 1000, MAX_PENDING_CALLS = 64;
const MAX_ARGUMENT_BYTES_PER_STREAM = 4 * 1024 * 1024, MAX_EXTRA_BYTES = 2 * 1024 * 1024, TURN_DEADLINE_MS = 2 * 60 * 60_000, REFUSAL_TTL_MS = 30 * 60_000;
/** A 400/422 counts as "this model takes no tool definitions" only when its body says so (not for a context overflow or a bad image). */
export const refusesTools = (body: string) => /\b(?:tools?|functions?|tool_choice|tool[ _-]?calls?)\b/i.test(body) && /(?:not|n't|no longer|unsupported|unknown|invalid|does not|doesn't)/i.test(body);
interface Streamed { usage?: Record<string, unknown>; calls?: ToolCall[] }
/** Models that refused tool definitions this process, by endpoint and model, so the picker and composer can say so. */
const toolRefusals = new Map<string, number>();
export const refusedTools = (endpoint: string, model: string) => { const at = toolRefusals.get(`${endpoint}\0${model}`); if (at === undefined) return false; if (Date.now() - at > REFUSAL_TTL_MS) { toolRefusals.delete(`${endpoint}\0${model}`); return false; } return true; };

/** What is stored and re-sent every round of a call's arguments: at most 64 KB, still valid JSON, with a note when cut. The call itself runs with the full arguments. */
export const MAX_RESENT_ARGUMENT = 64 * 1024;
export const resent = (args: string): string => !args ? '{}' : args.length <= MAX_RESENT_ARGUMENT ? args : JSON.stringify({note: `[arguments of ${args.length} characters omitted from the history to save space (kept: ${MAX_RESENT_ARGUMENT >> 10} KB per call); the call itself ran with them in full]`});

/** Shared turn skeleton: history, identity callbacks, abort, result mapping and (for routes that offer tools) the tool loop. */
async function turn(input: AdapterRunInput, ...rest: [ConversationMemory, string, Parameters<typeof turnBody>[3], Parameters<typeof turnBody>[4], {endpoint: string}?]): Promise<AdapterRunResult> {
  // Offered before the first request goes out, so a message sent right after Send is not lost; closed when the turn settles.
  const lane = {steers: [] as string[], open: true};
  input.onSteerable?.(text => { if (!lane.open || input.signal.aborted) return false; lane.steers.push(text); return true; });
  try { return await turnBody(input, rest[0], rest[1], rest[2], rest[3], rest[4], lane); } finally { lane.open = false; }
}
async function turnBody(input: AdapterRunInput, memory: ConversationMemory, label: string, send: (history: ChatMessage[], extra: unknown[], tools: boolean) => Promise<Response>, stream: (response: Response, emit: (text: string) => void) => Promise<Streamed | undefined>, tooling: {endpoint: string} | undefined, lane: {steers: string[]; open: boolean}): Promise<AdapterRunResult> {
  const {threadId, history} = memory.open(input.resumeThreadId);
  input.onThreadReady(threadId);
  const fail = (message: string, extra: Partial<AdapterRunResult> = {}): AdapterRunResult => ({status: 'failed', finalMessage: '', threadId, dispatchState: 'not-dispatched', errorMessage: message, ...extra});
  let toolsOn = !!tooling && !refusedTools(tooling.endpoint, input.model);
  let response: Response;
  const first = async (): Promise<Response> => send(history, [], toolsOn);
  try { response = await first(); }
  catch (error) {
    if (input.signal.aborted) return fail('Stopped before the request was sent.');
    return fail(`Could not reach ${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'network error'}.`);
  }
  if (!response.ok && toolsOn && (response.status === 400 || response.status === 422)) {
    const text = await response.clone().text().catch(() => '');
    if (refusesTools(text.slice(0, 4000))) {
      // The route (or model) does not accept tool definitions: run this turn as plain chat and remember it for a while.
      await response.body?.cancel().catch(() => {});
      toolsOn = false; toolRefusals.set(`${tooling!.endpoint}\0${input.model}`, Date.now());
      input.onEvent(TOOLS_UNAVAILABLE_EVENT, {threadId, model: input.model});
      try { response = await first(); }
      catch (error) { return fail(`Could not reach ${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'network error'}.`); }
    }
  }
  if (!response.ok) return fail(await responseError(response, label), {statusCode: response.status});
  if (!response.body) return {status: 'failed', finalMessage: '', threadId, dispatchState: 'dispatched', errorMessage: `${label} returned an empty stream.`};
  const turnId = randomUUID();
  input.onTurnAccepted({threadId, turnId});
  let answer = '';
  const extra: Array<{role: string; content?: string | unknown[] | null; tool_calls?: unknown; tool_call_id?: string}> = [];
  const pictures = new Set<object>();
  const visionNote = {told: false};
  const usages: Array<{inputTokens?: number; outputTokens?: number; totalTokens?: number}> = [];
  const deadline = Date.now() + TURN_DEADLINE_MS;
  const used: string[] = [];
  let callsThisTurn = 0;
  /** The model re-reads `extra` every round: keep it under a total size by blanking the oldest tool results. */
  const trimExtra = () => {
    const length = (message: {content?: string | unknown[] | null}) => typeof message.content === 'string' ? message.content.length : 0;
    let size = extra.reduce((sum, message) => sum + length(message), 0);
    for (const message of extra) { if (size <= MAX_EXTRA_BYTES) break; if (message.role === 'tool' && length(message) > 200) { size -= length(message); message.content = '[earlier tool output omitted to save space]'; size += message.content.length; } }
  };
  /** At a cap: one last streamed request with no tools asking for a short status. If that fails, the plain note. */
  const closingStatus = async () => {
    const note = '\n\n(Stopped: this turn reached its limit on tool calls or time.)';
    let got = '';
    try {
      if (input.signal.aborted) throw new Error('aborted');
      extra.push({role: 'user', content: 'This turn has reached its limit on tool calls or time, so no more tools are available. In 2-3 sentences, say what is done and what is next. Do not call tools.'});
      const last = await send(history, extra, false);
      if (!last.ok || !last.body) throw new Error('status request failed');
      const lead = '\n\n';
      const streamed = await stream(last, delta => { if (!got) { answer += lead; input.onDelta(lead); } got += delta; answer += delta; input.onDelta(delta); });
      if (streamed?.usage) usages.push(streamed.usage as {inputTokens?: number; outputTokens?: number; totalTokens?: number});
      if (!got.trim()) throw new Error('empty status');
    } catch {
      if (!got) { answer += note; input.onDelta(note); }
    }
  };
  // Steers (a message sent while this turn runs) join the conversation before the next request: this loop owns its rounds.
  const steers = lane.steers, injected: ChatMessage[] = [];
  let mark = 0;
  const takeSteers = (): boolean => {
    if (!steers.length) return false;
    const segment = answer.slice(mark); mark = answer.length;
    if (segment.trim()) injected.push({role: 'assistant', content: segment});
    for (const text of steers.splice(0)) { extra.push({role: 'user', content: text}); injected.push({role: 'user', content: text}); }
    return true;
  };
  /** What the next turn remembers: the prompt, each steer in order with the reply before it, then the rest of the answer. */
  const remember = (tail: string): ChatMessage[] => [...history, {role: 'user', content: input.prompt}, ...injected, ...(tail.trim() || !injected.length ? [{role: 'assistant' as const, content: tail}] : [])];
  try {
    for (let round = 0, roundStart = 0; ; round++, roundStart = answer.length) {
      const streamed = await stream(response, delta => { answer += delta; input.onDelta(delta); });
      if (streamed?.usage) usages.push(streamed.usage as {inputTokens?: number; outputTokens?: number; totalTokens?: number});
      let calls = streamed?.calls ?? [];
      if (input.signal.aborted) break;
      if (!toolsOn || !calls.length) {
        // A steer that arrived during the last stream gets one more round, after the reply it interrupted.
        if (!steers.length || round >= MAX_TOOL_ROUNDS) break;
        extra.push({role: 'assistant', content: answer.slice(roundStart) || '(no reply)'});
        takeSteers();
        response = await send(history, extra, toolsOn);
        if (!response.ok || !response.body) throw new Error(response.ok ? `${label} returned an empty stream.` : await responseError(response, label));
        continue;
      }
      if (round >= MAX_TOOL_ROUNDS || callsThisTurn >= MAX_CALLS_PER_TURN || Date.now() > deadline) { await closingStatus(); break; }
      calls = calls.slice(0, Math.min(MAX_CALLS_PER_ROUND, MAX_CALLS_PER_TURN - callsThisTurn));
      callsThisTurn += calls.length;
      extra.push({role: 'assistant', content: null, tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: resent(call.arguments)}}))});
      // Pictures are re-sent every round, so only the latest ones stay; earlier ones become a one-line note.
      for (const message of extra) if (pictures.delete(message)) message.content = '[an earlier image was shown here and has been omitted to save space]';
      const seen: Array<{role: string; content: unknown[]}> = [];
      for (const call of calls) {
        const result = await executeTool(call, {chatId: input.chat.id, ...(browserOffered(input.browserTools) ? {browser: true} : {}), cwd: input.cwd, access: input.permissionMode, ...(input.vision ? {vision: true} : {}), visionNote, signal: input.signal, emit: input.onEvent, threadId, turnId, ...(input.authorize ? {authorize: input.authorize} : {}), ...(input.askUser ? {askUser: input.askUser} : {}), ...(input.env ? {env: input.env} : {}), deadline});
        used.push(`${call.name}${result.ok ? '' : ' (failed)'}`);
        extra.push({role: 'tool', tool_call_id: call.id, content: result.content});
        // A tool message cannot carry a picture: it follows as a user message once every tool reply of this round is in.
        if (result.image) seen.push({role: 'user', content: [{type: 'text', text: `Image returned by ${call.name} (${result.image.name}):`}, {type: 'image_url', image_url: {url: `data:${result.image.mediaType};base64,${result.image.data}`}}]});
      }
      for (const message of seen) pictures.add(message);
      extra.push(...seen);
      trimExtra();
      takeSteers();
      if (input.signal.aborted) break;
      response = await send(history, extra, true);
      if (!response.ok || !response.body) throw new Error(response.ok ? `${label} returned an empty stream.` : await responseError(response, label));
    }
    lane.open = false;
    if (usages.length === 1) input.onEvent('thread/tokenUsage/updated', {threadId, turnId, tokenUsage: {last: usages[0]}});
    else if (usages.length > 1) {
      // Each round re-sends the conversation: the last input size is the context in use, the outputs add up.
      const last = usages.at(-1)!, outputTokens = usages.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0);
      input.onEvent('thread/tokenUsage/updated', {threadId, turnId, tokenUsage: {last: {inputTokens: last.inputTokens ?? 0, outputTokens, totalTokens: (last.inputTokens ?? 0) + outputTokens}}});
    }
  } catch (error) {
    lane.open = false;
    const stopped = input.signal.aborted;
    if (answer || used.length) memory.commit(threadId, remember(`${answer.slice(mark)}${used.length ? `\n\n[Tools used before this stopped: ${used.slice(0, 40).join(', ')}]` : ''}`));
    return {status: 'failed', finalMessage: '', threadId, turnId, dispatchState: 'dispatched', errorMessage: stopped ? 'Stopped.' : error instanceof Error ? error.message.slice(0, 300) : `${label} stream failed.`};
  }
  const tail = answer.slice(mark), remembered = used.length ? `${tail}\n\n[Tools used this turn: ${used.slice(0, 40).join(', ')}]` : tail;
  const retained = memory.commit(threadId, remember(remembered));
  // Muster trims this history (80 messages / 400k chars): say how many user turns survive, so static context
  // carried by a trimmed-out turn is sent again (service.ts → ContextLedger).
  input.onEvent(HISTORY_WINDOW_EVENT, {threadId, turnId, retainedUserTurns: retained.retainedUserTurns, trimmed: retained.trimmed});
  return {status: 'completed', finalMessage: answer, threadId, turnId, dispatchState: 'dispatched'};
}

/** OpenAI-compatible `/chat/completions` streaming. Offers the shell and file tools the chat's access level allows (http-tools.ts);
 *  a route that rejects tool definitions falls back to plain chat for that model and says so. */
export function openAICompatibleAdapter(options: HttpOptions & {tools?: boolean}): RunnableAdapter {
  const memory = options.memory ?? new ConversationMemory();
  const request = options.fetch ?? fetch;
  return {kind: 'http', run: input => turn(input, memory, options.label, (history, extra, tools) => {
    const key = options.apiKey();
    const images = loadImages(input.images);
    const user = images.length ? [{type: 'text', text: input.prompt}, ...images.map(image => ({type: 'image_url', image_url: {url: `data:${image.mediaType};base64,${image.data}`}}))] : input.prompt;
    const browser = browserOffered(input.browserTools);
    const system = [input.instructions, tools ? toolInstructions(input.permissionMode, input.cwd, browser, !!input.askUser) : undefined].filter(Boolean).join('\n\n');
    const messages = [...(system ? [{role: 'system', content: system}] : []), ...history, {role: 'user', content: user}, ...extra];
    return request(`${options.endpoint}/chat/completions`, {method: 'POST', redirect: 'error', signal: input.signal,
      headers: {'content-type': 'application/json', accept: 'text/event-stream', ...(key ? {authorization: `Bearer ${key}`} : {})},
      body: JSON.stringify({model: input.model, stream: true, stream_options: {include_usage: true}, messages, ...(tools ? {tools: toolSpecs(input.permissionMode, browser, !!input.askUser), tool_choice: 'auto'} : {})})});
  }, async (response, emit) => {
    let usage: Record<string, unknown> | undefined;
    const pending = new Map<number, ToolCall>();
    let argumentBytes = 0;
    for await (const {data} of sseEvents(response.body!)) {
      if (data === '[DONE]') break;
      let chunk: {choices?: Array<{delta?: {content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{index?: number; id?: string; function?: {name?: string; arguments?: string}}>}}>; usage?: {prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown}; error?: {message?: unknown}};
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`${options.label} error: ${typeof chunk.error.message === 'string' ? chunk.error.message.slice(0, 300) : 'stream failed'}`);
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content) emit(delta.content);
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoning === 'string' && reasoning) input.onReasoning(reasoning);
      for (const piece of delta?.tool_calls ?? []) {
        const index = typeof piece.index === 'number' ? piece.index : 0;
        const call = pending.get(index) ?? {id: '', name: '', arguments: ''};
        if (piece.id) call.id = piece.id;
        if (piece.function?.name) call.name += piece.function.name;
        if (piece.function?.arguments) call.arguments += piece.function.arguments;
        argumentBytes += (piece.function?.arguments?.length ?? 0) + (piece.function?.name?.length ?? 0);
        if (call.arguments.length > 1024 * 1024 || argumentBytes > MAX_ARGUMENT_BYTES_PER_STREAM || (!pending.has(index) && pending.size >= MAX_PENDING_CALLS)) throw new Error(`${options.label} sent too many or oversized tool calls.`);
        pending.set(index, call);
      }
      if (chunk.usage) usage = {inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens};
    }
    const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, call], position) => ({...call, id: call.id || `call_${position}_${randomUUID().slice(0, 8)}`})).filter(call => call.name);
    return {usage, calls};
  }, options.tools === false ? undefined : {endpoint: options.endpoint})};
}

export const ANTHROPIC_API = 'https://api.anthropic.com/v1';
/** Anthropic Messages API streaming. Text only: no tools are offered to the model (the composer says so before sending). */
export function anthropicAdapter(options: Omit<HttpOptions, 'endpoint' | 'label'> & {endpoint?: string; label?: string}): RunnableAdapter {
  const memory = options.memory ?? new ConversationMemory();
  const request = options.fetch ?? fetch, endpoint = options.endpoint ?? ANTHROPIC_API, label = options.label ?? 'Anthropic';
  return {kind: 'http', run: input => turn(input, memory, label, (history, extra) => {
    const images = loadImages(input.images);
    const user = images.length ? [...images.map(image => ({type: 'image', source: {type: 'base64', media_type: image.mediaType, data: image.data}})), {type: 'text', text: input.prompt}] : input.prompt;
    return request(`${endpoint}/messages`, {method: 'POST', redirect: 'error', signal: input.signal,
      headers: {'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': options.apiKey() ?? '', 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({model: input.model, max_tokens: 16_000, stream: true, ...(input.instructions ? {system: input.instructions} : {}), messages: [...history, {role: 'user', content: user}, ...extra]})});
  }, async (response, emit) => {
    let input_tokens: unknown, output_tokens: unknown;
    for await (const {event, data} of sseEvents(response.body!)) {
      let payload: {type?: string; delta?: {type?: string; text?: unknown; thinking?: unknown}; message?: {usage?: {input_tokens?: unknown; output_tokens?: unknown}}; usage?: {output_tokens?: unknown}; error?: {message?: unknown}};
      try { payload = JSON.parse(data); } catch { continue; }
      const type = payload.type ?? event;
      if (type === 'error') throw new Error(`${label} error: ${typeof payload.error?.message === 'string' ? payload.error.message.slice(0, 300) : 'stream failed'}`);
      if (type === 'message_start') { input_tokens = payload.message?.usage?.input_tokens; output_tokens = payload.message?.usage?.output_tokens; }
      if (type === 'content_block_delta' && payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') emit(payload.delta.text);
      if (type === 'content_block_delta' && payload.delta?.type === 'thinking_delta' && typeof payload.delta.thinking === 'string') input.onReasoning(payload.delta.thinking);
      if (type === 'message_delta' && payload.usage?.output_tokens !== undefined) output_tokens = payload.usage.output_tokens;
      if (type === 'message_stop') break;
    }
    return typeof input_tokens === 'number' ? {usage: {inputTokens: input_tokens, outputTokens: typeof output_tokens === 'number' ? output_tokens : 0}} : undefined;
  })};
}

/** GET a JSON model list with a timeout and a 1 MiB cap. */
/** One `/models` entry. `owner` is the router's `owned_by` (a router's own agents and combos report "combo");
 *  `chat` is false for image, audio, video and moderation models, which a chat cannot run. */
/** Whether a `/models` or catalog entry says the model takes images: `input_modalities` (or `modalities.input`, `architecture.input_modalities`)
 *  naming "image", or `capabilities.vision` / `capabilities.image_input`. Undefined when the entry does not say. */
export function entryAcceptsImages(entry: Record<string, unknown>): boolean | undefined {
  const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const capabilities = object(entry.capabilities);
  const lists = [entry.input_modalities, entry.inputModalities, object(entry.modalities).input, object(entry.architecture).input_modalities, capabilities.input_modalities];
  const listed = lists.find(Array.isArray) as unknown[] | undefined;
  if (listed) return listed.some(item => typeof item === 'string' && item.toLowerCase() === 'image');
  for (const flag of [capabilities.vision, capabilities.image_input, capabilities.images, entry.vision, entry.supports_vision]) if (typeof flag === 'boolean') return flag;
  return undefined;
}
export interface ListedModel { id: string; name: string; /** #426: a window from this listing (`context_length`), not a catalog. */ contextWindowSource?: 'listing'; owner?: string; chat?: boolean; /** The router reports image input (vision) for this model. */ images?: boolean; /** The router's own context size (`context_length`, `max_input_tokens`…), used as the window when the provider reports none. */ contextWindow?: number }
/** A positive integer context size from a `/models` entry; routers name it differently. */
export function listedContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const key of ['context_length', 'max_input_tokens', 'context_window', 'contextWindow', 'max_context_length', 'input_token_limit']) { const value = entry[key]; if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 50_000_000) return value; }
  return undefined;
}
export async function fetchModelList(url: string, headers: Record<string, string>, label: string, request: Fetch = fetch, timeoutMs = 8000): Promise<ListedModel[]> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try { response = await request(url, {redirect: 'error', signal: controller.signal, headers}); }
    catch { throw new Error(`Could not reach ${label} to list models.`); }
    if (!response.ok) throw new Error(await responseError(response, label));
    const reader = response.body?.getReader(), decoder = new TextDecoder(); let raw = '';
    if (reader) try { for (;;) { const {done, value} = await reader.read(); if (done) break; raw += decoder.decode(value, {stream: true}); if (raw.length > 8 * 1024 * 1024) throw new Error(`${label} model list is too large.`); } } finally { await reader.cancel().catch(() => {}); }
    let data: unknown; try { data = JSON.parse(raw); } catch { throw new Error(`${label} did not return a model list.`); }
    const items = (data as {data?: unknown}).data;
    if (!Array.isArray(items)) throw new Error(`${label} did not return a model list.`);
    return items.slice(0, 5000).flatMap(item => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const id = entry.id, name = entry.display_name;
      if (typeof id !== 'string' || id.length > 200 || /[\x00-\x1f]/.test(id)) return [];
      const output = Array.isArray(entry.output_modalities) ? entry.output_modalities : undefined;
      const tools = entry.capabilities && typeof entry.capabilities === 'object' ? (entry.capabilities as {tool_calling?: unknown}).tool_calling : undefined;
      const chat = !(typeof entry.type === 'string' && entry.type !== 'model') && !(output && !output.includes('text')) && tools !== false;
      const contextWindow = listedContextWindow(entry), images = entryAcceptsImages(entry);
      return [{id, name: typeof name === 'string' && name.length <= 160 ? name.replace(/[\x00-\x1f]/g, '') : id, ...(typeof entry.owned_by === 'string' ? {owner: entry.owned_by.slice(0, 64)} : {}), chat, ...(images !== undefined ? {images} : {}), ...(contextWindow ? {contextWindow, contextWindowSource: 'listing' as const} : {})}];
    });
  } finally { clearTimeout(timer); }
}

/** The chat-capable models of a `/models` listing, as the picker shows them (id and name only). */
export async function listChatModels(...args: Parameters<typeof fetchModelList>): Promise<Array<{id: string; name: string}>> {
  return (await fetchModelList(...args)).filter(model => model.chat !== false).map(({id, name}) => ({id, name}));
}
