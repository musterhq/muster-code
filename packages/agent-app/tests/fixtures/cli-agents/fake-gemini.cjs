// Fake Gemini CLI: emits `--output-format stream-json` events.
const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
const args = process.argv.slice(2), out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (args[0] === '--version') { console.log('0.11.3'); process.exit(0); }
if (args[0] === '--help') { console.log('Options:\n  -m, --model\n  --output-format  [choices: "text", "json", "stream-json"]\n  --approval-mode  [choices: "default", "auto_edit", "yolo", "plan"]\n  -r, --resume'); process.exit(0); }
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(args));
fs.writeFileSync(path.join(process.cwd(), 'env.json'), JSON.stringify(process.env));
const prompt = args[args.indexOf('--prompt') + 1];
out({type: 'init', timestamp: 't', session_id: 'gemini-session-1', model: 'gemini-2.5-pro'});
out({type: 'message', role: 'user', content: prompt});
if (/HANG/.test(prompt)) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  fs.writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(child.pid));
  setInterval(() => {}, 1000);
} else if (/FAIL/.test(prompt)) {
  out({type: 'error', severity: 'error', message: 'quota exhausted'}); out({type: 'result', status: 'error', error: {type: 'Error', message: 'quota exhausted'}}); process.exit(1);
} else {
  out({type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: {file_path: '/work/marker.txt'}});
  out({type: 'tool_result', tool_id: 't1', status: 'success', output: 'muster-marker'});
  out({type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't2', parameters: {command: 'false'}});
  out({type: 'tool_result', tool_id: 't2', status: 'error', error: {type: 'x', message: 'exit 1'}});
  out({type: 'message', role: 'assistant', content: 'muster-', delta: true});
  out({type: 'message', role: 'assistant', content: 'marker', delta: true});
  out({type: 'result', status: 'success', stats: {total_tokens: 130, input_tokens: 120, output_tokens: 10, cached: 20, duration_ms: 5, tool_calls: 2}});
}
