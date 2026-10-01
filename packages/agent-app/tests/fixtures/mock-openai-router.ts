/**
 * A local OpenAI-compatible router for provider tests. It requires `Authorization: Bearer <token>` on every
 * /v1 route (401 "Authentication required" otherwise, like router.hybrowlabs.com), serves a /v1/models
 * catalog, and streams /v1/chat/completions and /v1/responses. Every request is logged with the token
 * redacted: the log records only whether the expected bearer arrived.
 */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

export interface RouterRequest {method: string; path: string; auth: 'bearer:valid' | 'bearer:wrong' | 'none'; model?: string; headers: Record<string, string>; status: number}
export interface MockRouter {base: string; origin: string; log: RouterRequest[]; close(): Promise<void>; reply: string}

export const ROUTER_MODELS = ['claude/claude-opus-4.1', 'codex/gpt-5.6-terra', 'auto/best-coding'];

export async function startMockRouter(token: string, options: {reply?: string; echoHeaders?: string[]} = {}): Promise<MockRouter> {
  const log: RouterRequest[] = [];
  const reply = options.reply ?? 'pong from mock router';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: {model?: unknown; stream?: unknown} = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
    const header = req.headers.authorization ?? '';
    const auth: RouterRequest['auth'] = !header ? 'none' : header === `Bearer ${token}` ? 'bearer:valid' : 'bearer:wrong';
    const path = (req.url ?? '').split('?')[0]!;
    const entry: RouterRequest = {method: req.method ?? '', path, auth, ...(typeof body.model === 'string' ? {model: body.model} : {}), headers: Object.fromEntries((options.echoHeaders ?? []).map(name => [name, String(req.headers[name] ?? '')])), status: 0};
    log.push(entry);
    const send = (status: number, payload: unknown) => { entry.status = status; res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(payload)); };
    if (!path.startsWith('/v1/')) return send(404, {error: {message: 'Not found'}});
    if (auth !== 'bearer:valid') return send(401, {error: {message: 'Authentication required', type: 'invalid_request_error'}});
    if (req.method === 'GET' && path === '/v1/models') return send(200, {object: 'list', data: ROUTER_MODELS.map(id => ({id, object: 'model', owned_by: id.split('/')[0]}))});
    const model = typeof body.model === 'string' ? body.model : '';
    if (req.method === 'POST' && !ROUTER_MODELS.includes(model)) return send(404, {error: {message: `Unknown model ${model}`}});
    const sse = (events: Array<[string | undefined, unknown]>) => {
      entry.status = 200;
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
      for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      res.end();
    };
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      return sse([[undefined, {id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {role: 'assistant', content: reply}}]}],
        [undefined, {id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 3, completion_tokens: 4, total_tokens: 7}}], [undefined, '[DONE]']]);
    }
    if (req.method === 'POST' && path === '/v1/responses') {
      const item = {type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: reply, annotations: []}]};
      return sse([
        ['response.created', {type: 'response.created', response: {id: 'resp_1', object: 'response', status: 'in_progress', model}}],
        ['response.output_item.added', {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress', content: []}}],
        ['response.output_text.delta', {type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: reply}],
        ['response.output_item.done', {type: 'response.output_item.done', output_index: 0, item}],
        ['response.completed', {type: 'response.completed', response: {id: 'resp_1', object: 'response', status: 'completed', model, output: [item],
          usage: {input_tokens: 3, input_tokens_details: {cached_tokens: 0}, output_tokens: 4, output_tokens_details: {reasoning_tokens: 0}, total_tokens: 7}}}],
      ]);
    }
    return send(404, {error: {message: 'Not found'}});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {base: `${origin}/v1`, origin, log, reply, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })};
}

/** One log line per request, token-free, for test output. */
export const redactedLog = (log: RouterRequest[]) => log.map(entry => `${entry.method} ${entry.path} auth=${entry.auth}${entry.model ? ` model=${entry.model}` : ''} -> ${entry.status}`);

/** A catalog in Codex's real schema (models[].slug, display_name, supported_reasoning_levels objects, …). */
export function codexCatalog(slugs: string[], padding = 0) {
  return JSON.stringify({models: slugs.map((slug, index) => ({
    slug, display_name: slug.split('/').pop()!.toUpperCase(), description: `${slug} via the router`, default_reasoning_level: 'medium',
    supported_reasoning_levels: [{effort: 'low', description: 'Fast'}, {effort: 'medium', description: 'Balanced'}, {effort: 'high', description: 'Deep'}],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: index, additional_speed_tiers: [], service_tiers: [],
    availability_nux: null, upgrade: null, include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: 'low', apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
    truncation_policy: {mode: 'tokens', limit: 10000}, supports_image_detail_original: false, max_context_window: 272000, effective_context_window_percent: 95,
    experimental_supported_tools: [], supports_search_tool: false, supports_experimental_context: false, use_responses_lite: false,
    base_instructions: 'You are a helpful coding agent.' + ' '.repeat(padding), context_window: 272000, input_modalities: ['text', 'image'],
  }))});
}
