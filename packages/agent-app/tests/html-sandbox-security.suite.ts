/** #html-preview, real browser: an agent page served exactly as Muster serves it (the report origin's CSP and headers, the
 *  themed bootstrap) inside the exact frame Muster uses (`sandbox="allow-scripts"`, no same-origin, no-referrer, allow="").
 *  The page attacks its parent, the app bridge (IPC), storage, file:, the local network, navigation, popups, forms, workers
 *  and eval; every attempt must fail, and the server must see none of its requests. Headless Chrome over CDP; skipped when no
 *  Chrome is installed. Named .suite so `npm test`'s *.test.ts glob skips it (tests/run-html-sandbox-security.mjs runs it). */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
// @ts-expect-error: a plain .mjs helper shared with the screenshot harness.
import {chromePath, launchChrome} from '../scripts/html-harness/cdp.mjs';
import {ReportRegistry} from '../src/main/report-origin.ts';

const ATTACK = `<!doctype html><html><head><title>probe</title></head><body><h1 style="color:var(--foreground)">probe</h1><form id="f" action="/form-hit" method="post"><input name="x" value="1"></form><script>
(async () => {
  const results = {};
  const attempt = async (name, run) => { try { const value = await run(); results[name] = 'reached:' + String(value).slice(0, 80); } catch (error) { results[name] = 'blocked:' + (error && error.name || 'Error'); } };
  await attempt('parentDocument', () => parent.document.title);
  await attempt('topDocument', () => top.document.body.innerHTML.length);
  await attempt('parentBridge', () => { const bridge = parent.muster; if (!bridge) throw new TypeError('no bridge'); return bridge.invoke('chat.send', {text: 'pwned'}); });
  await attempt('parentLocalStorage', () => parent.localStorage.getItem('secret'));
  await attempt('ownLocalStorage', () => localStorage.getItem('x'));
  await attempt('cookie', () => { document.cookie = 'a=1'; return document.cookie || (() => { throw new Error('empty'); })(); });
  await attempt('fileFetch', () => fetch('file:///etc/hosts').then(r => r.text()));
  await attempt('localFetch', () => fetch(location.protocol === 'http:' ? '/secret' : 'http://127.0.0.1:' + PORT + '/secret').then(r => r.status));
  await attempt('absoluteLocalFetch', () => fetch('http://127.0.0.1:' + PORT + '/secret2').then(r => r.status));
  await attempt('xhr', () => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:' + PORT + '/secret3'); x.onload = () => resolve(x.status); x.onerror = () => reject(new TypeError('network')); x.send(); }));
  await attempt('image', () => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => reject(new Error('img')); i.src = 'http://127.0.0.1:' + PORT + '/pixel.png'; }));
  await attempt('websocket', () => new Promise((resolve, reject) => { const s = new WebSocket('ws://127.0.0.1:' + PORT + '/ws'); s.onopen = () => resolve('open'); s.onerror = () => reject(new Error('ws')); }));
  await attempt('topNavigation', () => { top.location.href = 'http://127.0.0.1:' + PORT + '/navigated'; return 'assigned'; });
  await attempt('popup', () => { const w = window.open('http://127.0.0.1:' + PORT + '/popup'); if (!w) throw new Error('null'); return 'opened'; });
  await attempt('form', () => { document.getElementById('f').submit(); return 'submitted'; });
  await attempt('worker', () => new Promise((resolve, reject) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(location.href)'], {type: 'text/javascript'}))); w.onmessage = e => resolve('ran ' + e.data); w.onerror = () => reject(new Error('worker')); setTimeout(() => reject(new Error('timeout')), 800); }));
  await attempt('eval', () => eval('1 + 1'));
  await attempt('nestedFrame', () => new Promise((resolve, reject) => { const f = document.createElement('iframe'); f.src = 'http://127.0.0.1:' + PORT + '/frame'; f.onload = () => { try { if (f.contentDocument && f.contentDocument.title === 'leak') resolve('leak'); else reject(new Error('blocked')); } catch (e) { reject(e); } }; document.body.appendChild(f); setTimeout(() => reject(new Error('timeout')), 800); }));
  await attempt('origin', () => { if (origin !== 'null') return origin; throw new Error('opaque'); });
  parent.postMessage({muster: 'probe', results}, '*');
})();
</script></body></html>`;

test('an agent page in Muster\'s sandbox cannot reach the app, IPC, storage, file: or the network', {skip: !chromePath() && 'no Chrome installed'}, async () => {
  const registry = new ReportRegistry();
  const hits: string[] = [];
  let port = 0;
  const pages = new Map<string, {html: string; network: boolean}>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      response.writeHead(200, {'content-type': 'text/html'});
      // The app window: a bridge object like the preload's, a secret in storage, and the frame exactly as SandboxedHtml renders it.
      response.end(`<!doctype html><title>Muster</title><body><script>window.muster={invoke(){window.__bridgeCalled=true;return Promise.resolve('ok')}};localStorage.setItem('secret','s3cret');addEventListener('message',e=>{if(e.data&&e.data.muster==='probe')document.body.dataset.results=JSON.stringify(e.data.results)});</script>
        <iframe id="frame" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" src="/report/${url.searchParams.get('page')}/index.html"></iframe></body>`);
      return;
    }
    const match = /^\/report\/([a-z0-9]+)\/index\.html$/.exec(url.pathname);
    if (match && pages.has(match[1]!)) {
      const page = pages.get(match[1]!)!;
      // Served by the real registry: the same body and headers as the muster-report:// protocol handler.
      const {url: reportUrl} = registry.register({html: page.html.replaceAll('PORT', String(port)), themed: true, network: page.network});
      const served = registry.respond(reportUrl);
      response.writeHead(served.status, served.headers); response.end(served.body);
      return;
    }
    // The app window's own favicon request is not the page's.
    if (url.pathname !== '/favicon.ico') hits.push(url.pathname);
    response.writeHead(200, {'content-type': 'text/html', 'access-control-allow-origin': '*'}); response.end('<title>leak</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as {port: number}).port;
  pages.set('local', {html: ATTACK, network: false});
  pages.set('net', {html: ATTACK, network: true});
  const chrome = await launchChrome();
  try {
    for (const name of ['local', 'net']) {
      hits.length = 0;
      await chrome.navigate(`http://127.0.0.1:${port}/?page=${name}`, 'Boolean(document.body && document.body.dataset.results)');
      const results = JSON.parse(await chrome.evaluate('document.body.dataset.results')) as Record<string, string>;
      await new Promise(resolve => setTimeout(resolve, 400));
      // form.submit() returns quietly in a sandbox without allow-forms; that it went nowhere is checked below (no /form-hit request).
      for (const [attempt, outcome] of Object.entries(results)) if (attempt !== 'form') assert.match(outcome, /^blocked:/, `${name}: ${attempt} must be blocked, was ${outcome}`);
      assert.equal(Object.keys(results).length, 19, 'every attempt ran');
      assert.equal(await chrome.evaluate('Boolean(window.__bridgeCalled)'), false, `${name}: the app bridge was never called`);
      assert.equal(await chrome.evaluate('location.pathname'), '/', `${name}: the app window was not navigated`);
      assert.deepEqual(hits, [], `${name}: the server saw no request from the page (even with network allowed, http: and ws: stay blocked)`);
    }
  } finally {
    chrome.close();
    server.close();
  }
});
