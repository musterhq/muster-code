// #160: a fake Agent Client Protocol agent (JSON-RPC 2.0 over stdio, protocol version 1) for Muster's ACP route tests.
// Flags: --log=<file> (every message it receives, one JSON per line), --no-load, --resume, --legacy-models, --auth-required, --not-acp.
// The prompt text picks the scenario: STREAM, EDIT <file>, WRITE <file>, READ <file>, RUN <command>, HANG, otherwise an echo.
const fs = require('node:fs'), readline = require('node:readline');
const flags = process.argv.slice(2), flag = (name) => flags.includes(`--${name}`), log = (flags.find(f => f.startsWith('--log=')) || '').slice(6);
if (flag('not-acp')) { console.log('Welcome to an interactive agent. Type /help to begin.'); process.exit(1); }
const record = (m) => { if (log) fs.appendFileSync(log, JSON.stringify(m) + '\n'); };
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...m}) + '\n');
const update = (sessionId, u) => send({method: 'session/update', params: {sessionId, update: u}});
let nextId = 1000, sessions = 0;
const waiting = new Map(), cancelled = new Set();
const request = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({id, method, params}); });
const models = flag('legacy-models')
  ? {models: {currentModelId: 'fast', availableModels: [{modelId: 'fast', name: 'Fast'}, {modelId: 'smart', name: 'Smart'}]}}
  : {configOptions: [{id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [{value: 'fast', name: 'Fast'}, {value: 'smart', name: 'Smart'}]}]};
const modes = {modes: {currentModeId: 'default', availableModes: [{id: 'default', name: 'Default'}, {id: 'plan', name: 'Plan'}]}};
const permission = (sessionId, toolCall) => request('session/request_permission', {sessionId, toolCall, options: [{optionId: 'allow', name: 'Allow', kind: 'allow_once'}, {optionId: 'reject', name: 'Reject', kind: 'reject_once'}]});
async function prompt(m) {
  const sessionId = m.params.sessionId, text = m.params.prompt.map(block => block.text || '').join('\n'), last = text.split('\n').pop();
  const say = (t) => update(sessionId, {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: t}});
  const done = (stopReason = 'end_turn', extra = {}) => send({id: m.id, result: {stopReason, ...extra}});
  if (/^STREAM/.test(last)) {
    update(sessionId, {sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'Thinking about it'}});
    update(sessionId, {sessionUpdate: 'plan', entries: [{content: 'Read the notes', priority: 'high', status: 'completed'}, {content: 'Answer', priority: 'medium', status: 'in_progress'}]});
    update(sessionId, {sessionUpdate: 'tool_call', toolCallId: 't-read', title: 'Read notes.md', kind: 'read', status: 'pending', locations: [{path: 'notes.md'}]});
    update(sessionId, {sessionUpdate: 'tool_call_update', toolCallId: 't-read', status: 'completed', content: [{type: 'content', content: {type: 'text', text: 'notes body'}}]});
    say('Hello '); say('from ACP.');
    return done('end_turn', {usage: {inputTokens: 12, outputTokens: 5, totalTokens: 17}});
  }
  if (/^EDIT /.test(last)) {
    const path = last.slice(5).trim(), before = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
    const call = {toolCallId: 't-edit', title: `Edit ${path}`, kind: 'edit', status: 'pending', locations: [{path}], content: [{type: 'diff', path, oldText: before, newText: 'one\nTWO\nthree\n'}]};
    update(sessionId, {sessionUpdate: 'tool_call', ...call});
    const answer = await permission(sessionId, {toolCallId: 't-edit', kind: 'edit', title: call.title, content: call.content, locations: call.locations});
    const outcome = answer.result && answer.result.outcome;
    if (!outcome || outcome.outcome !== 'selected' || outcome.optionId !== 'allow') { update(sessionId, {sessionUpdate: 'tool_call_update', toolCallId: 't-edit', status: 'failed'}); say(`Declined (${outcome ? outcome.optionId || outcome.outcome : 'none'}).`); return done(); }
    const wrote = await request('fs/write_text_file', {sessionId, path, content: 'one\nTWO\nthree\n'});
    update(sessionId, {sessionUpdate: 'tool_call_update', toolCallId: 't-edit', status: wrote.error ? 'failed' : 'completed'});
    say(wrote.error ? `Edit failed: ${wrote.error.message}` : 'Edited.'); return done();
  }
  if (/^WRITE /.test(last)) { const path = last.slice(6).trim(), wrote = await request('fs/write_text_file', {sessionId, path, content: 'written by agent\n'}); say(wrote.error ? `WRITE-ERR: ${wrote.error.message}` : 'WRITE-OK'); return done(); }
  if (/^READ /.test(last)) { const got = await request('fs/read_text_file', {sessionId, path: last.slice(5).trim(), line: 2, limit: 1}); say(got.error ? `READ-ERR: ${got.error.message}` : `READ:${got.result.content}`); return done(); }
  if (/^RUN /.test(last)) {
    const command = last.slice(4).trim();
    update(sessionId, {sessionUpdate: 'tool_call', toolCallId: 't-run', title: command, kind: 'execute', status: 'pending', rawInput: {command}});
    const answer = await permission(sessionId, {toolCallId: 't-run', kind: 'execute', title: command, rawInput: {command}});
    const allowed = answer.result && answer.result.outcome.optionId === 'allow';
    update(sessionId, {sessionUpdate: 'tool_call_update', toolCallId: 't-run', status: allowed ? 'completed' : 'failed', content: [{type: 'content', content: {type: 'text', text: allowed ? 'ran ok' : 'refused'}}]});
    say(allowed ? 'Ran it.' : 'Did not run it.'); return done();
  }
  if (/^HANG/.test(last)) {
    update(sessionId, {sessionUpdate: 'tool_call', toolCallId: 't-hang', title: 'sleep 1000', kind: 'execute', status: 'in_progress', rawInput: {command: 'sleep 1000'}});
    say('Working…');
    const timer = setInterval(() => { if (!cancelled.has(sessionId)) return; clearInterval(timer); cancelled.delete(sessionId); update(sessionId, {sessionUpdate: 'tool_call_update', toolCallId: 't-hang', status: 'failed'}); done('cancelled'); }, 10);
    return;
  }
  say(`echo:${last}`); return done();
}
readline.createInterface({input: process.stdin}).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  record(m);
  if (m.id !== undefined && !m.method) { const resolve = waiting.get(m.id); waiting.delete(m.id); if (resolve) resolve(m); return; }
  const reply = (result) => send({id: m.id, result});
  switch (m.method) {
    case 'initialize': return reply({protocolVersion: 1, agentInfo: {name: 'fake-acp', title: 'Fake ACP', version: '0.1.0'}, authMethods: [], agentCapabilities: {loadSession: !flag('no-load'), promptCapabilities: {image: false}, sessionCapabilities: flag('resume') ? {resume: {}} : {}}});
    case 'session/new': if (flag('auth-required')) return send({id: m.id, error: {code: -32000, message: 'Authentication required'}}); return reply({sessionId: `sess-${process.pid}-${++sessions}`, ...models, ...modes});
    case 'session/load':
      update(m.params.sessionId, {sessionUpdate: 'user_message_chunk', content: {type: 'text', text: 'REPLAYED-QUESTION'}});
      update(m.params.sessionId, {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'REPLAYED-ANSWER'}});
      return reply({...models, ...modes});
    case 'session/resume': return reply({...models, ...modes});
    case 'session/set_config_option': return reply({configOptions: models.configOptions || []});
    case 'session/set_model': case 'session/set_mode': return reply({});
    case 'session/prompt': return void prompt(m);
    case 'session/cancel': cancelled.add(m.params.sessionId); return;
    default: if (m.id !== undefined) send({id: m.id, error: {code: -32601, message: `unknown ${m.method}`}});
  }
}).on('close', () => process.exit(0));
