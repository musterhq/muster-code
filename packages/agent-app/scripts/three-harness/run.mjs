// Drives scripts/three-harness/harness.tsx in headless Chrome over the DevTools protocol (no Electron).
// Usage: node scripts/three-harness/run.mjs --fixtures <dir> --out <dir> [--shots <dir>] [--scenarios budget,idle,cycles,shots] [--large terrain-50mb.glb]
//   env CHROME=<path to chrome binary>. Prints one JSON report on stdout.
import * as esbuild from 'esbuild';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {copyFileSync, createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const fixtures = path.resolve(arg('fixtures', 'model-fixtures'));
const out = path.resolve(arg('out', path.join(tmpdir(), 'three-harness')));
const shotsDir = arg('shots') ? path.resolve(arg('shots')) : null;
const scenarios = new Set(arg('scenarios', 'budget,idle,cycles').split(','));
const large = arg('large', 'terrain-50mb.glb');
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const csp = process.env.HARNESS_CSP ?? "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src data: blob:; font-src 'self'";

mkdirSync(out, {recursive: true});
await esbuild.build({entryPoints: {harness: path.join(root, 'scripts/three-harness/harness.tsx'), 'model-worker': path.join(root, 'src/renderer/three-engine/model/worker.ts')},
  outdir: out, bundle: true, minify: !process.env.HARNESS_NO_MINIFY, splitting: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', external: ['fs', 'path'],
  loader: {'.ttf': 'file', '.woff2': 'file', '.wasm': 'binary'}, define: {'process.env.NODE_ENV': '"production"'}, absWorkingDir: root, logLevel: 'error'});
copyFileSync(path.join(root, 'src/renderer/styles.css'), path.join(out, 'styles.css'));
writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./harness.css"><link rel="stylesheet" href="./page.css"></head><body><div id="stage"></div><script type="module" src="./harness.js"></script></body></html>`);
writeFileSync(path.join(out, 'page.css'), 'html,body{margin:0;height:100%;background:var(--bg)}body{display:flex;align-items:stretch}#stage{display:flex;flex-direction:column;width:100vw;height:100vh;min-height:0}');

const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.wasm': 'application/wasm'};
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  const isModel = url.pathname.startsWith('/models/');
  const file = path.normalize(path.join(isModel ? fixtures : out, decodeURIComponent(isModel ? url.pathname.slice(8) : url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!file.startsWith(isModel ? fixtures : out) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const size = statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  if (range && size > 0) {
    const start = Number(range[1]), end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
    response.writeHead(206, {'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1});
    createReadStream(file, {start, end}).pipe(response);
  } else { response.writeHead(200, {'Content-Type': type, 'Content-Length': size}); createReadStream(file).pipe(response); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(tmpdir(), 'three-harness-profile-'));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc', 'about:blank'], {stdio: 'ignore'});
const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { server.close(); } catch {} try { rmSync(profile, {recursive: true, force: true}); } catch {} };
process.on('exit', cleanup);

async function connect() {
  for (let i = 0; i < 100; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = list.find(t => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Chrome did not start');
}
const ws = new WebSocket(await connect());
await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
let nextId = 0; const waiting = new Map(), listeners = [];
ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } else listeners.forEach(l => l(m)); });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({id, method, params})); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const consoleLog = [];
listeners.push(m => { if (m.method === 'Runtime.consoleAPICalled') consoleLog.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`); if (m.method === 'Runtime.exceptionThrown') consoleLog.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`); if (m.method === 'Log.entryAdded') consoleLog.push(`${m.params.entry.level}: ${m.params.entry.text}`); });
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Performance.enable');
await send('Emulation.setFocusEmulationEnabled', {enabled: true});

async function load(width = 1280, height = 800, query = '', dpr = 1) {
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: dpr, mobile: false});
  await send('Page.navigate', {url: `${base}/index.html${query}`});
  for (let i = 0; i < 100; i++) { if (await evaluate("document.body.dataset.harness === 'ready'").catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('harness did not load: ' + consoleLog.join(' | '));
}
// Blink's DOM wrappers (and WebGL canvases) need several collections, with idle time in between, before they are actually freed.
const collectGarbage = async () => { await send('HeapProfiler.enable'); for (let i = 0; i < 4; i++) { await send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 250)); } };
const metric = async name => (await send('Performance.getMetrics')).metrics.find(m => m.name === name)?.value;
const countInstances = async (expr) => {
  const proto = await send('Runtime.evaluate', {expression: expr});
  const objects = await send('Runtime.queryObjects', {prototypeObjectId: proto.result.objectId});
  const length = await send('Runtime.callFunctionOn', {objectId: objects.objects.objectId, functionDeclaration: 'function() { return this.length; }', returnByValue: true});
  return length.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => { if (!shotsDir) return; mkdirSync(shotsDir, {recursive: true}); const {data} = await send('Page.captureScreenshot', {format: 'png'}); writeFileSync(path.join(shotsDir, name), Buffer.from(data, 'base64')); };

const report = {csp, chrome: (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser};
try {
  if (scenarios.has('budget')) {
    await load(1280, 800);
    await evaluate('harness.resetCounters()');
    const opened = await evaluate(`harness.open(${JSON.stringify(large)})`);
    await sleep(1500);
    const c = await evaluate('harness.counters()');
    report.budget = {file: large, state: opened.state, firstFrameMs: Math.round(opened.ms), openedAt: Math.round(c.openedAt), longTasksAfterOpen: c.longTasks.filter(t => t.start >= c.openedAt - 5).map(t => ({atMsAfterOpen: Math.round(t.start - c.openedAt), ms: Math.round(t.duration)})), maxLongTaskMs: Math.round(Math.max(0, ...c.longTasks.filter(t => t.start >= c.openedAt - 5).map(t => t.duration))), chunkCalls: c.chunkCalls, gl: await evaluate('harness.glInfo()')};
    await shot('large-model.png');
  }
  if (scenarios.has('idle')) {
    await load(1280, 800);
    const opened = await evaluate(`harness.open('cube-textured.glb')`);
    await sleep(1200);
    await evaluate('harness.resetCounters()');
    const before = await evaluate('harness.glInfo().then(i => i.frames)');
    await sleep(4000);
    const after = await evaluate('harness.glInfo().then(i => i.frames)'), c = await evaluate('harness.counters()');
    report.idle = {state: opened.state, seconds: 4, rafCallbacks: c.raf, rendersWhileIdle: after - before};
    await evaluate("harness.drag(120, 20)"); await sleep(120);
    const during = await evaluate('harness.glInfo().then(i => i.frames)'); await sleep(2500);
    const settled = await evaluate('harness.glInfo().then(i => i.frames)'); await sleep(1500);
    const rest = await evaluate('harness.glInfo().then(i => i.frames)');
    report.idle.afterFling = {framesDuringFling: settled - after, framesAfterSettled: rest - settled};
    void during;
  }
  if (scenarios.has('debug')) {
    await load(1280, 800);
    await evaluate(`harness.open('cube-textured.glb')`); await sleep(1500);
    report.debug = await evaluate('harness.debug()');
  }
  if (scenarios.has('engine-cycles')) {
    await load(1280, 800);
    await collectGarbage();
    report.engineCycles = await evaluate('harness.engineCycles(50, true)');
    await sleep(300); await collectGarbage();
    report.engineCycles.canvases = await countInstances('HTMLCanvasElement.prototype');
  }
  if (scenarios.has('raw-cycles')) {
    await load(1280, 800);
    report.raw = {};
    for (const mode of ['canvas', 'renderer', 'render']) {
      await load(1280, 800);
      await evaluate(`harness.rawCycles(30, '${mode}')`); await sleep(300); await collectGarbage();
      report.raw[mode] = await countInstances('HTMLCanvasElement.prototype');
    }
  }
  if (scenarios.has('retainers')) {
    await load(1280, 800);
    await evaluate(`harness.engineCycles(${Number(arg('cycles', 50))}, true)`); await sleep(300); await collectGarbage();
    const chunks = [];
    listeners.push(m => { if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk); });
    await send('HeapProfiler.takeHeapSnapshot', {reportProgress: false});
    const snap = JSON.parse(chunks.join(''));
    const {node_fields: nf, edge_fields: ef, node_types: nt, edge_types: et} = snap.snapshot.meta;
    const N = nf.length, E = ef.length, nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
    const nodeCount = nodes.length / N;
    const typeName = nt[0], edgeTypeName = et[0];
    const firstEdge = new Int32Array(nodeCount + 1); let acc = 0;
    for (let i = 0; i < nodeCount; i++) { firstEdge[i] = acc; acc += nodes[i * N + 4]; }
    firstEdge[nodeCount] = acc;
    const rev = Array.from({length: nodeCount}, () => []);
    for (let i = 0; i < nodeCount; i++) for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) {
      const type = edgeTypeName[edges[e * E]]; if (type === 'weak') continue;
      const to = edges[e * E + 2] / N; const label = type === 'element' || type === 'hidden' ? `[${edges[e * E + 1]}]` : strings[edges[e * E + 1]];
      rev[to].push([i, `${type}:${label}`]);
    }
    const name = i => strings[nodes[i * N + 1]];
    const targets = []; for (let i = 0; i < nodeCount; i++) if (name(i) === arg('retain', 'WebGL2RenderingContext')) targets.push(i);
    const out = [];
    for (const t of targets.slice(0, 3)) {
      const prev = new Map([[t, null]]); const queue = [t]; let found = -1;
      while (queue.length && found < 0) { const n = queue.shift(); for (const [p, label] of rev[n]) { if (prev.has(p)) continue; prev.set(p, [n, label]); if (p === 0) { found = p; break; } queue.push(p); } }
      const chain = []; let cur = found;
      while (cur !== null && cur >= 0 && prev.get(cur)) { const [next, label] = prev.get(cur); chain.push(`${name(cur).slice(0, 50).replace(/\n/g, ' ')} --${label.slice(0, 40)}--> `); cur = next; }
      out.push({target: name(t), chain: chain.slice(0, 18)});
    }
    const counts = {}; for (let i = 0; i < nodeCount; i++) { const n = name(i); if (/Canvas|WebGL/.test(n)) counts[n] = (counts[n] ?? 0) + 1; }
    report.retainers = {canvasNodes: targets.length, byName: counts, paths: out};
  }
  if (scenarios.has('formats')) {
    await load(1280, 800);
    report.formats = {};
    for (const file of ['cube.glb', 'cube-textured.glb', 'cube-draco.glb', 'cube-meshopt.glb', 'cube-external.gltf', 'cube.obj', 'cube-textured.obj', 'sphere.stl', 'cube-ascii.stl', 'sphere.ply', 'spiral-points.ply', 'cube.fbx']) {
      const opened = await evaluate(`harness.open(${JSON.stringify(file)})`);
      await sleep(250);
      const detail = await evaluate(`(document.querySelector('.rich-block-error')?.textContent ?? '') + ' | ' + (document.querySelector('.model-info') ? 'info' : '')`);
      report.formats[file] = {state: opened.state, ms: Math.round(opened.ms), error: opened.state === 'error' ? detail : undefined};
    }
  }
  if (scenarios.has('cycles')) {
    await load(1280, 800);
    await evaluate(`harness.open('cube-textured.glb')`); await evaluate('harness.close()'); await sleep(300);
    await collectGarbage();
    const heap0 = await metric('JSHeapUsedSize'), nodes0 = await metric('Nodes'), listeners0 = await metric('JSEventListeners');
    const samples = [];
    const total = Number(arg('count', 50));
    for (let i = 0; i < total; i++) {
      const opened = await evaluate(`harness.open('cube-textured.glb')`);
      if (opened.state !== 'ready') throw new Error('cycle open failed: ' + opened.state);
      if (i === total - 1) report.glBeforeClose = await evaluate('harness.glInfo()');
      await evaluate('harness.close()');
      if (i % Math.max(10, total / 5) === Math.max(10, total / 5) - 1) { await sleep(200); await collectGarbage(); samples.push({cycle: i + 1, heapMB: +((await metric('JSHeapUsedSize')) / 1048576).toFixed(2), liveEngines: (await evaluate('harness.counters().then(c => c.engines)'))}); }
    }
    await sleep(300); await collectGarbage();
    const heap1 = await metric('JSHeapUsedSize');
    report.retained = {canvases: await countInstances('HTMLCanvasElement.prototype'), divs: await countInstances('HTMLDivElement.prototype'), buttons: await countInstances('HTMLButtonElement.prototype'), workers: await countInstances('Worker.prototype'), svgs: await countInstances('SVGElement.prototype'), spans: await countInstances('HTMLSpanElement.prototype'), sections: await countInstances('HTMLElement.prototype')};
    report.cycles = {count: total, heapBeforeMB: +(heap0 / 1048576).toFixed(2), heapAfterMB: +(heap1 / 1048576).toFixed(2), heapGrowthMB: +((heap1 - heap0) / 1048576).toFixed(2), domNodesGrowth: (await metric('Nodes')) - nodes0, listenerGrowth: (await metric('JSEventListeners')) - listeners0, liveEngines: await evaluate('harness.counters().then(c => c.engines)'), samples};
  }
  if (scenarios.has('shots')) {
    const themes = (arg('themes', 'muster-dark,muster-light,solarized-dark,sepia')).split(',');
    const widths = (arg('widths', '1280,900')).split(',').map(Number);
    for (const width of widths) {
      for (const theme of themes) {
        const tag = `${theme}-${width}`;
        await load(width, 760, '?delay=700');
        await evaluate(`harness.applyTheme(${JSON.stringify(theme)})`);
        const pending = evaluate(`harness.open('cube-textured.glb', {variant: 'tab'})`);
        await sleep(450); await shot(`${tag}-loading.png`);
        await pending; await sleep(700); await shot(`${tag}-ready-tab.png`);
        await evaluate("harness.click('[aria-label=\"Model info\"]')"); await evaluate("harness.click('[aria-label=\"Wireframe\"]')"); await sleep(400); await shot(`${tag}-info-wireframe.png`);
        await evaluate("harness.click('[aria-label=\"Full screen\"]')"); await sleep(400); await shot(`${tag}-fullscreen.png`);
        await evaluate("harness.click('[aria-label=\"Exit full screen\"]')");
        await evaluate(`harness.open('broken.glb')`); await sleep(500); await shot(`${tag}-error.png`);
        await evaluate(`harness.open('empty.glb')`); await sleep(500); await shot(`${tag}-error-empty.png`);
        await evaluate(`harness.open('cube.glb', {variant: 'inline'})`); await sleep(700); await shot(`${tag}-inline.png`);
        await evaluate(`harness.open('spiral-points.ply')`); await sleep(700); await shot(`${tag}-points.png`);
      }
    }
  }
  report.console = consoleLog.slice(0, 30);
} finally { cleanup(); }
console.log(JSON.stringify(report, null, 1));
process.exit(0);
