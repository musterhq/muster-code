// Fake Grok Build: `--version`, `models`, and `agent stdio` speaking ACP (JSON-RPC over stdio).
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), {spawn} = require('node:child_process');
const here = (name) => path.join(__dirname, name), args = process.argv.slice(2);
if (args[0] === '--version') { console.log(fs.existsSync(here('old')) ? 'grok 1.0.12' : 'grok 1.0.13'); process.exit(0); }
if (args[0] === 'models') { console.log(fs.existsSync(here('signedout')) ? 'You are not logged in.' : 'You are logged in with grok.com.\nDefault model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5'); process.exit(0); }
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(args));
fs.writeFileSync(path.join(process.cwd(), 'env.json'), JSON.stringify(process.env));
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...m}) + '\n'), update = (u) => send({method: 'session/update', params: {sessionId: 's1', update: u}});
let promptId, permissionId, prompt = '';
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id: m.id, result: {protocolVersion: 1, agentCapabilities: {loadSession: true, promptCapabilities: {image: false}}, authMethods: [{id: 'cached_token'}, {id: 'xai.api_key'}]}});
  else if (m.method === 'authenticate') send({id: m.id, result: {}});
  else if (m.method === 'session/load') { update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'REPLAYED-HISTORY'}}); send({id: m.id, result: {}}); fs.writeFileSync(path.join(process.cwd(), 'loaded.txt'), m.params.sessionId); }
  else if (m.method === 'session/new') send({id: m.id, result: {sessionId: 's1'}});
  else if (m.method === 'session/set_model') send({id: m.id, result: {}});
  else if (m.method === 'session/prompt') {
    promptId = m.id; prompt = m.params.prompt[0].text;
    if (/HANG/.test(prompt)) { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'}); fs.writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(child.pid)); return; }
    update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'thinking'}});
    update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'hello '}});
    update({sessionUpdate: 'tool_call', toolCallId: 'k1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: {command: 'ls'}});
    permissionId = 900; send({id: permissionId, method: 'session/request_permission', params: {sessionId: 's1', toolCall: {toolCallId: 'k1', kind: 'execute'}, options: [{optionId: 'yes', name: 'Allow', kind: 'allow_once'}, {optionId: 'no', name: 'Reject', kind: 'reject_once'}]}});
  } else if (m.id === permissionId && !m.method) {
    fs.writeFileSync(path.join(process.cwd(), 'permission.json'), JSON.stringify(m.result));
    const allowed = m.result.outcome.optionId === 'yes';
    update({sessionUpdate: 'tool_call_update', toolCallId: 'k1', status: allowed ? 'completed' : 'failed', content: [{type: 'content', content: {type: 'text', text: allowed ? 'a.txt' : 'denied'}}]});
    update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'world'}});
    send({id: promptId, result: {stopReason: 'end_turn', usage: {inputTokens: 40, outputTokens: 5}}});
  } else if (m.method === 'session/cancel') fs.writeFileSync(path.join(process.cwd(), 'cancelled.txt'), '1');
});
process.stdin.on('end', () => process.exit(0));
