// Local mocks of every external API the E2E touches. No real tokens, no network beyond 127.0.0.1.
import http from 'node:http';
import { acceptUpgrade } from '../src/net/ws.ts';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readBody = async req => { let b = ''; for await (const c of req) b += c; return b; };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
export const until = async (fn, ms = 60_000, step = 200) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, step)); } return null; };

/** OpenAI-compatible model endpoint: /models and streaming /chat/completions with usage. Replies quote the request's last line. */
export async function mockModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url.endsWith('/models')) return json(res, 200, { data: [{ id: 'mock-1', object: 'model', owned_by: 'e2e' }] });
    const parsed = JSON.parse(body || '{}');
    const last = String(parsed.messages?.at(-1)?.content ?? '').split('\n').filter(Boolean).at(-1) ?? '';
    requests.push(parsed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const reply = `Mock agent reply to: ${last.slice(0, 80)}`;
    for (const part of [reply.slice(0, 10), reply.slice(10)]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

/** Telegram Bot API: getMe, deleteWebhook, long-poll getUpdates, getChatMemberCount, sendMessage. */
export async function mockTelegram(token) {
  const sent = [], queue = [], waiters = [];
  let updateId = 100;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
    if (!m || m[1] !== token) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = m[2];
    if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 999, is_bot: true, username: 'muster_e2e_bot' } });
    if (method === 'deleteWebhook' || method === 'setWebhook') return json(res, 200, { ok: true, result: true });
    if (method === 'getChatMemberCount') return json(res, 200, { ok: true, result: 7 });
    if (method === 'sendMessage') { sent.push(body); return json(res, 200, { ok: true, result: { message_id: sent.length } }); }
    if (method === 'getUpdates') {
      const take = () => queue.filter(u => u.update_id >= (body.offset ?? 0));
      if (!take().length) await new Promise(r => { const t = setTimeout(r, Math.min(1000 * (body.timeout ?? 1), 2000)); waiters.push(() => { clearTimeout(t); r(); }); });
      return json(res, 200, { ok: true, result: take() });
    }
    return json(res, 404, { ok: false, description: `unknown method ${method}` });
  });
  const port = await listen(server);
  return {
    apiBase: `http://127.0.0.1:${port}`, sent,
    push(text, { chatId = -1001, chatType = 'supergroup', title = 'Support', from = { id: 4242, username: 'ana' } } = {}) {
      queue.push({ update_id: updateId++, message: { message_id: updateId, from, chat: { id: chatId, type: chatType, title }, text } });
      while (waiters.length) waiters.shift()();
    },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

/** Slack Web API + Socket Mode WebSocket. Envelopes must be acked; replies come back through chat.postMessage. */
export async function mockSlack({ botToken, appToken }) {
  const posted = [], acks = [], sockets = new Set();
  let port;
  const users = { U_ANA: { name: 'ana', real_name: 'Ana Admin', is_restricted: false }, U_GUEST: { name: 'gus', real_name: 'Gus Guest', is_restricted: true } };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    const auth = req.headers.authorization;
    const method = req.url.replace(/^\/api\//, '');
    if (method === 'apps.connections.open') return auth === `Bearer ${appToken}` ? json(res, 200, { ok: true, url: `ws://127.0.0.1:${port}/socket` }) : json(res, 200, { ok: false, error: 'invalid_auth' });
    if (auth !== `Bearer ${botToken}`) return json(res, 200, { ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') return json(res, 200, { ok: true, user: 'muster', user_id: 'U_BOT', team: 'E2E Workspace' });
    if (method === 'users.info') return json(res, 200, { ok: true, user: users[body.user] ?? { name: body.user } });
    if (method === 'conversations.info') return json(res, 200, { ok: true, channel: { id: body.channel, name: 'support', num_members: 23 } });
    if (method === 'chat.postMessage') { posted.push(body); return json(res, 200, { ok: true, ts: String(Date.now() / 1000) }); }
    return json(res, 200, { ok: false, error: 'unknown_method' });
  });
  server.on('upgrade', (req, socket, head) => {
    const c = acceptUpgrade(req, socket, head);
    if (!c) return;
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    c.on('message', t => { try { const m = JSON.parse(t); if (m.envelope_id) acks.push(m.envelope_id); } catch {} });
    c.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
  port = await listen(server);
  let n = 0;
  return {
    apiBase: `http://127.0.0.1:${port}/api`, posted, acks, connected: () => sockets.size,
    mention(text, { user = 'U_ANA', channel = 'C_SUPPORT', ts = `${Date.now() / 1000}`, thread } = {}) {
      const envelope = { envelope_id: `env-${++n}`, type: 'events_api', payload: { event: { type: 'app_mention', user, channel, channel_type: 'channel', text: `<@U_BOT> ${text}`, ts, ...(thread ? { thread_ts: thread } : {}) } } };
      for (const s of sockets) s.send(JSON.stringify(envelope));
      return envelope.envelope_id;
    },
    drop() { for (const s of sockets) s.terminate('mock drop'); },
    close: () => { for (const s of sockets) s.terminate('closing'); server.closeAllConnections?.(); server.close(); },
  };
}

/** Mattermost REST v4 + /api/v4/websocket. `posted` events carry the post as a JSON string, like the real server. */
export async function mockMattermost({ botToken }) {
  const posts = [], sockets = new Set();
  const users = { u_ana: { id: 'u_ana', username: 'ana', roles: 'system_user', first_name: 'Ana', last_name: 'Admin' }, u_guest: { id: 'u_guest', username: 'gus', roles: 'system_guest' } };
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (req.headers.authorization !== `Bearer ${botToken}`) return json(res, 401, { message: 'Invalid or expired session' });
    const url = req.url;
    if (url === '/api/v4/users/me') return json(res, 200, { id: 'u_bot', username: 'muster', is_bot: true });
    let m;
    if ((m = /^\/api\/v4\/users\/(\w+)$/.exec(url))) return users[m[1]] ? json(res, 200, users[m[1]]) : json(res, 404, { message: 'not found' });
    if ((m = /^\/api\/v4\/channels\/(\w+)\/stats$/.exec(url))) return json(res, 200, { channel_id: m[1], member_count: 41, guest_count: 2 });
    if ((m = /^\/api\/v4\/channels\/(\w+)$/.exec(url))) return json(res, 200, { id: m[1], name: 'town-square', display_name: 'Town Square' });
    if (url === '/api/v4/posts' && req.method === 'POST') { posts.push(body); return json(res, 201, { id: `p${posts.length}`, ...body }); }
    return json(res, 404, { message: `no route ${url}` });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${botToken}`) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const c = acceptUpgrade(req, socket, head);
    if (!c) return;
    sockets.add(c); c.on('close', () => sockets.delete(c));
    c.send(JSON.stringify({ event: 'hello', data: { server_version: 'mock' }, broadcast: {}, seq: 0 }));
  });
  const port = await listen(server);
  let n = 0;
  return {
    url: `http://127.0.0.1:${port}`, posts, connected: () => sockets.size,
    post(message, { user = 'u_ana', channel = 'ch_town', mention = true, root = '' } = {}) {
      const post = { id: `post${++n}`, user_id: user, channel_id: channel, root_id: root, message: mention ? `@muster ${message}` : message, type: '' };
      for (const s of sockets) s.send(JSON.stringify({ event: 'posted', data: { post: JSON.stringify(post), channel_type: 'O', sender_name: `@${users[user]?.username ?? user}`, mentions: JSON.stringify(mention ? ['u_bot'] : []) }, broadcast: { channel_id: channel }, seq: n }));
      return post.id;
    },
    close: () => { for (const s of sockets) s.terminate('closing'); server.closeAllConnections?.(); server.close(); },
  };
}
