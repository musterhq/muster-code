#!/usr/bin/env node
/*
 * A stand-in for Claude Code in print mode (`claude -p --output-format stream-json --input-format stream-json`), installed
 * "on the host" of the #147 phase 2 tests (tests/fixtures/fake-ssh). It records its argv, folder and a few variables in
 * $HOME/claude-log.jsonl and answers each stream-json user message by its first word:
 *   TOOLS     starts each --mcp-config server (Muster's relay), lists its tools and calls ask_user through it
 *   APPROVE   asks Muster for `git status` with a can_use_tool control request and reports the answer
 *   WAIT      waits for a second user message (a steer) and answers with it
 *   HANG      writes $HOME/hang.pid and never answers
 *   AUTH      fails the way a signed-out Claude Code does
 *   otherwise answers "hello from <folder>"
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process'), readline = require('node:readline');
const args = process.argv.slice(2), flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const home = process.env.HOME, log = entry => fs.appendFileSync(path.join(home, 'claude-log.jsonl'), JSON.stringify(entry) + '\n');
const session = flag('--resume') || flag('--session-id') || 'none';
log({ argv: args, cwd: process.cwd(), relayToken: process.env.MUSTER_RELAY_TOKEN ? 'set' : null, anthropicKey: process.env.ANTHROPIC_API_KEY ? 'set' : null, git: process.env.GIT_AUTHOR_NAME || null, codexHome: process.env.CODEX_HOME || null });
const out = event => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + '\n');
const say = text => out({ type: 'assistant', message: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'assistant', content: [{ type: 'text', text }] } });
const result = (text, ok = true) => out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: text, usage: { input_tokens: 3, output_tokens: 2 } });
out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [] });

const expand = value => typeof value === 'string' ? value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '') : value;
/** One MCP stdio server from --mcp-config: initialize, tools/list and one call. */
function mcp(spec, call) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(spec.env || {}).map(([k, v]) => [k, expand(v)])) };
    const child = spawn(spec.command, spec.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', id = 0; const waiting = new Map();
    const request = (method, params) => new Promise(done => { const n = ++id; waiting.set(n, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} } });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${stderr.trim()}`)));
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no answer: ${stderr.trim()}`)); }, 10_000);
    (async () => {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
      const list = await request('tools/list', {});
      const called = call ? await request('tools/call', call) : undefined;
      clearTimeout(timer); child.removeAllListeners('exit'); child.kill();
      resolve({ server: init.result?.serverInfo?.name, tools: (list.result?.tools || []).map(t => t.name), called: called?.result });
    })().catch(reject);
  });
}

let waitingSteer, pendingPermission, hanging = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_response') { pendingPermission?.(message.response); return; }
  if (message.type !== 'user') return;
  const content = message.message?.content, text = typeof content === 'string' ? content : (content || []).map(b => b.text || '').join('\n');
  const word = text.trim().split(/\s+/).pop();
  if (waitingSteer) { const done = waitingSteer; waitingSteer = undefined; done(text); return; }
  if (word === 'TOOLS') {
    try {
      const config = JSON.parse(flag('--mcp-config') || '{"mcpServers":{}}'), names = Object.keys(config.mcpServers);
      log({ mcpConfig: config });
      const reports = [];
      for (const name of names) reports.push({ name, ...await mcp(config.mcpServers[name], name === 'muster_ask' ? { name: 'ask_user', arguments: { question: 'Which database should the host use?', default: 'SQLite' } } : undefined) });
      log({ reports });
      say(`servers: ${reports.map(r => `${r.name}=${r.tools.join('+')}`).join(', ')}`); result('tools ok');
    } catch (error) { result(`tools failed: ${error.message}`, false); }
    return;
  }
  if (word === 'APPROVE') {
    const answer = new Promise(done => { pendingPermission = done; });
    out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' }, tool_use_id: 'tool-1' } });
    const response = await answer; log({ permission: response });
    say(`permission: ${response?.response?.behavior}`); result('approved run done'); return;
  }
  if (word === 'WAIT') { say('waiting for more'); const steer = await new Promise(done => { waitingSteer = done; }); say(`steered: ${steer.trim().split(/\s+/).pop()}`); result('steer done'); return; }
  if (word === 'HANG') { hanging = true; setInterval(() => undefined, 1000); fs.writeFileSync(path.join(home, 'hang.pid'), String(process.pid)); say('working on the host'); return; }
  if (word === 'AUTH') { result('Invalid API key · Please run /login', false); return; }
  say(`hello from ${process.cwd()}`); result(`hello from ${process.cwd()}`);
});
// Like Claude Code, a turn that is still working outlives the end of its input (a dropped connection on a real host).
lines.on('close', () => { if (!waitingSteer && !pendingPermission && !hanging) setTimeout(() => process.exit(0), 20); });
