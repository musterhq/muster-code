// The agent's visible cursor in the browser the person watches (#721): it glides to what it is about to press, the
// press lands under it, a field it types into is ringed, it fades once the agent is quiet, the model's own screenshots
// never contain it, a page nobody is watching pays nothing, and Reduce motion turns glides into jumps.
// Real headless Chrome drives the real browser tool code; only Electron's WebContents is swapped for CDP.
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {runBrowserTool, type AgentBrowserHost, type AgentPage} from '../src/main/agent-tools/browser-actions.ts';
import {CURSOR_FADE_MS, CURSOR_IDLE_MS, CURSOR_MAX_GLIDE_MS, CURSOR_MIN_GLIDE_MS, cursorDebugScript} from '../src/main/agent-tools/agent-cursor.ts';

const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].filter((value): value is string => !!value);
const chromePath = candidates.find(candidate => existsSync(candidate));
const skip = !chromePath && !process.env.CI ? 'Chrome is not installed' : false;

const PAGE = `<!doctype html><html><body style="margin:0;font:14px system-ui">
<button id="near" style="position:absolute;left:60px;top:60px;width:120px;height:36px">Near</button>
<button id="far" style="position:absolute;left:700px;top:520px;width:120px;height:36px">Far</button>
<input id="name" aria-label="Name" style="position:absolute;left:300px;top:300px;width:240px;height:30px;border-radius:8px">
<script>
  globalThis.presses = [];
  for (const id of ['near', 'far']) document.getElementById(id).addEventListener('click', event => {
    presses.push({id, x: event.clientX, y: event.clientY, cursor: globalThis.__musterCursor?.debug() ?? null, at: performance.now()});
  });
</script></body></html>`;

let chrome: ChildProcess | undefined, socket: WebSocket | undefined, profile = '';
let sequence = 0;
const pending = new Map<number, (message: {result?: any; error?: unknown}) => void>();
const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
  socket!.send(JSON.stringify({id, method, params}));
});
async function evaluate(code: string): Promise<unknown> {
  const reply = await cdp('Runtime.evaluate', {expression: code, awaitPromise: true, returnByValue: true});
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? 'script failed');
  return reply.result.value;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const debug = () => evaluate(cursorDebugScript) as Promise<{x: number; y: number; opacity: number; ring: number; label: string; glideMs: number; hidden: boolean; mounted: boolean} | null>;

function host(watched: boolean, onShot?: () => Promise<void>): AgentBrowserHost {
  const page: AgentPage = {
    attached: watched, fill: watched, state: () => ({url: 'about:blank', title: 'Fixture'} as never),
    contents: {
      executeJavaScriptInIsolatedWorld: (_world, scripts) => evaluate(scripts[0]!.code),
      sendInputEvent(event: any) {
        const type = event.type === 'mouseDown' ? 'mousePressed' : event.type === 'mouseUp' ? 'mouseReleased' : event.type === 'mouseMove' ? 'mouseMoved' : '';
        if (type) void cdp('Input.dispatchMouseEvent', {type, x: event.x, y: event.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: event.clickCount ?? 0});
      },
      insertText: text => cdp('Input.insertText', {text}),
      isLoading: () => false,
      getZoomFactor: () => 1,
    },
  };
  return {has: () => true, open: () => page.state(), page: () => page, back: () => page.state(), reload: () => page.state(), console: () => [],
    async screenshot() { await onShot?.(); const shot = await cdp('Page.captureScreenshot', {format: 'png'}); return {dataUrl: `data:image/png;base64,${shot.data}`, width: 1000, height: 700}; }};
}
async function freshPage(): Promise<void> {
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}]});
  await cdp('Page.navigate', {url: `data:text/html,${encodeURIComponent(PAGE)}`});
  for (let i = 0; i < 100 && await evaluate('document.readyState').catch(() => '') !== 'complete'; i++) await sleep(20);
}
const call = (target: AgentBrowserHost, tool: string, args: Record<string, unknown>) => runBrowserTool(target, tool, args, {readOnly: false});

before(async () => {
  if (skip) return;
  assert.ok(chromePath, 'CI needs Chrome for the agent cursor workflow (set CHROME_PATH)');
  profile = mkdtempSync(path.join(tmpdir(), 'muster-cursor-'));
  chrome = spawn(chromePath!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1000,700', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  const endpoint = await new Promise<string>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20_000);
    chrome!.stderr!.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]!); } });
  });
  const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json() as {type: string; webSocketDebuggerUrl: string}[];
  socket = new WebSocket(pages.find(page => page.type === 'page')!.webSocketDebuggerUrl);
  await new Promise(resolve => socket!.addEventListener('open', resolve, {once: true}));
  socket.addEventListener('message', event => { const message = JSON.parse(String(event.data)); const reply = typeof message.id === 'number' && pending.has(message.id) ? pending.get(message.id) : undefined; if (typeof reply === 'function') { pending.delete(message.id); reply(message); } });
  await cdp('Page.enable');
});
after(async () => {
  socket?.close();
  if (chrome) { chrome.kill(); await new Promise(resolve => chrome!.once('exit', resolve)); }
  if (profile) rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
});

// Spec: MUS-SPEC-09-721A (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-721a)
test('the agent cursor glides to a button and the press lands under it', {skip}, async () => {
  await freshPage();
  const page = host(true);
  await call(page, 'browser_snapshot', {});
  await call(page, 'browser_click', {selector: '#near'});
  let presses = await evaluate('presses') as {id: string; x: number; y: number; cursor: {x: number; y: number; opacity: number} | null}[];
  assert.equal(presses.length, 1, 'the button was pressed once');
  assert.ok(presses[0]!.cursor, 'the cursor was on the page when the press arrived');
  assert.deepEqual([presses[0]!.cursor!.x, presses[0]!.cursor!.y], [120, 78], 'the cursor sits on the centre of the button');
  assert.deepEqual([presses[0]!.x, presses[0]!.y], [120, 78], 'the press landed where the cursor is');
  assert.equal(presses[0]!.cursor!.opacity, 1, 'the cursor is fully visible while it acts');

  await call(page, 'browser_click', {selector: '#far'});
  const travel = (await debug())!.glideMs;
  presses = await evaluate('presses') as typeof presses;
  assert.deepEqual([presses[1]!.cursor!.x, presses[1]!.cursor!.y], [760, 538], 'the cursor travelled to the far button before pressing');
  assert.ok(travel >= CURSOR_MIN_GLIDE_MS, `a long move is animated, not a jump (${travel} ms)`);
  assert.ok(travel <= CURSOR_MAX_GLIDE_MS, `the glide stays short enough not to slow the agent down (${travel} ms)`);
  assert.equal((await debug())!.label, 'Muster', 'the cursor carries its name');
});

// Spec: MUS-SPEC-09-721B (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-721b)
test('typing rings the field, and the cursor fades once the agent goes quiet, then returns where it was', {skip}, async () => {
  await freshPage();
  const page = host(true);
  await call(page, 'browser_snapshot', {});
  await call(page, 'browser_type', {selector: '#name', text: 'Ada'});
  assert.equal(await evaluate('document.getElementById("name").value'), 'Ada');
  let state = (await debug())!;
  assert.equal(state.ring, 1, 'the field being typed into is ringed');
  assert.equal(state.opacity, 1);
  assert.ok(state.x >= 300 && state.x <= 540 && state.y >= 300 && state.y <= 330, 'the cursor rests inside the field');
  await sleep(CURSOR_IDLE_MS + CURSOR_FADE_MS + 250);
  state = (await debug())!;
  assert.equal(state.opacity, 0, 'the cursor has faded out while the agent is quiet');
  assert.equal(state.ring, 0, 'the ring fades with it');
  const resting = [state.x, state.y];
  await call(page, 'browser_click', {selector: '#near'});
  const presses = await evaluate('presses') as {cursor: {opacity: number}}[];
  assert.equal(presses[0]!.cursor.opacity, 1, 'it is visible again before it acts');
  assert.notDeepEqual(resting, [120, 78]);
});

// Spec: MUS-SPEC-09-721C (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-721c)
test('the model never sees its own cursor, and a page nobody watches pays nothing', {skip}, async () => {
  await freshPage();
  let duringShot: {hidden: boolean} | null = null;
  const page = host(true, async () => { duringShot = await debug(); });
  await call(page, 'browser_snapshot', {});
  await call(page, 'browser_click', {selector: '#near'});
  await call(page, 'browser_screenshot', {});
  assert.equal(duringShot!.hidden, true, 'the cursor is hidden while the model screenshot is taken');
  assert.equal((await debug())!.hidden, false, 'and shown again right after');

  await freshPage();
  const unwatched = host(false);
  await call(unwatched, 'browser_snapshot', {});
  await call(unwatched, 'browser_click', {selector: '#near'});
  assert.equal(await evaluate('presses.length'), 1, 'the press still happens');
  assert.equal(await debug(), null, 'no cursor is drawn in a page nobody can see');
});

// Spec: MUS-SPEC-09-721D (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-721d)
test('with Reduce motion on, the cursor jumps instead of gliding', {skip}, async () => {
  await freshPage();
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  const page = host(true);
  await call(page, 'browser_snapshot', {});
  await call(page, 'browser_click', {selector: '#near'});
  await call(page, 'browser_click', {selector: '#far'});
  const presses = await evaluate('presses') as {cursor: {x: number; y: number}}[];
  assert.deepEqual([presses[1]!.cursor.x, presses[1]!.cursor.y], [760, 538]);
  assert.equal((await debug())!.glideMs, 0, 'no glide when Reduce motion is on');
});
