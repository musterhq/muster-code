#!/usr/bin/env node
// Regenerates the README screenshots: builds the renderer with a handle on its store, loads it in
// headless Chrome with a fictional preload bridge (fixtures.js + mock.js), drives each screen and
// saves PNGs to docs/images. No Electron, no real data, no network.
//   npm run shots                 # every shot
//   npm run shots -- hero memory  # only these
import * as esbuild from 'esbuild';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {SHOTS} = await import(process.env.SHOTS_FILE ? new URL('file://' + path.resolve(process.env.SHOTS_FILE)).href : './shots.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..', '..');
const outDir = path.join(app, '..', '..', 'docs', 'images');
const probe = process.argv.includes('--probe');
// --probe keeps its output (and, with --no-build, reuses the last bundle) in a fixed scratch folder.
const work = probe ? path.join(process.env.SHOTS_TMP || tmpdir(), 'muster-shots-probe') : mkdtempSync(path.join(process.env.SHOTS_TMP || tmpdir(), 'muster-shots-'));
const bundle = path.join(work, 'renderer');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SHOTS_PORT || 9460);
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));

async function build() {
  if (probe && process.argv.includes('--no-build') && existsSync(path.join(bundle, 'main.js'))) return;
  await esbuild.build({
    entryPoints: [{in: path.join(here, 'main.tsx'), out: 'main'}, {in: path.join(app, 'src/renderer/diff-worker.ts'), out: 'diff-worker'}, {in: path.join(app, 'src/renderer/syntax-highlight-worker.ts'), out: 'syntax-highlight-worker'}],
    outdir: bundle, bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
    loader: {'.ttf': 'file', '.woff2': 'file'}, minify: true, logLevel: 'error', absWorkingDir: app,
    define: {'process.env.NODE_ENV': '"production"'},
  });
  cpSync(path.join(app, 'src/renderer/styles.css'), path.join(bundle, 'styles.css'));
  cpSync(path.join(app, 'node_modules/pdfjs-dist/build/pdf.worker.mjs'), path.join(bundle, 'pdf.worker.mjs'));
  writeFileSync(path.join(bundle, 'index.html'), readFileSync(path.join(app, 'src/renderer/index.html'), 'utf8'));
}

// ES modules do not load from file:// in Chrome, so the bundle is served on loopback.
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm'};
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(bundle, rel);
    if (!file.startsWith(bundle) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream'});
    res.end(readFileSync(file));
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function startChrome() {
  const profile = path.join(work, 'profile');
  rmSync(profile, {recursive: true, force: true});
  mkdirSync(profile, {recursive: true});
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--use-mock-keychain', '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=2', '--allow-file-access-from-files', '--disable-extensions',
    '--window-size=1600,1000', 'about:blank'], {stdio: 'ignore'});
  for (let i = 0; i < 100; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const page = list.find(t => t.type === 'page'); if (page) return {proc, ws: page.webSocketDebuggerUrl}; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('headless Chrome did not start');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map(); const listeners = new Set();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else for (const l of listeners) l(m); };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, m => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)); ws.send(JSON.stringify({id: i, method, params})); });
  return new Promise(r => { ws.onopen = () => r({call, on: l => listeners.add(l), close: () => ws.close()}); });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await build();
  const server = await serve();
  const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;
  const {proc, ws} = await startChrome();
  const cdp = await connect(ws);
  const logs = [];
  cdp.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400)}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`exception: ${m.params.exceptionDetails.exception?.description?.slice(0, 400) ?? m.params.exceptionDetails.text}`);
  });
  try {
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable');
    // Fixed zone and locale so schedules and timestamps read the same on every machine.
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId: 'Europe/London'});
    await cdp.call('Emulation.setLocaleOverride', {locale: 'en-GB'});
    await cdp.call('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false});
    const fixtures = readFileSync(path.join(here, 'fixtures.js'), 'utf8');
    const mock = readFileSync(path.join(here, 'mock.js'), 'utf8');
    mkdirSync(outDir, {recursive: true});
    const evaluate = async (expression) => {
      const r = await cdp.call('Runtime.evaluate', {expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true});
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const selected = SHOTS.filter(s => !only.length || only.includes(s.name));
    for (const shot of selected) {
      const script = await cdp.call('Page.addScriptToEvaluateOnNewDocument', {source: `window.__SHOT=${JSON.stringify(shot.name)};window.__SHOT_OPTS=${JSON.stringify(shot.opts ?? {})};\n${fixtures}\n${mock}`});
      logs.length = 0;
      await cdp.call('Page.navigate', {url: pageUrl});
      await sleep(1500);
      const ctx = {evaluate, sleep, cdp,
        click: (selector, text) => evaluate(`const els=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=${text ? `els.find(e=>(e.textContent||e.getAttribute('aria-label')||'').includes(${JSON.stringify(text)}))` : 'els[0]'};if(!el)throw new Error('no element '+${JSON.stringify(selector + ' ' + (text ?? ''))});el.click();return true;`),
        store: (code) => evaluate(`const s=window.__shots.store;${code}`),
        key: async (key, modifiers = 0, code = key) => { await cdp.call('Input.dispatchKeyEvent', {type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0}); await cdp.call('Input.dispatchKeyEvent', {type: 'keyUp', key, code, modifiers}); },
        type: (text) => cdp.call('Input.insertText', {text}),
        mouse: async (x, y) => { await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}); await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1}); await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}); },
        /** A real pointer click at the centre of the first match (for popovers that ignore synthetic clicks). */
        press: async (selector, text) => {
          const r = await evaluate(`const els=[...document.querySelectorAll(${JSON.stringify(selector)})];const el=${text ? `els.find(e=>(e.textContent||e.getAttribute('aria-label')||'').includes(${JSON.stringify(text)}))` : 'els[0]'};if(!el)throw new Error('no element '+${JSON.stringify(selector + ' ' + (text ?? ''))});const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};`);
          await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
          await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1});
          await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1});
        },
        hover: (x, y) => cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}),
      };
      try { await shot.run(ctx); } catch (error) { logs.push(`driver: ${error.message}`); }
      await sleep(shot.settle ?? 700);
      let clip = shot.clip ? {...shot.clip, scale: 1} : undefined;
      const pageClip = await evaluate('return window.__clip ?? null');
      if (pageClip) clip = {...pageClip, scale: 1};
      if (shot.clipSelector) {
        const pad = shot.clipPad ?? 16;
        const r = await evaluate(`const b=document.querySelector(${JSON.stringify(shot.clipSelector)}).getBoundingClientRect();return {x:b.left,y:b.top,width:b.width,height:b.height};`);
        clip = {x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 - (shot.clipTrimBottom ?? 0), scale: 1};
      }
      const {data} = await cdp.call('Page.captureScreenshot', {format: 'png', ...(clip ? {clip} : {}), captureBeyondViewport: false});
      const file = path.join(probe ? work : outDir, `muster-agent-${shot.name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      const unknown = await evaluate('return window.__unknownCommands ? [...window.__unknownCommands] : []').catch(() => []);
      const banners = await evaluate(`return [...document.querySelectorAll('.pane-error,.notice.error,[role=alert],.area-boundary')].map(e=>e.textContent.slice(0,160))`).catch(() => []);
      console.log(`${shot.name} -> ${file}`);
      if (unknown.length) console.log(`  unmocked: ${unknown.join(', ')}`);
      if (banners.length) console.log(`  banners: ${banners.join(' | ')}`);
      for (const line of logs) console.log(`  ${line}`);
      await cdp.call('Page.removeScriptToEvaluateOnNewDocument', {identifier: script.identifier});
    }
  } finally {
    cdp.close();
    server.close();
    proc.kill('SIGTERM');
    await sleep(300);
    if (!proc.killed) proc.kill('SIGKILL');
    if (!probe) rmSync(work, {recursive: true, force: true}); else console.log(`probe output kept in ${work}`);
  }
}
main().catch(error => { console.error(error); process.exit(1); });
