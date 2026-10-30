// Minimal headless Chrome over the DevTools protocol (no puppeteer), shared by the HTML preview harnesses. Not shipped.
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const chromePath = () => process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

export async function launchChrome() {
  const chrome = chromePath();
  if (!chrome) return undefined;
  const profile = mkdtempSync(path.join(tmpdir(), 'html-harness-profile-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', '--js-flags=--max-old-space-size=512', '--renderer-process-limit=2', '--disable-site-isolation-trials', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-features=Translate,OptimizationHints,MediaRouter', 'about:blank'], {stdio: 'ignore'});
  const close = () => { try { proc.kill('SIGKILL'); } catch {} try { rmSync(profile, {recursive: true, force: true}); } catch {} };
  process.on('exit', close);
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await new Promise(r => setTimeout(r, 100));
  }
  if (!target) { close(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
  let nextId = 0; const waiting = new Map(), listeners = [], log = [];
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } else listeners.forEach(l => l(m)); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({id, method, params})); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  listeners.push(m => { if (m.method === 'Runtime.consoleAPICalled') log.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`); if (m.method === 'Runtime.exceptionThrown') log.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`); if (m.method === 'Log.entryAdded') log.push(`${m.params.entry.level}: ${m.params.entry.text}`); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setFocusEmulationEnabled', {enabled: true});
  const navigate = async (url, ready, width = 1100, height = 760) => {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 2, mobile: false});
    await send('Page.navigate', {url});
    for (let i = 0; i < 150; i++) { if (await evaluate(ready).catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`page did not become ready: ${url}\n${log.slice(-10).join('\n')}`);
  };
  const screenshot = async (clip) => Buffer.from((await send('Page.captureScreenshot', {format: 'png', ...(clip ? {clip: {...clip, scale: 1}} : {captureBeyondViewport: false})})).data, 'base64');
  return {send, evaluate, navigate, screenshot, log, close: () => { try { ws.close(); } catch {} close(); }};
}
