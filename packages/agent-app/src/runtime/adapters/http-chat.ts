import {randomUUID} from 'node:crypto';
import {ConversationMemory, loadImages, responseError, sseEvents, type ChatMessage} from './shared.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';
import {HISTORY_WINDOW_EVENT} from '../context-budget.ts';

export const CHAT_ONLY = 'Chat only · no tools';
type Fetch = typeof fetch;
interface HttpOptions {endpoint: string; apiKey: () => string | undefined; label: string; fetch?: Fetch; memory?: ConversationMemory}

/** Shared turn skeleton: history, identity callbacks, abort, and result mapping. */
async function turn(input: AdapterRunInput, memory: ConversationMemory, label: string, send: (history: ChatMessage[]) => Promise<Response>, stream: (response: Response, emit: (text: string) => void) => Promise<Record<string, unknown> | undefined>): Promise<AdapterRunResult> {
  const {threadId, history} = memory.open(input.resumeThreadId);
  input.onThreadReady(threadId);
  let response: Response;
  try { response = await send(history); }
  catch (error) {
    if (input.signal.aborted) return {status: 'failed', finalMessage: '', threadId, dispatchState: 'not-dispatched', errorMessage: 'Stopped before the request was sent.'};
    return {status: 'failed', finalMessage: '', threadId, dispatchState: 'not-dispatched', errorMessage: `Could not reach ${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'network error'}.`};
  }
  if (!response.ok) return {status: 'failed', finalMessage: '', threadId, dispatchState: 'not-dispatched', statusCode: response.status, errorMessage: await responseError(response, label)};
  if (!response.body) return {status: 'failed', finalMessage: '', threadId, dispatchState: 'dispatched', errorMessage: `${label} returned an empty stream.`};
  const turnId = randomUUID();
  input.onTurnAccepted({threadId, turnId});
  let answer = '';
  try {
    const usage = await stream(response, delta => { answer += delta; input.onDelta(delta); });
    if (usage) input.onEvent('thread/tokenUsage/updated', {threadId, turnId, tokenUsage: {last: usage}});
  } catch (error) {
    const stopped = input.signal.aborted;
    if (answer) memory.commit(threadId, [...history, {role: 'user', content: input.prompt}, {role: 'assistant', content: answer}]);
    return {status: 'failed', finalMessage: '', threadId, turnId, dispatchState: 'dispatched', errorMessage: stopped ? 'Stopped.' : error instanceof Error ? error.message.slice(0, 300) : `${label} stream failed.`};
  }
  const retained = memory.commit(threadId, [...history, {role: 'user', content: input.prompt}, {role: 'assistant', content: answer}]);
  // Muster trims this history (80 messages / 400k chars): say how many user turns survive, so static context
  // carried by a trimmed-out turn is sent again (service.ts → ContextLedger).
  input.onEvent(HISTORY_WINDOW_EVENT, {threadId, turnId, retainedUserTurns: retained.retainedUserTurns, trimmed: retained.trimmed});
  return {status: 'completed', finalMessage: answer, threadId, turnId, dispatchState: 'dispatched'};
}

/** OpenAI-compatible `/chat/completions` streaming. Text only: no tools are offered to the model. */
export function openAICompatibleAdapter(options: HttpOptions): RunnableAdapter {
  const memory = options.memory ?? new ConversationMemory();
  const request = options.fetch ?? fetch;
  return {kind: 'http', run: input => turn(input, memory, options.label, history => {
    const key = options.apiKey();
    const images = loadImages(input.images);
    const user = images.length ? [{type: 'text', text: input.prompt}, ...images.map(image => ({type: 'image_url', image_url: {url: `data:${image.mediaType};base64,${image.data}`}}))] : input.prompt;
    const messages = [...(input.instructions ? [{role: 'system', content: input.instructions}] : []), ...history, {role: 'user', content: user}];
    return request(`${options.endpoint}/chat/completions`, {method: 'POST', redirect: 'error', signal: input.signal,
      headers: {'content-type': 'application/json', accept: 'text/event-stream', ...(key ? {authorization: `Bearer ${key}`} : {})},
      body: JSON.stringify({model: input.model, stream: true, stream_options: {include_usage: true}, messages})});
  }, async (response, emit) => {
    let usage: Record<string, unknown> | undefined;
    for await (const {data} of sseEvents(response.body!)) {
      if (data === '[DONE]') break;
      let chunk: {choices?: Array<{delta?: {content?: unknown; reasoning_content?: unknown; reasoning?: unknown}}>; usage?: {prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown}; error?: {message?: unknown}};
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`${options.label} error: ${typeof chunk.error.message === 'string' ? chunk.error.message.slice(0, 300) : 'stream failed'}`);
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content) emit(delta.content);
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoning === 'string' && reasoning) input.onReasoning(reasoning);
      if (chunk.usage) usage = {inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens};
    }
    return usage;
  })};
}

export const ANTHROPIC_API = 'https://api.anthropic.com/v1';
/** Anthropic Messages API streaming. Text only: no tools are offered to the model. */
export function anthropicAdapter(options: Omit<HttpOptions, 'endpoint' | 'label'> & {endpoint?: string; label?: string}): RunnableAdapter {
  const memory = options.memory ?? new ConversationMemory();
  const request = options.fetch ?? fetch, endpoint = options.endpoint ?? ANTHROPIC_API, label = options.label ?? 'Anthropic';
  return {kind: 'http', run: input => turn(input, memory, label, history => {
    const images = loadImages(input.images);
    const user = images.length ? [...images.map(image => ({type: 'image', source: {type: 'base64', media_type: image.mediaType, data: image.data}})), {type: 'text', text: input.prompt}] : input.prompt;
    return request(`${endpoint}/messages`, {method: 'POST', redirect: 'error', signal: input.signal,
      headers: {'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': options.apiKey() ?? '', 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({model: input.model, max_tokens: 16_000, stream: true, ...(input.instructions ? {system: input.instructions} : {}), messages: [...history, {role: 'user', content: user}]})});
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
    return typeof input_tokens === 'number' ? {inputTokens: input_tokens, outputTokens: typeof output_tokens === 'number' ? output_tokens : 0} : undefined;
  })};
}

/** GET a JSON model list with a timeout and a 1 MiB cap. */
export async function fetchModelList(url: string, headers: Record<string, string>, label: string, request: Fetch = fetch, timeoutMs = 8000): Promise<Array<{id: string; name: string}>> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try { response = await request(url, {redirect: 'error', signal: controller.signal, headers}); }
    catch { throw new Error(`Could not reach ${label} to list models.`); }
    if (!response.ok) throw new Error(await responseError(response, label));
    const reader = response.body?.getReader(), decoder = new TextDecoder(); let raw = '';
    if (reader) try { for (;;) { const {done, value} = await reader.read(); if (done) break; raw += decoder.decode(value, {stream: true}); if (raw.length > 1024 * 1024) throw new Error(`${label} model list is too large.`); } } finally { await reader.cancel().catch(() => {}); }
    let data: unknown; try { data = JSON.parse(raw); } catch { throw new Error(`${label} did not return a model list.`); }
    const items = (data as {data?: unknown}).data;
    if (!Array.isArray(items)) throw new Error(`${label} did not return a model list.`);
    return items.slice(0, 500).flatMap(item => {
      const id = item && typeof item === 'object' ? (item as {id?: unknown}).id : undefined, name = (item as {display_name?: unknown})?.display_name;
      return typeof id === 'string' && id.length <= 200 && !/[\x00-\x1f]/.test(id) ? [{id, name: typeof name === 'string' && name.length <= 160 ? name.replace(/[\x00-\x1f]/g, '') : id}] : [];
    });
  } finally { clearTimeout(timer); }
}
