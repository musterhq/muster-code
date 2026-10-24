// Headless screenshots of the real agent-HTML and preview components with the app CSS (no Electron).
// Usage: node --experimental-transform-types scripts/html-harness/shots.mjs --src <package root> --entry harness.tsx|harness-after.tsx --prefix before|after --out <dir>
// The pages are served by the tree's own ReportRegistry (same body and CSP as muster-report://), on plain http for the harness.
import * as esbuild from 'esbuild';
import {createServer} from 'node:http';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {launchChrome} from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const src = path.resolve(arg('src', path.resolve(here, '../..')));
const entry = arg('entry', 'harness-after.tsx');
const prefix = arg('prefix', 'after');
const outPng = path.resolve(arg('out', path.join(tmpdir(), 'html-shots')));
const build = path.join(tmpdir(), `html-harness-${prefix}`);
mkdirSync(outPng, {recursive: true}); mkdirSync(build, {recursive: true});
// The harness sources live in this tree; for another tree they are copied next to its sources so relative imports resolve there.
const harnessDir = path.join(src, 'scripts/html-harness');
if (path.resolve(harnessDir) !== path.resolve(here)) { mkdirSync(harnessDir, {recursive: true}); for (const file of ['harness.tsx', 'harness-after.tsx', 'fixtures.ts']) copyFileSync(path.join(here, file), path.join(harnessDir, file)); }
await esbuild.build({entryPoints: {harness: path.join(harnessDir, entry)}, outdir: build, bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
  loader: {'.ttf': 'file', '.woff2': 'file', '.woff': 'file', '.wasm': 'binary', '.svg': 'file', '.png': 'file'}, define: {'process.env.NODE_ENV': '"production"'}, absWorkingDir: src, logLevel: 'error', nodePaths: [path.join(here, '../../node_modules')]});
copyFileSync(path.join(src, 'src/renderer/styles.css'), path.join(build, 'styles.css'));
writeFileSync(path.join(build, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./harness.css"><style>
html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--ui)}#stage{min-height:100vh}
.harness-col{width:740px;margin:0 auto;padding:28px 0 32px}.harness-text{margin:8px 0 12px;font-size:var(--fs-14);line-height:1.6;color:var(--text)}
.harness-pane{width:760px;height:520px;margin:24px auto;display:flex;border:1px solid var(--hairline);border-radius:var(--radius-8);overflow:hidden}.harness-pane>*{flex:1}
.harness-composer{width:min(calc(100% - 64px),740px);margin:0 auto;padding:14px 16px;border:1px solid var(--hairline);border-radius:var(--radius-12);background:var(--bg-raised);color:var(--text-faint);font-size:var(--fs-14)}
</style></head><body><div id="stage"></div><script type="module" src="./harness.js"></script></body></html>`);

const {ReportRegistry} = await import(pathToFileURL(path.join(src, 'src/main/report-origin.ts')).href);
const {cursorScript} = existsSync(path.join(src, 'src/main/agent-tools/browser-tools.ts')) ? await import(pathToFileURL(path.join(src, 'src/main/agent-tools/browser-tools.ts')).href) : {};
const {APP_PAGE} = await import(pathToFileURL(path.join(here, 'fixtures.ts')).href);
const registry = new ReportRegistry();
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png'};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://x');
  if (url.pathname === '/register') {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const {token} = registry.register(input);
    response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({url: `${base}/r/${token}/index.html?v=1`, token})); return;
  }
  const report = /^\/r\/([a-f0-9]{32})\/index\.html$/.exec(url.pathname);
  if (report) { const served = registry.respond(`muster-report://${report[1]}/index.html`); response.writeHead(served.status, served.headers); response.end(served.body); return; }
  if (url.pathname === '/app') { response.writeHead(200, {'content-type': 'text/html'}); response.end(APP_PAGE); return; }
  const file = path.join(build, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(build) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, {'content-type': MIME[path.extname(file)] ?? 'application/octet-stream'}); response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome();
if (!chrome) throw new Error('No Chrome found (set CHROME).');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const written = [];
const save = async (name, selector) => {
  const clip = selector ? await chrome.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 12), width: r.width + 32, height: r.height + 24}; })()`) : undefined;
  const file = path.join(outPng, `${prefix}-${name}.png`);
  writeFileSync(file, await chrome.screenshot(clip)); written.push(file);
};
const show = async (scene, dark) => {
  await chrome.navigate(base + '/', "document.body.dataset.harness === 'ready'", 1100, 860);
  if (!await chrome.evaluate(`harness.has(${JSON.stringify(scene)})`)) return false;
  await chrome.evaluate(`harness.show(${JSON.stringify(scene)}, ${dark})`);
  await sleep(900);
  // Agent pages mount when near the viewport and size themselves; give them a moment to load and report.
  for (let i = 0; i < 30; i++) { if (await chrome.evaluate("[...document.querySelectorAll('.sandboxed-html')].every(el => !el.dataset.loading)")) break; await sleep(150); }
  await sleep(500);
  return true;
};
try {
  for (const [scene, selector] of [['report', '.harness-col'], ['render', '.harness-col'], ['network', '.harness-col'], ['servers', '.harness-col'], ['unreachable', '.harness-pane']]) {
    for (const dark of [true, false]) if (await show(scene, dark)) await save(`${scene}-${dark ? 'dark' : 'light'}`, selector);
  }
  if (await show('render', true)) {
    await chrome.evaluate(`document.querySelector('[aria-label="Full screen"]').click()`); await sleep(1200);
    await chrome.evaluate(`document.querySelector('.rich-full [aria-label="Zoom in"]')?.click()`); await sleep(600);
    await save('fullscreen-zoom-dark');
  }
  if (cursorScript) {
    await chrome.navigate(base + '/app', 'document.readyState === "complete"', 1100, 560);
    await chrome.evaluate(cursorScript('', '#add', 'click')); await sleep(260);
    await save('agent-cursor');
  }
  console.log(JSON.stringify({written, log: chrome.log.filter(line => /error|exception/i.test(line)).slice(0, 20)}, null, 2));
} finally { chrome.close(); server.close(); }
