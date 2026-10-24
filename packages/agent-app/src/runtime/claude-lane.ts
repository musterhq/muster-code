/**
 * #688: which models of a router gateway run over its Messages API instead of through the Codex client.
 *
 * A Claude model answers with signed thinking blocks that Anthropic checks on the next request. The Codex client never
 * returns those blocks, so the router has to rebuild them and the request can fail with a 400. The Messages API keeps
 * them intact (see adapters/claude-messages.ts). A model id that names Claude (`cc/claude-…`, `claude/claude-…`,
 * `claude-…`) is Claude; a GPT-style id is not; any other id (a router's combos: planner, advisor, executor) is asked once
 * with a tiny streaming request and judged by the model the router reports in `message_start`.
 */
import {join} from 'node:path';
import {BROWSER_MCP, COMPUTER_USE_NOTE} from '../shared/computer-use.ts';
import type {ChatPermissionMode} from '../shared/protocol.ts';
import {BACKGROUND_MCP, BACKGROUND_TOOL_NOTE} from './background-agent-tools.ts';
import {ASK_MCP} from './ask-user.ts';
import {CANVAS_MCP, CANVAS_NOTE} from './canvas-agent-tools.ts';
import {ClaudeConversationMemory, claudeMessagesAdapter} from './adapters/claude-messages.ts';
import {sseEvents} from './adapters/shared.ts';
import type {RunnableAdapter} from './adapters/types.ts';

export const CLAUDE_MODEL_ID = /^(?:cc\/claude-|claude\/claude-|claude-)/;
const GPT_MODEL_ID = /^(?:gpt-|chatgpt-|o[1-9]|codex\/|openai\/)/i;
export const PROBE_TTL_MS = 10 * 60_000, PROBE_FAILURE_TTL_MS = 60_000, PROBE_TIMEOUT_MS = 15_000;
const MAX_PROBES = 256;

/** Tool servers the service adds to every Agent chat. The Messages lane has no MCP client: the browser and ask_user are
 *  offered as native tools, the others are simply not offered (their notes are dropped). Any other server carries user or
 *  Project state (mailbox, terminal consent, SSH, sandbox, Project tasks, the user's own servers) and keeps the turn on Codex. */
const LANE_SERVERS: Record<string, true> = {[BROWSER_MCP]: true, [CANVAS_MCP]: true, [BACKGROUND_MCP]: true, [ASK_MCP]: true};
const SERVER_KEY = /^(?:secret\.)?mcp_servers\.([^.]+)\./;

/** Whether a turn may leave Codex: Full access, and no tool server or goal that only the Codex client can run. */
export function claudeLaneAllowed(access: ChatPermissionMode, overrides: Record<string, unknown> | undefined): boolean {
  if (access !== 'full') return false;
  return Object.entries(overrides ?? {}).every(([key, value]) => {
    const server = SERVER_KEY.exec(key)?.[1];
    return server ? LANE_SERVERS[server] === true : !(key === 'features.goals' && value === true);
  });
}

/** The run's notes without those for tools the Messages lane does not offer. */
export function withoutUnavailableToolNotes(instructions: string | undefined): string | undefined {
  if (!instructions) return instructions;
  const text = [CANVAS_NOTE, BACKGROUND_TOOL_NOTE, COMPUTER_USE_NOTE].reduce((out, note) => out.replace(note, ''), instructions).replace(/\n{3,}/g, '\n\n').trim();
  return text || undefined;
}
/** Server names the lane drops from the run's tool servers (the browser has its own native tools). */
export const LANE_DROPPED_SERVERS: readonly string[] = [BROWSER_MCP, CANVAS_MCP, BACKGROUND_MCP, ASK_MCP];

export interface ClaudeLaneConfig {
  /** Router base URL, e.g. https://router.example/v1 ( /messages is appended). */
  endpoint: string;
  /** The route's own credentials, the same ones its model listing uses. `force` asks for a fresh token after a 401. */
  headers: (force?: boolean) => Promise<Record<string, string>>;
  label: string;
  fetch?: typeof fetch;
}
export interface ClaudeLane {
  /** Runs one turn over the Messages API. */
  adapter: RunnableAdapter;
  /** Whether the model behind this id is Claude: by name, or by asking the router once (cached). Never throws. */
  isClaude(model: string): Promise<boolean>;
  /** Replaces the credentials and transport of the next requests (the route is rebuilt when its configuration changes). */
  configure(next: Pick<ClaudeLaneConfig, 'headers' | 'fetch'>): void;
}

export function createClaudeLane(options: ClaudeLaneConfig & {now?: () => number; dir?: () => string | undefined}): ClaudeLane {
  const now = options.now ?? Date.now;
  let current: Pick<ClaudeLaneConfig, 'headers' | 'fetch'> = {headers: options.headers, ...(options.fetch ? {fetch: options.fetch} : {})};
  const request = (...args: Parameters<typeof fetch>) => (current.fetch ?? fetch)(...args);
  const url = `${options.endpoint.replace(/\/+$/, '')}/messages`;
  const memory = new ClaudeConversationMemory(64, 2_000_000, () => { const dir = options.dir?.(); return dir ? join(dir, 'claude-conversations') : undefined; });
  const adapter = claudeMessagesAdapter({endpoint: options.endpoint, headers: force => current.headers(force), label: options.label, fetch: request as typeof fetch, memory});
  const answers = new Map<string, {at: number; ttl: number; value: boolean}>();
  const pending = new Map<string, Promise<boolean>>();

  /** The model the router reports for this id; undefined when the router cannot be asked. */
  async function reported(model: string): Promise<string | undefined> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const send = async (force: boolean) => request(url, {method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {...await current.headers(force), 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01'},
        body: JSON.stringify({model, max_tokens: 16, stream: true, messages: [{role: 'user', content: 'hi'}]})});
      let response = await send(false);
      if (response.status === 401) { await response.body?.cancel().catch(() => {}); response = await send(true); }
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); return undefined; }
      for await (const {event, data} of sseEvents(response.body)) {
        let payload: {type?: unknown; message?: {model?: unknown}};
        try { payload = JSON.parse(data) as typeof payload; } catch { continue; }
        const type = typeof payload.type === 'string' ? payload.type : event;
        if (type === 'error') return undefined;
        if (type === 'message_start') return typeof payload.message?.model === 'string' ? payload.message.model : undefined;
      }
      return undefined;
    } catch { return undefined; } finally { clearTimeout(timer); }
  }

  async function probe(model: string): Promise<boolean> {
    const hit = answers.get(model);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    const running = pending.get(model);
    if (running) return running;
    const started = (async () => {
      const name = await reported(model);
      const value = name !== undefined && name.startsWith('claude-');
      if (answers.size >= MAX_PROBES) answers.delete(answers.keys().next().value!);
      answers.set(model, {at: now(), ttl: name === undefined ? PROBE_FAILURE_TTL_MS : PROBE_TTL_MS, value});
      return value;
    })().finally(() => pending.delete(model));
    pending.set(model, started);
    return started;
  }

  return {
    adapter,
    configure(next) { current = {headers: next.headers, ...(next.fetch ? {fetch: next.fetch} : {})}; },
    async isClaude(model) {
      if (CLAUDE_MODEL_ID.test(model)) return true;
      if (GPT_MODEL_ID.test(model)) return false;
      return probe(model);
    },
  };
}
