/**
 * #688: Claude models on a configured router, run over the router's Anthropic Messages API instead of the coding client.
 *
 * Anthropic checks the thinking blocks of the latest assistant message against what it sent: any change is a 400
 * ("thinking or redacted_thinking blocks in the latest assistant message cannot be modified"). The Responses path
 * through the coding client never returns those blocks to the client, so the router has to rebuild them, and that
 * rebuild can fail. Here every assistant content block (thinking with its signature, redacted thinking, text, tool
 * calls) is kept exactly as streamed and sent back unchanged on each later round and turn.
 */
import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {loadImages, responseError, retryAfterMs, sseEvents} from './shared.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';
import {HISTORY_WINDOW_EVENT} from '../context-budget.ts';
import {browserOffered, executeTool, toolInstructions, toolSpecs} from './http-tools.ts';

type Block = Record<string, unknown> & {type: string};
export interface ClaudeMessage {role: 'user' | 'assistant'; content: string | Block[]}

const MAX_TOOL_ROUNDS = 400, MAX_CALLS_PER_ROUND = 16, MAX_CALLS_PER_TURN = 1000, TURN_DEADLINE_MS = 2 * 60 * 60_000;
const MAX_TOOL_INPUT_BYTES = 1024 * 1024, MAX_BLOCKS_PER_REPLY = 256;
/** Output budget per request, and the thinking budget inside it, by reasoning effort. */
const BUDGETS = {low: 2_000, medium: 8_000, high: 16_000, xhigh: 32_000} as const;
/** The router's effort setting for each chat effort; never below `high` (see the request below). */
const OUTPUT_EFFORT = {low: 'high', medium: 'high', high: 'high', xhigh: 'xhigh'} as const;

/** Saved conversations keep whole content blocks, so signatures survive a restart. Bounded per thread like the text
 *  memory: the newest 80 messages and about 2 MB; a cut never splits a tool call from its result. */
export class ClaudeConversationMemory {
  private threads = new Map<string, ClaudeMessage[]>();
  constructor(private maxThreads = 64, private maxChars = 2_000_000, private dir: () => string | undefined = () => undefined) {}
  private file(threadId: string): string | undefined { const dir = this.dir(); return dir && /^[a-f0-9-]{36}$/.test(threadId) ? join(dir, `${threadId}.json`) : undefined; }
  open(threadId?: string): {threadId: string; history: ClaudeMessage[]; found: boolean} {
    let known = threadId ? this.threads.get(threadId) : undefined;
    const file = threadId && !known ? this.file(threadId) : undefined;
    if (file) try {
      if (statSync(file).size <= 2 * this.maxChars + 65536) {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) known = parsed.filter((m): m is ClaudeMessage => !!m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)));
      }
    } catch { known = undefined; }
    return known ? {threadId: threadId!, history: [...known], found: true} : {threadId: randomUUID(), history: [], found: false};
  }
  commit(threadId: string, messages: ClaudeMessage[]): {retainedUserTurns: number; trimmed: boolean} {
    const size = (m: ClaudeMessage) => typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
    const isPrompt = (m: ClaudeMessage) => m.role === 'user' && typeof m.content === 'string';
    let kept = messages.slice(-80).map(withoutImages);
    const sizes = kept.map(size);
    let from = 0, total = sizes.reduce((sum, n) => sum + n, 0);
    // The saved thread must start on a real user prompt (a tool result without its call, or an assistant message first, is a
    // 400 at Anthropic) and fit the limits: drop from the front one whole prompt at a time, then re-align to the next prompt.
    for (;;) {
      while (from < kept.length && !isPrompt(kept[from]!)) { total -= sizes[from]!; from++; }
      if (from >= kept.length || total <= this.maxChars) break;
      total -= sizes[from]!; from++;
    }
    kept = kept.slice(from);
    this.threads.delete(threadId); this.threads.set(threadId, kept);
    while (this.threads.size > this.maxThreads) this.threads.delete(this.threads.keys().next().value!);
    const file = this.file(threadId);
    if (file) try { mkdirSync(dirname(file), {recursive: true, mode: 0o700}); const temp = `${file}.tmp`; writeFileSync(temp, JSON.stringify(kept), {mode: 0o600}); renameSync(temp, file); } catch { /* the memory copy still serves this session */ }
    const prompts = kept.filter(m => m.role === 'user' && typeof m.content === 'string').length;
    return {retainedUserTurns: prompts, trimmed: kept.length < messages.length};
  }
}

interface Options {
  /** Router base URL, e.g. https://router.example/v1 ( /messages is appended). */
  endpoint: string;
  /** Request headers carrying the route's own credentials (bearer token, its auth helper's token, extra headers). */
  headers: (force?: boolean) => Promise<Record<string, string>>;
  label: string;
  fetch?: typeof fetch;
  memory?: ClaudeConversationMemory;
}

interface Reply {blocks: Block[]; stop: string | undefined; usage: {inputTokens?: number; outputTokens?: number; cachedInputTokens?: number}}

/** Reads one streamed reply. Blocks are rebuilt exactly as Anthropic sent them: thinking text and signature, redacted
 *  data, text, and tool calls with their parsed input. Thinking and text are passed on as they arrive. */
async function readReply(response: Response, label: string, input: AdapterRunInput, emit: (text: string) => void): Promise<Reply> {
  const blocks: Block[] = [];
  const partial = new Map<number, string>();
  let stop: string | undefined;
  const usage: Reply['usage'] = {};
  for await (const {event, data} of sseEvents(response.body!)) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    const type = typeof payload.type === 'string' ? payload.type : event;
    if (type === 'error') {
      const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
      throw new Error(`${label} error: ${typeof error.message === 'string' ? error.message.slice(0, 300) : 'stream failed'}`);
    }
    if (type === 'message_start') {
      const message = payload.message && typeof payload.message === 'object' ? payload.message as Record<string, unknown> : {};
      const u = message.usage && typeof message.usage === 'object' ? message.usage as Record<string, unknown> : {};
      if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0) + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0);
      if (typeof u.cache_read_input_tokens === 'number') usage.cachedInputTokens = u.cache_read_input_tokens;
      continue;
    }
    const index = typeof payload.index === 'number' ? payload.index : -1;
    if (type === 'content_block_start' && index >= 0) {
      if (index >= MAX_BLOCKS_PER_REPLY) throw new Error(`${label} sent too many content blocks.`);
      const raw = payload.content_block;
      const start: Block = raw && typeof raw === 'object' && 'type' in raw && typeof raw.type === 'string' ? {...raw, type: raw.type} : {type: 'text', text: ''};
      if (start.type === 'tool_use') { start.input = {}; partial.set(index, ''); }
      blocks[index] = start;
      continue;
    }
    const block = index >= 0 ? blocks[index] : undefined;
    if (type === 'content_block_delta' && block) {
      const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta as Record<string, unknown> : {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') { block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`; emit(delta.text); }
      else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') { block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`; input.onReasoning(delta.thinking); }
      else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
      else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const json = (partial.get(index) ?? '') + delta.partial_json;
        if (json.length > MAX_TOOL_INPUT_BYTES) throw new Error(`${label} sent an oversized tool call.`);
        partial.set(index, json);
      }
      continue;
    }
    if (type === 'content_block_stop' && block?.type === 'tool_use') {
      const json = partial.get(index) ?? '';
      try { block.input = json ? JSON.parse(json) as unknown : {}; } catch { block.input = {}; }
      partial.delete(index);
      continue;
    }
    if (type === 'message_delta') {
      const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta as Record<string, unknown> : {};
      if (typeof delta.stop_reason === 'string') stop = delta.stop_reason;
      const u = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {};
      if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
      continue;
    }
    if (type === 'message_stop') break;
  }
  return {blocks: blocks.filter(Boolean), stop, usage};
}

/** The shell and file tools this chat's access level allows, in the Messages tool format. */
function messagesTools(access: AdapterRunInput['permissionMode'], browser: boolean) {
  return toolSpecs(access, browser).map(tool => ({name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters}));
}

export function claudeMessagesAdapter(options: Options): RunnableAdapter {
  const memory = options.memory ?? new ClaudeConversationMemory();
  const request = options.fetch ?? fetch, label = options.label;
  return {kind: 'http', async run(input): Promise<AdapterRunResult> {
    const lane = {steers: [] as string[], open: true};
    input.onSteerable?.(text => { if (!lane.open || input.signal.aborted) return false; lane.steers.push(text); return true; });
    const {threadId, history, found} = memory.open(input.resumeThreadId);
    // A saved conversation that is gone (data folder cleared, a first turn that never saved) must not drop the earlier messages silently.
    const seed = input.resumeThreadId && !found ? input.onThreadReset?.(input.resumeThreadId)?.trim() : undefined;
    const text = seed ? `${seed}\n\nCurrent user request:\n${input.prompt}` : input.prompt;
    input.onThreadReady(threadId);
    const browser = browserOffered(input.browserTools);
    const system = [input.instructions, toolInstructions(input.permissionMode, input.cwd, browser)].filter(Boolean).join('\n\n');
    const tools = messagesTools(input.permissionMode, browser);
    const budget = BUDGETS[input.reasoningEffort ?? 'medium'];
    const images = loadImages(input.images);
    const prompt: ClaudeMessage = {role: 'user', content: images.length ? [...images.map(image => ({type: 'image', source: {type: 'base64', media_type: image.mediaType, data: image.data}})), {type: 'text', text}] : text};
    // Images are sent once; the saved conversation keeps the prompt text only.
    const saved: ClaudeMessage[] = [...history, {role: 'user', content: text}];
    const live: ClaudeMessage[] = [...history, prompt];
    const post = async (force: boolean) => request(`${options.endpoint.replace(/\/+$/, '')}/messages`, {method: 'POST', redirect: 'error', signal: input.signal,
      headers: {...await options.headers(force), 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01'},
      // Measured on a live router (#688): with tools offered, Opus 5.5 often skips thinking unless the request names an
      // effort; `high` or above brings it back every time. Low and medium chats still ask for high so a tool turn thinks.
      body: JSON.stringify({model: input.model, max_tokens: budget + 8_000, stream: true, thinking: {type: 'enabled', budget_tokens: budget}, output_config: {effort: OUTPUT_EFFORT[input.reasoningEffort ?? 'medium']}, system, tools, messages: live})});
    // An expired helper token answers 401 before any output: fetch a fresh one and send the same request once more.
    const send = async () => {
      const response = await post(false);
      if (response.status !== 401) return response;
      await response.body?.cancel().catch(() => {});
      return post(true);
    };
    const fail = (message: string, extra: Partial<AdapterRunResult> = {}): AdapterRunResult => ({status: 'failed', finalMessage: '', threadId, dispatchState: 'not-dispatched', errorMessage: message, ...extra});
    let response: Response;
    try { response = await send(); }
    catch (error) { lane.open = false; return fail(input.signal.aborted ? 'Stopped before the request was sent.' : `Could not reach ${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'network error'}.`); }
    if (!response.ok) { lane.open = false; const wait = retryAfterMs(response.headers); return fail(await responseError(response, label), {statusCode: response.status, ...(wait !== undefined ? {retryAfterMs: wait} : {})}); }
    const turnId = randomUUID();
    input.onTurnAccepted({threadId, turnId});
    let answer = '', calls = 0, last: Reply['usage'] = {}, outputTokens = 0;
    const deadline = Date.now() + TURN_DEADLINE_MS;
    const add = (message: ClaudeMessage) => { live.push(message); saved.push(message); };
    try {
      for (let round = 0; ; round++) {
        if (!response.body) throw new Error(`${label} returned an empty stream.`);
        let streamed = false;
        const onText = (delta: string) => { streamed = true; answer += delta; input.onDelta(delta); };
        let reply: Reply;
        try { reply = await readReply(response, label, input, onText); }
        catch (error) {
          // The router can answer a request with an error event before any content ("Claude returned an empty response",
          // seen live on #688). Nothing reached the chat yet, so the same request is sent once more.
          if (streamed || input.signal.aborted || !(error instanceof Error && error.message.startsWith(`${label} error:`))) throw error;
          response = await send();
          if (!response.ok || !response.body) throw error;
          reply = await readReply(response, label, input, onText);
        }
        last = reply.usage; outputTokens += reply.usage.outputTokens ?? 0;
        if (reply.blocks.length) add({role: 'assistant', content: reply.blocks});
        if (input.signal.aborted) break;
        const uses = reply.blocks.filter(block => block.type === 'tool_use');
        const steered = lane.steers.splice(0);
        if (!uses.length && !steered.length) break;
        if (round >= MAX_TOOL_ROUNDS || calls >= MAX_CALLS_PER_TURN || Date.now() > deadline) { const note = '\n\n(Stopped: this turn reached its limit on tool calls or time.)'; answer += note; input.onDelta(note); break; }
        const results: Block[] = [];
        for (const [position, use] of uses.entries()) {
          if (position >= MAX_CALLS_PER_ROUND) { results.push({type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Too many tool calls in one reply; call it again.'}); continue; }
          calls++;
          const result = await executeTool({id: String(use.id), name: String(use.name), arguments: JSON.stringify(use.input ?? {})}, {chatId: input.chat.id, ...(browser ? {browser: true} : {}), cwd: input.cwd, access: input.permissionMode, ...(input.vision ? {vision: true} : {}), signal: input.signal, emit: input.onEvent, threadId, turnId, ...(input.authorize ? {authorize: input.authorize} : {}), ...(input.env ? {env: input.env} : {}), deadline});
          const content: Block[] = [{type: 'text', text: result.content}];
          if (result.image) content.push({type: 'image', source: {type: 'base64', media_type: result.image.mediaType, data: result.image.data}});
          results.push({type: 'tool_result', tool_use_id: use.id, content, ...(result.ok ? {} : {is_error: true})});
        }
        // A message sent while this turn runs goes in after the tool results, in the same user turn.
        for (const text of steered) results.push({type: 'text', text});
        add({role: 'user', content: results});
        if (input.signal.aborted) break;
        response = await send();
        if (!response.ok) throw new Error(await responseError(response, label));
      }
    } catch (error) {
      lane.open = false;
      if (saved.length > history.length + 1) memory.commit(threadId, closeOpenCalls(saved));
      return {status: 'failed', finalMessage: '', threadId, turnId, dispatchState: 'dispatched', errorMessage: input.signal.aborted ? 'Stopped.' : error instanceof Error ? error.message.slice(0, 300) : `${label} stream failed.`};
    }
    lane.open = false;
    if (last.inputTokens !== undefined) input.onEvent('thread/tokenUsage/updated', {threadId, turnId, tokenUsage: {last: {inputTokens: last.inputTokens, cachedInputTokens: last.cachedInputTokens ?? 0, outputTokens, totalTokens: last.inputTokens + outputTokens}}});
    const retained = memory.commit(threadId, closeOpenCalls(saved));
    input.onEvent(HISTORY_WINDOW_EVENT, {threadId, turnId, retainedUserTurns: retained.retainedUserTurns, trimmed: retained.trimmed});
    return {status: input.signal.aborted ? 'failed' : 'completed', finalMessage: answer, threadId, turnId, dispatchState: 'dispatched', ...(input.signal.aborted ? {errorMessage: 'Stopped.'} : {})};
  }};
}

/** Saved history keeps no pictures: a screenshot a tool returned would be re-sent on every later turn. */
function withoutImages(message: ClaudeMessage): ClaudeMessage {
  if (typeof message.content === 'string') return message;
  const content = message.content.filter(block => block.type !== 'image').map(block => Array.isArray(block.content) ? {...block, content: (block.content as Block[]).filter(inner => inner.type !== 'image')} : block);
  return {role: message.role, content};
}

/** A conversation saved mid-turn (Stop, a failed round) must not end on tool calls without results: Anthropic refuses
 *  that history. Close each open call with a "not run" result so the next turn can continue. */
function closeOpenCalls(messages: ClaudeMessage[]): ClaudeMessage[] {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'assistant' || typeof lastMessage.content === 'string') return messages;
  const open = lastMessage.content.filter(block => block.type === 'tool_use');
  if (!open.length) return messages;
  return [...messages, {role: 'user', content: open.map(use => ({type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Not run: the turn stopped.'}))}];
}
