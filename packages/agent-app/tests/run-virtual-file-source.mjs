import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist'), {recursive: true});
const outdir = await mkdtemp(path.join(root, 'dist/virtual-file-test-'));
const chromePath = process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
let chrome, ws;
const server = createServer(async (req, res) => {
  const name = req.url === '/' ? 'index.html' : path.basename(req.url);
  if (name === 'index.html') {res.end('<html><head><link rel="stylesheet" href="/test.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>'); return;}
  try {res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(path.join(outdir, name)));}
  catch {res.statusCode = 404; res.end();}
});
try {
  await build({entryPoints: [path.join(root, 'tests/virtual-file-source.browser.tsx')], outfile: path.join(outdir, 'test.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'warning'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(outdir, 'profile')}`, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 15_000);
    chrome.on('error', reject);
    chrome.stderr.on('data', chunk => {stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) {clearTimeout(timeout); resolve(match[1]);}});
  });
  const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {const message = JSON.parse(event.data); if (typeof message.id !== 'number') return; const done = pending.get(message.id); pending.delete(message.id); if (typeof done === 'function') done(message);});
  const call = (method, params = {}) => new Promise(resolve => {pending.set(++id, resolve); ws.send(JSON.stringify({id, method, params}));});
  await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}`});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const check = await call('Runtime.evaluate', {expression: '!!globalThis.testResult', returnByValue: true});
    if (check.result?.result?.value) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const result = await call('Runtime.evaluate', {expression: 'globalThis.testResult', awaitPromise: true, returnByValue: true, timeout: 30_000});
  if (result.error || result.result?.exceptionDetails || !result.result?.result?.value) throw new Error(JSON.stringify(result));
  console.log('virtual-file-source: PASS', JSON.stringify(result.result.result.value));
} finally {
  ws?.close();
  if (chrome) {chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve));}
  server.close();
  await rm(outdir, {recursive: true, force: true});
}
