/**
 * #675: the background-process and terminal tool hosts believe a chat id only with that chat's MUSTER_CHAT_TOKEN, the
 * same per-chat HMAC binding ToolHost uses. Anyone who can read the endpoint file (every chat's MCP process can) must
 * not be able to start, read or stop processes, or read a terminal, as another chat.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {BACKGROUND_MCP, BackgroundToolHost} from '../src/runtime/background-agent-tools.ts';
import {TerminalToolHost} from '../src/runtime/terminal-agent-tools.ts';
import {backgroundRunOptions, terminalRunOptions} from '../src/runtime/domains/terminal.ts';
import {CHAT_BINDING_REFUSED, chatTokenIssuer} from '../src/runtime/governance/chat-binding.ts';
import type {ProcessSnapshot, ProcessStart} from '../src/shared/process-protocol.ts';

type Body = {content?: {text: string}[]; isError?: boolean; error?: string};
const post = async (dir: string, endpointName: string, chatToken: string | undefined, body: unknown): Promise<{status: number; body: Body}> => {
  const {url, token} = JSON.parse(await fs.readFile(join(dir, endpointName), 'utf8')) as {url: string; token: string};
  const headers: Record<string, string> = {'content-type': 'application/json', authorization: `Bearer ${token}`};
  if (chatToken !== undefined) headers['x-muster-chat-token'] = chatToken;
  const response = await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json() as Body};
};

function backgroundHost(dir: string) {
  const starts: ProcessStart[] = [];
  const snapshot = (input: ProcessStart): ProcessSnapshot => ({chatId: input.chatId, processId: 'process:x', generation: 1, sequence: 0, status: 'running', label: input.label!, purpose: input.purpose!, startedAt: '', updatedAt: '', output: '', truncated: false, exitCode: null, owner: 'agent'});
  const host = new BackgroundToolHost({dir, execPath: process.execPath, processes: {
    start: async input => { starts.push(input); return snapshot(input); },
    list: async ({chatId}) => ({chatId, sessions: []}), stop: async () => { throw new Error('nope'); },
  }});
  return {host, starts};
}

test('#675 background host: a forged chat id is refused, the real chat works, and chat A’s token cannot act as chat B', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'muster-bg-bind-'));
  const {host, starts} = backgroundHost(dir);
  t.after(async () => { host.dispose(); await fs.rm(dir, {recursive: true, force: true}); });
  await host.start();
  const run = {tool: 'run_background', args: {command: 'npm run build', label: 'build', purpose: 'build'}};

  // A forged chat id with no token, and with a made-up token.
  for (const token of [undefined, '', 'f'.repeat(64)]) {
    const forged = await post(dir, 'background-endpoint.json', token, {chatId: 'chat-b', ...run});
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error, CHAT_BINDING_REFUSED);
  }
  // Chat A's real token sent with chat B's id.
  const crossed = await post(dir, 'background-endpoint.json', host.chatToken('chat-a'), {chatId: 'chat-b', ...run});
  assert.equal(crossed.status, 403);
  assert.equal(crossed.body.error, CHAT_BINDING_REFUSED);
  assert.equal(starts.length, 0, 'no refused call reached ProcessSessions');

  // The real chat with its own token still works.
  const real = await post(dir, 'background-endpoint.json', host.chatToken('chat-a'), {chatId: 'chat-a', ...run});
  assert.equal(real.status, 200);
  assert.match(real.body.content![0]!.text, /Started process:x "build" running/);
  assert.deepEqual(starts.map(s => s.chatId), ['chat-a']);
});

test('#675 terminal host: a forged chat id cannot read another chat’s terminal; the real chat still can', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'muster-term-bind-'));
  const asked: string[] = [];
  const host = new TerminalToolHost({dir, execPath: process.execPath, allowed: async chatId => { asked.push(chatId); return chatId === 'chat-b'; }, tails: chatId => [{title: 'zsh', status: 'running', text: `secret of ${chatId}\n`, truncated: false}]});
  t.after(async () => { host.dispose(); await fs.rm(dir, {recursive: true, force: true}); });
  await host.start();
  for (const token of [undefined, host.chatToken('chat-a')]) {
    const forged = await post(dir, 'terminal-endpoint.json', token, {chatId: 'chat-b', tool: 'read_thread_terminal'});
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error, CHAT_BINDING_REFUSED);
  }
  assert.deepEqual(asked, []);
  const real = await post(dir, 'terminal-endpoint.json', host.chatToken('chat-b'), {chatId: 'chat-b', tool: 'read_thread_terminal'});
  assert.equal(real.status, 200);
  assert.match(real.body.content![0]!.text, /secret of chat-b/);
});

test('#675 run options inject the host’s per-chat token, and the stdio server sends it (and shows a refusal plainly)', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'muster-bg-bind-mcp-'));
  const {host, starts} = backgroundHost(dir);
  t.after(async () => { host.dispose(); await fs.rm(dir, {recursive: true, force: true}); });
  const launcher = await host.start();
  assert.equal(typeof chatTokenIssuer(BACKGROUND_MCP), 'function', 'a started host registers its token issuer');
  const opts = backgroundRunOptions({id: 'chat-a', mode: 'agent', permissionMode: 'full'}, launcher)!;
  assert.equal(opts.configOverrides[`mcp_servers.${BACKGROUND_MCP}.env.MUSTER_CHAT_TOKEN`], host.chatToken('chat-a'));
  assert.notEqual(host.chatToken('chat-a'), host.chatToken('chat-b'));

  const callAs = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, [join(dir, 'muster-background-mcp.cjs'), join(dir, 'background-endpoint.json')], {env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'inherit']});
    let out = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { out += d; });
    try {
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'run_background', arguments: {command: 'make'}}}) + '\n');
      for (let i = 0; i < 250; i++) { const line = out.split('\n').find(l => l.includes('"id":1')); if (line) return JSON.parse(line).result as Body; await delay(20); }
      throw new Error('no reply');
    } finally { child.kill(); }
  };
  const env = opts.configOverrides as Record<string, unknown>;
  const forged = await callAs({MUSTER_CHAT_ID: 'chat-b', MUSTER_CHAT_TOKEN: String(env[`mcp_servers.${BACKGROUND_MCP}.env.MUSTER_CHAT_TOKEN`])});
  assert.equal(forged.isError, true);
  assert.equal(forged.content![0]!.text, CHAT_BINDING_REFUSED);
  const real = await callAs({MUSTER_CHAT_ID: String(env[`mcp_servers.${BACKGROUND_MCP}.env.MUSTER_CHAT_ID`]), MUSTER_CHAT_TOKEN: String(env[`mcp_servers.${BACKGROUND_MCP}.env.MUSTER_CHAT_TOKEN`])});
  assert.match(real.content![0]!.text, /Started process:x/);
  assert.deepEqual(starts.map(s => s.chatId), ['chat-a']);

  host.dispose();
  assert.equal(chatTokenIssuer(BACKGROUND_MCP), undefined, 'a disposed host stops issuing tokens');
  assert.equal(backgroundRunOptions({id: 'chat-a', mode: 'agent', permissionMode: 'full'}, launcher), null, 'no token, no server');
  assert.equal(terminalRunOptions({id: 'chat-a'}, true, launcher, undefined), null);
});
