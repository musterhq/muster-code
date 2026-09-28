#!/usr/bin/env node
// Launches a packaged Muster Agent (Windows or Linux build in release-dist/*-unpacked) against a throwaway profile
// and checks, through the renderer's own bridge, that it really works: the window boots, providers list, a folder
// and chat are created, and a terminal runs a command and prints its output. Used by CI on each platform.
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
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(profile, 'user-data')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
console.log(`launching ${exe}`);
const child = spawn(exe, args, {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, HOME: process.platform === 'win32' ? process.env.HOME : profile}});
child.stdout.on('data', d => process.stdout.write(`[app] ${d}`));
child.stderr.on('data', d => process.stdout.write(`[app] ${d}`));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const target = list.find(t => t.type === 'page');
      if (target) return target.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('The app never opened a window with a debugging endpoint.');
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
  const updates = await invoke('updates.status', undefined);
  console.log(`updates: ${updates.phase} (current ${updates.current})`);
  if (!process.exitCode) console.log('SMOKE OK');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  try { ws?.close(); } catch { /* closed */ }
  child.kill();
  await sleep(1500);
  try { rmSync(profile, {recursive: true, force: true}); } catch { /* Windows may still hold files */ }
}
