// #843: the in-app browser fills a sign-in form from the person's own 1Password, as a user action only. A fake `op`
// CLI stands in for 1Password (never the real one); a real headless Chrome shows a test sign-in page and runs the real
// fill and agent-tool scripts. The agent must never read the filled password, and nothing keeps a copy.
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {createBrowserPasswords, type PasswordFillTarget} from '../src/main/browser-passwords.ts';
import {BrowserWorkspaceController} from '../src/main/browser-workspace.ts';
import {BrowserSessionVault} from '../src/main/browser-session-vault.ts';
import {runBrowserTool, type AgentBrowserHost, type AgentPage} from '../src/main/agent-tools/browser-actions.ts';
import {BROWSER_TOOL_NAMES, BROWSER_TOOL_SPECS} from '../src/main/agent-tools/browser-tools.ts';
import {BrowserBridge} from '../src/main/agent-tools/browser-bridge.ts';
import type {BrowserEvent} from '../src/shared/browser-protocol.ts';

const SECRET = 'Pw-843-s3cret-marker!';
const id = (c: string) => c.repeat(26);
const VAULT = id('v');
const ITEMS = [
  {id: id('a'), title: 'Example', vault: {id: VAULT, name: 'Personal'}, category: 'LOGIN', additional_information: 'ada@example.test', urls: [{primary: true, href: 'https://example.test/'}], username: 'ada@example.test'},
  {id: id('b'), title: 'Example accounts', vault: {id: VAULT, name: 'Personal'}, category: 'LOGIN', additional_information: 'bob@example.test', urls: [{href: 'https://accounts.example.test/signin'}], username: 'bob@example.test'},
  {id: id('c'), title: 'Look-alike', vault: {id: VAULT, name: 'Personal'}, category: 'LOGIN', additional_information: 'eve', urls: [{href: 'https://example.test.evil.invalid/'}], username: 'eve'},
  {id: id('d'), title: 'Other site', vault: {id: VAULT, name: 'Work'}, category: 'LOGIN', additional_information: 'other', urls: [{href: 'other.invalid'}], username: 'other'},
];
const work = mkdtempSync(path.join(tmpdir(), 'muster-843-'));
const log = path.join(work, 'op-log.jsonl'), fakeOp = path.join(work, 'op');
// The fake `op`: logs its arguments, answers `item list` and `item get` like 1Password CLI 2, can be slowed down.
writeFileSync(fakeOp, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const items = ${JSON.stringify(ITEMS)};
const secret = ${JSON.stringify(SECRET)};
const done = text => setTimeout(() => process.stdout.write(text), Number(process.env.FAKE_OP_DELAY_MS || 0));
if (args[0] === 'item' && args[1] === 'list') done(JSON.stringify(items.map(({username, ...item}) => item)));
else if (args[0] === 'item' && args[1] === 'get') {
  const item = items.find(entry => entry.id === args[2]);
  if (!item) { process.stderr.write('[ERROR] "' + args[2] + '" isn\\'t an item.\\n'); process.exit(1); }
  const {username, additional_information, ...rest} = item;
  done(JSON.stringify({...rest, fields: [
    {id: 'username', type: 'STRING', purpose: 'USERNAME', label: 'username', value: username},
    {id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: secret},
    {id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: ''}]}));
} else { process.stderr.write('unknown command\\n'); process.exit(2); }
`, {mode: 0o700});
const opCalls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const resetLog = () => rmSync(log, {force: true});
const passwords = () => createBrowserPasswords({onePassword: () => fakeOp});

// ── Real headless Chrome, as in agent-cursor.test.ts: the real scripts run against a real DOM ─────────────────────
const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((value): value is string => !!value);
const chromePath = candidates.find(candidate => existsSync(candidate));
const skip = !chromePath && !process.env.CI ? 'Chrome is not installed' : false;
const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body style="font:14px system-ui">
<h1>Sign in to Example</h1>
<form id="login"><label for="email">Email</label> <input id="email" type="email" name="email" autocomplete="username">
<label for="pw">Password</label> <input id="pw" type="password" name="password" autocomplete="current-password">
<button type="button" id="show" onclick="pw.type = pw.type === 'password' ? 'text' : 'password'">Show password</button>
<button type="submit">Sign in</button></form>
<form id="other" style="margin-top:20px"><input id="bare" type="password"></form>
<script>
  globalThis.inputs = [];
  for (const id of ['email', 'pw']) document.getElementById(id).addEventListener('input', event => inputs.push({id, trusted: event.isTrusted}));
  document.getElementById('bare').value = 'page-own-hidden-value';
</script></body></html>`;
const EMPTY_PAGE = `<!doctype html><html><body><h1>No form here</h1><input id="search" type="search" aria-label="Search"></body></html>`;

let chrome: ChildProcess | undefined, socket: WebSocket | undefined, profile = '', sequence = 0;
const pending = new Map<number, (message: {result?: any; error?: unknown}) => void>();
const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const n = ++sequence;
  pending.set(n, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
  socket!.send(JSON.stringify({id: n, method, params}));
});
async function evaluate(code: string): Promise<unknown> {
  const reply = await cdp('Runtime.evaluate', {expression: code, awaitPromise: true, returnByValue: true});
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? 'script failed');
  return reply.result.value;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function show(html: string): Promise<void> {
  await cdp('Page.navigate', {url: `data:text/html,${encodeURIComponent(html)}`});
  for (let i = 0; i < 100 && await evaluate('document.readyState').catch(() => '') !== 'complete'; i++) await sleep(20);
}
/** Electron's WebContents as the fill and the agent tools use it, backed by CDP; the address is what main would see. */
function chromeTarget(url: () => string, typed: string[] = []): PasswordFillTarget & AgentPage['contents'] {
  return {
    getURL: url,
    executeJavaScriptInIsolatedWorld: (_world, scripts) => evaluate(scripts[0]!.code),
    insertText: async text => { typed.push(text); await cdp('Input.insertText', {text}); },
    sendInputEvent() {},
    isLoading: () => false,
    getZoomFactor: () => 1,
  };
}
function agentHost(contents: AgentPage['contents'], onShot?: () => Promise<void>): AgentBrowserHost {
  const page: AgentPage = {attached: false, fill: false, contents, state: () => ({url: 'https://example.test/login', title: 'Sign in'} as never)};
  return {has: () => true, open: () => page.state(), page: () => page, back: () => page.state(), reload: () => page.state(), console: () => [],
    async screenshot() { await onShot?.(); const shot = await cdp('Page.captureScreenshot', {format: 'png'}); return {dataUrl: `data:image/png;base64,${shot.data}`, width: 800, height: 600}; }};
}

before(async () => {
  if (skip) return;
  assert.ok(chromePath, 'CI needs Chrome for the password fill workflow (set CHROME_PATH)');
  profile = mkdtempSync(path.join(tmpdir(), 'muster-843-chrome-'));
  chrome = spawn(chromePath!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=800,600', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
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
  rmSync(work, {recursive: true, force: true});
});

// Spec: MUS-SPEC-09-843A (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843a)
test('the key menu offers only logins saved for this site, never their passwords', async () => {
  resetLog();
  const secure = await passwords().logins('https://app.example.test/login');
  assert.equal(secure.available, true);
  assert.deepEqual(secure.logins.map(login => login.title), ['Example'], 'the site login covers its subdomains; look-alike and other sites are left out');
  assert.deepEqual(secure.logins[0], {id: id('a'), vault: VAULT, title: 'Example', username: 'ada@example.test', site: 'example.test'});
  assert.deepEqual((await passwords().logins('https://accounts.example.test/x')).logins.map(login => login.title).sort(), ['Example', 'Example accounts']);
  assert.deepEqual((await passwords().logins('http://example.test/login')).logins, [], 'an https login is never offered on an http page');
  assert.deepEqual((await passwords().logins('https://other.invalid/')).logins.map(login => login.title), ['Other site'], 'a saved address without a scheme is read as https');
  assert.ok(!JSON.stringify(secure).includes(SECRET));
  assert.deepEqual(opCalls()[0], ['item', 'list', '--categories', 'Login', '--format', 'json']);
  assert.ok(opCalls().every(args => args[1] === 'list'), 'listing never reads an item');
  const missing = await createBrowserPasswords({onePassword: () => undefined}).logins('https://example.test/');
  assert.equal(missing.available, false);
  assert.match(missing.message ?? '', /1Password CLI/);
  await assert.rejects(passwords().logins('file:///etc/passwd'), /web page/);
});

// Spec: MUS-SPEC-09-843B (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843b)
test('choosing a login fills the sign-in form from 1Password', {skip}, async () => {
  await show(LOGIN_PAGE); resetLog();
  const result = await passwords().fill(chromeTarget(() => 'https://example.test/login'), {id: id('a'), vault: VAULT});
  assert.deepEqual(result, {title: 'Example', filled: 'login'});
  assert.equal(await evaluate('document.getElementById("email").value'), 'ada@example.test');
  assert.equal(await evaluate('document.getElementById("pw").value'), SECRET);
  assert.equal(await evaluate('document.getElementById("bare").value'), 'page-own-hidden-value', 'the other form is left alone');
  const inputs = await evaluate('inputs') as {id: string; trusted: boolean}[];
  assert.ok(inputs.some(row => row.id === 'email' && row.trusted) && inputs.some(row => row.id === 'pw' && row.trusted), 'the page saw trusted input events in both fields');
  assert.deepEqual(opCalls(), [['item', 'get', id('a'), '--vault', VAULT, '--format', 'json']]);
  resetLog();
  for (const bad of ['--reveal', 'AAAAAAAAAAAAAAAAAAAAAAAAAA', id('a') + ' --account x', '', 42])
    await assert.rejects(passwords().fill(chromeTarget(() => 'https://example.test/login'), {id: bad, vault: VAULT}), /not a 1Password login/);
  await assert.rejects(passwords().fill(chromeTarget(() => 'https://example.test/login'), {id: id('a'), vault: '../x'}), /not a 1Password login/);
  assert.deepEqual(opCalls(), [], 'a malformed id never runs op');
});

// Spec: MUS-SPEC-09-843C (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843c)
test('after a fill the agent never reads the password: snapshot, typing and screenshot stay masked', {skip}, async () => {
  await show(LOGIN_PAGE);
  const contents = chromeTarget(() => 'https://example.test/login');
  await passwords().fill(contents, {id: id('a'), vault: VAULT});
  const masked: string[] = [];
  const host = agentHost(contents, async () => { masked.push(String(await evaluate('getComputedStyle(document.getElementById("pw")).webkitTextSecurity'))); });
  const call = async (tool: string, args: Record<string, unknown> = {}) => JSON.stringify((await runBrowserTool(host, tool, args, {readOnly: false})).result);
  const first = await call('browser_snapshot');
  assert.match(first, /Password[^\n]*value=\\"••••••\\"/);
  assert.match(first, /ada@example\.test/, 'the username is not a secret');
  await call('browser_click', {selector: '#show'});
  assert.equal(await evaluate('document.getElementById("pw").type'), 'text', 'the page revealed the field');
  const revealed = await call('browser_snapshot');
  const typed = await call('browser_type', {selector: '#email', text: 'x'});
  const shot = await runBrowserTool(host, 'browser_screenshot', {}, {readOnly: false});
  for (const text of [first, revealed, typed, JSON.stringify(shot.result.content.filter(part => part.type === 'text'))]) { assert.ok(!text.includes(SECRET), 'no agent reply holds the filled password'); assert.ok(!text.replace(/data:text\/html[^ "\\]*/g, '').includes('page-own-hidden-value'), 'an unlabeled password field is not named by its value'); }
  assert.match(revealed, /value=\\"••••••\\"/);
  assert.deepEqual(masked, ['disc'], 'the revealed field is drawn as dots while the agent screenshot is taken');
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("pw")).webkitTextSecurity'), 'disc', 'and reads as the page made it afterwards');
});

// Spec: MUS-SPEC-09-843D (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843d)
test('a fill is refused when the login is for another site or the page changed meanwhile', {skip}, async () => {
  await show(LOGIN_PAGE);
  const typed: string[] = [];
  await assert.rejects(passwords().fill(chromeTarget(() => 'https://example.test/login', typed), {id: id('d'), vault: VAULT}), /not saved for example\.test/);
  let address = 'https://example.test/login';
  process.env.FAKE_OP_DELAY_MS = '300';
  const slow = passwords().fill(chromeTarget(() => address, typed), {id: id('a'), vault: VAULT});
  setTimeout(() => { address = 'https://evil.invalid/'; }, 100);
  await assert.rejects(slow, /page changed/);
  delete process.env.FAKE_OP_DELAY_MS;
  // The page moves to another origin as soon as the username is typed: the password must never follow it there.
  address = 'https://example.test/login';
  const moved: string[] = [], hop = chromeTarget(() => address, moved);
  const typeOne = hop.insertText.bind(hop);
  hop.insertText = async text => { await typeOne(text); address = 'https://evil.invalid/'; };
  await assert.rejects(passwords().fill(hop, {id: id('a'), vault: VAULT}), /page changed/);
  assert.deepEqual(moved, ['ada@example.test'], 'only the username was typed');
  await show(EMPTY_PAGE);
  await assert.rejects(passwords().fill(chromeTarget(() => 'https://example.test/login', typed), {id: id('a'), vault: VAULT}), /No sign-in form/);
  assert.deepEqual(typed, [], 'nothing was typed into any page');
  assert.equal(await evaluate('document.getElementById("search").value'), '');
});

// Spec: MUS-SPEC-09-843G (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843g)
test('a value is typed only into the field focused for it; focus moved by the page stops the fill', {skip}, async () => {
  const page = LOGIN_PAGE.replace('<form id="other"', '<label for="notes">Notes</label> <input id="notes" type="text" name="notes"><form id="other"');
  // The page moves focus to Notes in the gap between the fill focusing a field and the value arriving.
  const stealing = (when: string) => { const target = chromeTarget(() => 'https://example.test/login'), type = target.insertText.bind(target); let n = 0;
    target.insertText = async text => { if (String(++n) === when) await evaluate('document.getElementById("notes").focus()'); await type(text); }; return target; };
  await show(page);
  await assert.rejects(passwords().fill(stealing('2'), {id: id('a'), vault: VAULT}), /page changed during the fill/);
  assert.equal(await evaluate('document.getElementById("notes").value'), '', 'the password never lands in the field the page moved focus to');
  assert.equal(await evaluate('document.getElementById("pw").value'), '');
  assert.equal(await evaluate('document.getElementById("email").value'), 'ada@example.test', 'the username typed before the change stays');
  // A field that took (even cancelled) input while the password was typed is a secret for the agent from then on.
  await evaluate('document.getElementById("notes").value = "notes-843-visible"');
  const marked = JSON.stringify((await runBrowserTool(agentHost(chromeTarget(() => 'https://example.test/login')), 'browser_snapshot', {}, {readOnly: false})).result);
  assert.match(marked, /Notes\\" \[ref=e\d+\] value=\\"••••••\\"/, 'the Notes field reads as dots');
  assert.ok(!marked.includes('notes-843-visible'));
  await show(page);
  await assert.rejects(passwords().fill(stealing('1'), {id: id('a'), vault: VAULT}), /page changed during the fill/);
  assert.equal(await evaluate('document.getElementById("notes").value'), '');
  assert.equal(await evaluate('document.getElementById("email").value'), '');
  assert.equal(await evaluate('document.getElementById("pw").value'), '', 'nothing is typed after the page changed');
  const snapshot = JSON.stringify((await runBrowserTool(agentHost(chromeTarget(() => 'https://example.test/login')), 'browser_snapshot', {}, {readOnly: false})).result);
  assert.ok(!snapshot.includes(SECRET));
});

/** A workspace with fake views whose history entries carry Chromium page state (form values). */
class Contents extends EventEmitter {
  destroyed = false; loading = false; title = 'Sign in'; url = 'about:blank'; typed: string[] = []; scripts: string[] = [];
  entries: {url: string; title: string; pageState?: string}[] = []; index = -1;
  navigationHistory = {canGoBack: () => false, canGoForward: () => false, getAllEntries: () => this.entries.map(entry => ({...entry})), getActiveIndex: () => this.index};
  loadURL(url: string) { this.url = url; this.entries.push({url, title: 'Sign in', pageState: `form:${SECRET}`}); this.index++; this.emit('did-start-navigation', {}, url, false, true); return Promise.resolve(); }
  executeJavaScriptInIsolatedWorld(_world: number, scripts: {code: string}[]) { this.scripts.push(scripts[0]!.code); return Promise.resolve({ok: true, username: true, password: true}); }
  insertText(text: string) { this.typed.push(text); return Promise.resolve(); }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; } getTitle() { return this.title; } isLoading() { return this.loading; } getZoomFactor() { return 1; }
  setAudioMuted() {} setBackgroundThrottling() {} setWindowOpenHandler() {} reload() {} stop() {} close() { this.destroyed = true; this.emit('destroyed'); }
}
class View { webContents = new Contents(); setVisible() {} setBackgroundColor() {} setBounds() {} }
class Session extends EventEmitter { setPermissionRequestHandler() {} setPermissionCheckHandler() {} setDevicePermissionHandler() {} setDisplayMediaRequestHandler() {} }
function filesUnder(dir: string): string[] { return readdirSync(dir).flatMap(name => { const file = path.join(dir, name); return statSync(file).isDirectory() ? filesUnder(file) : [file]; }); }

// Spec: MUS-SPEC-09-843E (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843e)
test('a fill leaves no password in events, saved history, files or agent tools', async () => {
  const data = mkdtempSync(path.join(work, 'data-'));
  const window = Object.assign(new EventEmitter(), {webContents: new Contents(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getContentSize: () => [1000, 800], contentView: {addChildView() {}, removeChildView() {}}});
  const views: View[] = [], events: BrowserEvent[] = [], session = new Session();
  const identity = {isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString()};
  const controller = new BrowserWorkspaceController(window as never, event => events.push(event), {
    createView() { const view = new View(); views.push(view); return view as never; }, getSession() { return session as never; },
  }, {vault: new BrowserSessionVault(path.join(data, 'browser-sessions.json'), () => identity), passwords: passwords(), sweepIntervalMs: 3_600_000});
  controller.open({owner: 'browser:login', profileId: 'personal', surfaceId: 'mount', url: 'https://example.test/login'});
  const logins = await controller.passwordLogins('browser:login');
  assert.deepEqual(logins.logins.map(login => login.id), [id('a')]);
  const reply = await controller.fillLogin({owner: 'browser:login', id: id('a'), vault: VAULT});
  assert.deepEqual(reply, {title: 'Example', filled: 'login'});
  assert.deepEqual(views[0]!.webContents.typed, ['ada@example.test', SECRET], 'the password reaches the page only');
  assert.ok(!views[0]!.webContents.scripts.some(code => code.includes(SECRET)), 'it is typed, never embedded in a script');
  controller.persistSessions();
  const saved = controller.sessions();
  assert.equal(saved.length, 1);
  assert.ok(saved[0]!.history?.entries.every(entry => entry.pageState === undefined), 'a filled tab keeps no form state in its saved history');
  for (const text of [JSON.stringify(events), JSON.stringify(reply), JSON.stringify(logins), JSON.stringify(saved), ...filesUnder(work).map(file => readFileSync(file, 'utf8'))])
    assert.ok(!text.includes(SECRET) || text.includes('const secret ='), 'no event, reply, saved session or file holds the password');
  // Agents have no way to ask for a fill.
  assert.ok(![...BROWSER_TOOL_NAMES].some(name => /fill|login|password|secret|credential/i.test(name)));
  assert.ok(!BROWSER_TOOL_SPECS.some(spec => /1password|password manager|fill.*login/i.test(JSON.stringify(spec))));
  const bridge = new BrowserBridge({dir: path.join(data, 'bridge'), browser: controller as never, snapshot: async () => ({chats: []}) as never, lease: async () => 'agent' as never, emit() {}, execPath: process.execPath, script: ''});
  const refused = await bridge.call('chat', 'browser_fill_login', {id: id('a'), vault: VAULT});
  assert.equal(refused.isError, true);
  assert.equal(views[0]!.webContents.typed.length, 2, 'the refused agent call typed nothing');
  controller.dispose();
});
