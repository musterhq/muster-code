// Screenshots the desktop app's Settings › Integrations › Muster Server section without launching Electron: the real renderer
// bundle in headless Chrome, behind a stub of the desktop preload bridge (no `host: 'web'`). The stub answers like a fresh app
// and like a server the user then connects to. Usage: node e2e/desktop-panel-shot.mjs <shots-dir>
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, H, sleep } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'dist', 'renderer');
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: desktop-panel-shot.mjs <shots-dir>');
mkdirSync(OUT, { recursive: true });

const STUB = `(() => {
  let view = { connected: false, url: null, user: null, serverVersion: null, connectedAt: null, secureStorage: true };
  const settings = { 'general.sendKey': 'enter', 'general.spellcheck': true, 'appearance.textSize': 100, 'appearance.theme': 'dark', 'appearance.reducedMotion': 'system', 'appearance.reducedTransparency': 'system', 'chat.inlineDiffs': true };
  const answers = {
    'app.snapshot': () => ({ folders: [], chats: [], projects: [], version: 1 }),
    'settings.get': () => ({ values: settings }),
    'paperclip.config.get': () => ({ mode: 'off', baseUrl: '', hasToken: false, secureStorage: true, companyId: null }),
    'paperclip.test': () => ({ ok: false, message: 'No Paperclip on this Mac' }),
    'musterServer.status': () => view,
    'musterServer.connect': input => { view = { connected: true, url: new URL(input.url).origin, user: { username: input.username || 'olivia', displayName: 'Olivia Owner', role: 'owner' }, serverVersion: '0.2.10', connectedAt: new Date().toISOString(), secureStorage: true }; return view; },
    'musterServer.projects': () => ({ projects: [
      { id: 'p1', name: 'Support desk', goal: 'Answer customer questions', archived: false, openUrl: view.url + '/?project=p1' },
      { id: 'p2', name: 'Website relaunch', goal: 'Ship the new marketing site', archived: false, openUrl: view.url + '/?project=p2' } ] }),
    'updates.status': () => ({ phase: 'idle', current: '0.2.10', channel: 'stable', autoCheck: true }),
  };
  window.muster = {
    invoke: async (command, input) => { const a = answers[command]; if (a) return a(input); if (/\\.list$|\\.inventory$|usage$/.test(command)) return []; return undefined; },
    subscribe: () => () => {},
  };
  window.musterMenu = { onAction: () => () => {}, closeWindow() {} };
})();`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/stub.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(STUB); return; }
  if (path === '/' ) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(join(RENDERER, 'index.html'), 'utf8').replace('<script type="module"', '<script src="/stub.js"></script><script type="module"')); return; }
  const file = join(RENDERER, decodeURIComponent(path));
  if (!file.startsWith(RENDERER) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const b = await launch({ port: 9300 + Math.floor(Math.random() * 500) });
try {
  await b.goto(`http://127.0.0.1:${server.address().port}/`, 3500);
  await b.eval(`${H} const later = await until(() => byText('button', 'Set up later'), 2500); if (later) { later.click(); await w(400); }
    (await until(() => byText('button', 'Settings'))).click(); await w(1200);
    (await until(() => document.querySelector('[data-section=integrations]'))).click(); await w(1200);
    const nav = all('.settings-nav-item').map(txt); if (nav.includes('Server')) throw new Error('the web-only Server section leaked into the desktop app');
    const heading = await until(() => all('h3').find(h => txt(h) === 'Muster Server')); heading.scrollIntoView({ block: 'start' }); await w(400);`);
  await b.shot(join(OUT, '07-desktop-integrations-muster-server.png'));
  await b.eval(`${H} const panel = document.querySelector('.muster-server-panel');
    await setVal(panel.querySelector('input[type=url]'), 'https://muster.example.com');
    await setVal(panel.querySelector('input[autocomplete=username]'), 'olivia');
    await setVal(panel.querySelector('input[type=password]'), 'not-a-real-password');
    byText('.muster-server-panel button', 'Connect').click(); await w(800);
    (await until(() => byText('.muster-server-panel button', 'Show projects'))).click(); await w(800);
    all('h3').find(h => txt(h) === 'Muster Server').scrollIntoView({ block: 'start' }); await w(300);`);
  await b.shot(join(OUT, '08-desktop-integrations-connected.png'));
  const errors = b.console.filter(l => l.startsWith('EXCEPTION'));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('desktop panel screenshots written to', OUT);
} finally { await b.close(); server.close(); }
