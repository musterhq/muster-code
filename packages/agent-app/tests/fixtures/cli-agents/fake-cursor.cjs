// Fake Cursor CLI: emits the documented `--output-format stream-json` events. Markers beside this file switch behaviour.
const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
const here = (name) => path.join(__dirname, name), args = process.argv.slice(2), out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (args[0] === '--version') { console.log('2026.01.15-abc1234'); process.exit(0); }
if (args[0] === 'status') { console.log(fs.existsSync(here('signedout')) ? 'Not logged in' : '\u001b[32m✓\u001b[0m Logged in as dev@example.com'); process.exit(0); }
if (args[0] === 'models') { console.log('\u001b[1mAvailable models\u001b[0m\n\nauto - Auto  (current)\ncomposer-1 - Composer 1\nsonnet-4.5 - Claude 4.5 Sonnet (default)\n'); process.exit(0); }
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(args));
fs.writeFileSync(path.join(process.cwd(), 'env.json'), JSON.stringify(process.env));
const prompt = args[args.length - 1], sid = 'cursor-session-1';
out({type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: sid, model: 'Auto', permissionMode: 'default'});
out({type: 'user', message: {role: 'user', content: [{type: 'text', text: prompt}]}, session_id: sid});
if (/HANG/.test(prompt)) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  fs.writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(child.pid));
  setInterval(() => {}, 1000);
} else if (/FAIL/.test(prompt)) {
  out({type: 'result', subtype: 'error', is_error: true, result: 'Model quota exceeded', session_id: sid}); process.exit(1);
} else {
  out({type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: {readToolCall: {args: {path: 'marker.txt'}}}, session_id: sid});
  out({type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: {readToolCall: {args: {path: 'marker.txt'}, result: {success: {content: 'muster-marker', isEmpty: false}}}}, session_id: sid});
  out({type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: {shellToolCall: {args: {command: 'ls'}}}, session_id: sid});
  out({type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: {shellToolCall: {args: {command: 'ls'}, result: {success: {stdout: 'a\n', stderr: '', exitCode: 0}}}}, session_id: sid});
  out({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: 'muster'}]}, session_id: sid, timestamp_ms: 1});
  out({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: '-marker'}]}, session_id: sid, timestamp_ms: 2});
  out({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: 'muster-marker'}]}, session_id: sid});
  out({type: 'result', subtype: 'success', is_error: false, duration_ms: 10, result: 'muster-marker', session_id: sid, usage: {inputTokens: 100, outputTokens: 7, cacheReadTokens: 50, cacheWriteTokens: 0}});
}
