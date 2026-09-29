#!/usr/bin/env node
// Launches a packaged Muster Agent (Windows or Linux build in release-dist/*-unpacked) against a throwaway profile
// and checks, through the renderer's own bridge, that it really works: the window boots, providers list, a folder
// and chat are created, a terminal runs a command and prints its output, and the agent tool launchers (what Codex and
// Claude Code run as MCP servers) start and answer a tool call. Used by CI on each platform.
//   node scripts/smoke-packaged.mjs [path-to-executable]
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 9477);
const fail = (message) => { console.error(`SMOKE FAIL: ${message}`); process.exitCode = 1; };

function executable() {
  if (process.argv[2]) return process.argv[2];
  const out = path.join(root, 'release-dist');
  const dir = readdirSync(out).find(name => /-unpacked$/.test(name));
  if (!dir) throw new Error('No *-unpacked build in release-dist/. Run npm run package:linux or package:win first.');
  const name = process.platform === 'win32' ? 'muster-agent.exe' : 'muster-agent';
  return path.join(out, dir, name);
}

const exe = executable();
if (!existsSync(exe)) throw new Error(`Packaged executable not found: ${exe}`);
const profile = mkdtempSync(path.join(os.tmpdir(), 'muster-smoke-'));
const workspace = path.join(profile, 'workspace'); mkdirSync(workspace);
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(profile, 'user-data')}`, ...(process.platform === 'linux' && process.env.SMOKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])];
// Linux launches WITHOUT --no-sandbox by default: the packaged launcher must start the app the way a user's double-click does
// (falling back itself only where user namespaces are restricted). SMOKE_NO_SANDBOX=1 restores the old flag.
console.log(`launching ${exe}${process.env.SMOKE_NO_SANDBOX === '1' ? ' (--no-sandbox)' : ''}`);
// Own process group on Unix: an AppImage's launcher spawns the real app, and the whole tree must die with the smoke test.
const child = spawn(exe, args, {detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, HOME: process.platform === 'win32' ? process.env.HOME : profile}});
let appOutput = '';
const relay = d => { appOutput += d; process.stdout.write(`[app] ${d}`); };
child.stdout.on('data', relay);
child.stderr.on('data', relay);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page() {
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`The app exited (code ${child.exitCode}) before opening a window.`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const target = list.find(t => t.type === 'page');
      if (target) return target.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('The app never opened a window with a debugging endpoint.');
}

/** Finds the launcher Muster wrote for an agent tool (a #!/bin/sh script, or a .cmd on Windows). */
function findLauncher(dir, stem) {
  const wanted = process.platform === 'win32' ? [`${stem}.cmd`, stem] : [stem];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && wanted.includes(entry.name)) return full;
    if (entry.isDirectory()) { const found = findLauncher(full, stem); if (found) return found; }
  }
}

/** Starts a launcher the way an agent does (as an MCP stdio server) and speaks JSON-RPC to it. */
async function speakMcp(launcher, chatId, call) {
  // Windows: Claude Code runs a .cmd through cmd.exe; Codex (Rust) creates it directly. cmd.exe /c is the strict case.
  const [file, argv] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', launcher]] : [launcher, []];
  const server = spawn(file, argv, {env: {...process.env, MUSTER_CHAT_ID: chatId}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let buffer = '', stderr = '';
  const waiting = new Map();
  server.stderr.on('data', d => { stderr += d; });
  server.stdout.on('data', d => {
    buffer += d;
    let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue; const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const exited = new Promise((_, reject) => { server.on('error', reject); server.on('exit', code => reject(new Error(`launcher exited (${code}) before answering. ${stderr.slice(-300)}`))); });
  exited.catch(() => {});
  let id = 0;
  const rpc = (method, params) => Promise.race([
    new Promise(resolve => { const n = ++id; waiting.set(n, resolve); server.stdin.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n'); }),
    exited,
    sleep(20000).then(() => { throw new Error(`launcher did not answer ${method} in 20s. ${stderr.slice(-300)}`); }),
  ]);
  try {
    const init = await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'smoke', version: '0'}});
    const tools = (await rpc('tools/list', {})).result.tools;
    return {server: init.result.serverInfo.name, tools: tools.map(t => t.name), call: call ? await rpc('tools/call', {name: call(tools), arguments: {}}) : undefined};
  } finally { server.kill(); }
}

let ws, seq = 0;
const pending = new Map();
async function evaluate(expression) {
  const id = ++seq;
  const reply = new Promise(resolve => pending.set(id, resolve));
  ws.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
  const message = await reply;
  if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return message.result?.result?.value;
}

try {
  ws = new WebSocket(await page());
  ws.onmessage = event => { const m = JSON.parse(event.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  await new Promise(r => { ws.onopen = r; });
  for (let i = 0; i < 60 && !(await evaluate('!!window.muster').catch(() => false)); i++) await sleep(1000);
  const invoke = (command, input) => evaluate(`window.muster.invoke(${JSON.stringify(command)}, ${JSON.stringify(input)})`);
  const snapshot = await invoke('app.snapshot', {});
  console.log(`booted: ${snapshot.folders.length} folders, ${snapshot.chats.length} chats`);
  const providers = await invoke('providers.list', undefined);
  console.log(`providers listed: ${providers.length} (${providers.map(p => `${p.name}${p.available ? '' : ' (not set up)'}`).join(', ') || 'none on this runner'})`);
  const folder = await invoke('folder.add', {path: workspace});
  const chat = await invoke('chat.create', {folderId: folder.id});
  const terminal = await invoke('terminal.create', {chatId: chat.id, cols: 100, rows: 30});
  console.log(`terminal ${terminal.id} running ${terminal.shell}`);
  await sleep(1500);
  await invoke('terminal.input', {id: terminal.id, data: 'echo MUSTER_SMOKE_$((6*7))\r'.replace('$((6*7))', process.platform === 'win32' ? '42' : '$((6*7))')});
  let output = '';
  for (let i = 0; i < 30 && !output.includes('MUSTER_SMOKE_42'); i++) { await sleep(500); output = (await invoke('terminal.snapshot', {id: terminal.id})).data; }
  if (!output.includes('MUSTER_SMOKE_42')) fail(`the terminal did not print the command output. Got: ${JSON.stringify(output.slice(-400))}`);
  else console.log('terminal ran a command: MUSTER_SMOKE_42');
  await invoke('terminal.kill', {id: terminal.id});
  // Agent tools: the launchers must start and reach the app's tool host, on every platform.
  const userData = path.join(profile, 'user-data');
  for (const [stem, label] of [['muster-terminal-mcp', 'terminal'], ['muster-browser-mcp', 'browser']]) {
    let launcher; for (let i = 0; i < 30 && !(launcher = findLauncher(userData, stem)); i++) await sleep(500);
    if (!launcher) { fail(`the ${label} agent tool launcher was never written under ${userData}`); continue; }
    try {
      const r = await speakMcp(launcher, chat.id, label === 'terminal' ? tools => tools[0].name : undefined);
      if (!r.tools.length) fail(`the ${label} agent tool launcher listed no tools`);
      else if (r.call && !(r.call.result?.content?.[0]?.text)) fail(`the ${label} agent tool call returned no content: ${JSON.stringify(r.call)}`);
      else if (r.call && /not reachable/.test(r.call.result.content[0].text)) fail(`the ${label} agent tool could not reach Muster: ${r.call.result.content[0].text}`);
      else console.log(`agent ${label} tool (${path.basename(launcher)}): ${r.server}, tools [${r.tools.join(', ')}]${r.call ? `, call answered: ${JSON.stringify(r.call.result.content[0].text.slice(0, 80))}` : ''}`);
    } catch (error) { fail(`the ${label} agent tool launcher failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const updates = await invoke('updates.status', undefined);
  console.log(`updates: ${updates.phase} (current ${updates.current})`);
  if (process.env.SMOKE_EXPECT_UPDATES === '1' && updates.phase === 'disabled') fail('updates are disabled: the packaged build has no update source.');
  // The installed deb must keep the sandbox ON (its AppArmor profile grants user namespaces): no launcher fallback notice.
  if (process.env.SMOKE_EXPECT_SANDBOX === '1' && /starting with --no-sandbox/.test(appOutput)) fail('the launcher fell back to --no-sandbox; the installed package should keep the sandbox on.');
  if (!process.exitCode) console.log('SMOKE OK');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  try { ws?.close(); } catch { /* closed */ }
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch { child.kill(); }
  child.stdout.destroy(); child.stderr.destroy();
  await sleep(1500);
  try { rmSync(profile, {recursive: true, force: true}); } catch { /* Windows may still hold files */ }
  process.exit(process.exitCode ?? 0);
}
