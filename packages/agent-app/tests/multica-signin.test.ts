/** Signing in to a Multica server on its own page (#894), the way Multica's command-line tool does: Muster listens on 127.0.0.1, opens
 *  Multica's `/login?cli_callback=…&cli_state=…`, takes the sign-in token Multica's page sends back, swaps it for a personal access token
 *  (`POST /api/tokens`), checks it with `/api/me` and stores it where a pasted token goes. Each test drives the runtime's own command
 *  handlers against a fake Multica server on loopback (tests/fixtures/multica-fake-server.ts); a stand-in for the sign-in window opens the
 *  page with fetch and follows the redirects. The main-process window is tested with Electron faked. Nothing here talks to a real Multica. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createMusterServerDomain } from '../src/runtime/domains/muster-server.ts';
import { createPaperclipDomain } from '../src/runtime/domains/paperclip.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { PaperclipConfigView, PaperclipSignInState } from '../src/shared/domains/paperclip-protocol.ts';
import type { MusterServerEntryView } from '../src/shared/domains/muster-server-protocol.ts';
import { ServerSignInWindows, type SessionLike, type SignInRuntime, type WindowLike } from '../src/main/server-signin-window.ts';
import { sessionPartition } from '../src/runtime/server/session.ts';
import { startMulticaFake, type MulticaFake } from './fixtures/multica-fake-server.ts';

function secretsFake() { const values = new Map<string, string>(); return { values, store: { status: (id: string) => ({ stored: values.has(id), updatedAt: null, secureStorage: true }), get: (id: string) => values.get(id), set(id: string, v: string) { values.set(id, v); return this.status(id); }, clear(id: string) { values.delete(id); return this.status(id); } } }; }
async function home(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'muster-multica-signin-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })); return dir; }
async function fake(t: TestContext) { const f = await startMulticaFake(); t.after(() => f.close()); return f; }
function runtime(t: TestContext, dir: string, multicaSignIn: { timeoutMs?: number } = {}) {
  const secrets = secretsFake(), events: unknown[] = [];
  const ctx = { dataDir: dir, db: (() => { const memory = new DatabaseSync(':memory:'); return () => memory; })(), store: { snapshot: () => ({ folders: [] }) }, emit(event: unknown) { events.push(event); }, hooks: {}, async invoke(command: string) { if (command === 'mailbox.list') return { messages: [], unacked: 0, pending: 0 }; if (command === 'project.list') return []; if (command === 'memory.browse') return { records: [] }; throw new Error(`unexpected ${command}`); } } as unknown as DomainContext;
  const ms = createMusterServerDomain(ctx, { secrets: () => secrets.store as never });
  const pc = createPaperclipDomain(ctx, { secrets: () => secrets.store as never, multicaSignIn });
  t.after(() => { pc.dispose?.(); ms.dispose?.(); });
  /** Every answer a command gives, as the window would receive it. */
  const answers: unknown[] = [];
  const call = async <T>(command: string, input: Record<string, unknown> = {}) => { const out = await Promise.resolve().then(() => (ms.handlers[command] ?? pc.handlers[command])!(input as never)) as T; answers.push(out); return out; };
  return { secrets, events, answers, call };
}
type Runtime = ReturnType<typeof runtime>;
/** What Connect does on a Multica address in the desktop app: start the browser sign-in for it. */
const start = (r: Runtime, origin: string) => r.call<PaperclipSignInState>('paperclip.signin.start', { baseUrl: origin, serverId: 'new' });
/** The stand-in for the sign-in window: opens the page and follows every redirect, as the window does with Multica's own redirect. */
async function signInWindow(url: string) { const res = await fetch(url, { redirect: 'follow' }); return { status: res.status, url: res.url, text: await res.text() }; }
async function settled(r: Runtime, ms = 8000): Promise<PaperclipSignInState> {
  const until = Date.now() + ms;
  for (;;) { const s = await r.call<PaperclipSignInState>('paperclip.signin.status'); if (s.phase !== 'waiting' || Date.now() > until) return s; await new Promise(res => setTimeout(res, 50)); }
}
const callbackOf = (approvalUrl: string) => { const u = new URL(approvalUrl); return { callback: u.searchParams.get('cli_callback')!, state: u.searchParams.get('cli_state')! }; };
/** A sign-in token for the fake, as Multica's page would send it (its redirect read without following it). */
async function sessionFrom(f: MulticaFake, approvalUrl: string) { const res = await fetch(approvalUrl.replace(/^https?:\/\/[^/]+/, f.origin), { redirect: 'manual' }); return new URL(res.headers.get('location')!).searchParams.get('token')!; }
const refused = async (url: string) => { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return false; } catch { return true; } };

// Spec: MUS-SPEC-13-894A (docs/spec/clauses/13-muster-server.md#mus-spec-13-894a)
test('signing in on a Multica server’s own page connects it: the sign-in comes back to a loopback listener, is swapped for a personal access token and stored like a pasted one', { timeout: 30_000 }, async t => {
  const dir = await home(t), f = await fake(t), r = runtime(t, dir);
  const waiting = await start(r, f.origin);
  assert.equal(waiting.phase, 'waiting', waiting.message ?? 'sign-in started');
  const page = new URL(waiting.approvalUrl!);
  assert.equal(`${page.origin}${page.pathname}`, `${f.origin}/login`, 'the sign-in page is Multica’s own /login');
  const { callback, state } = callbackOf(waiting.approvalUrl!);
  assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'the callback is a loopback listener, which Multica’s own check accepts');
  assert.match(state, /^[0-9a-f]{32}$/, 'a random state');
  const shown = await signInWindow(waiting.approvalUrl!);
  assert.equal(shown.status, 200);
  assert.ok(shown.url.startsWith(callback), 'Multica’s redirect reached Muster’s listener');
  assert.match(shown.text, /signed in/i, 'the window says you are signed in');
  const done = await settled(r);
  assert.equal(done.phase, 'signed-in', done.message ?? 'sign-in complete');
  assert.deepEqual(done.user, { name: 'Dana Founder', email: 'dana@acme.example' });
  assert.equal(f.issued.length, 1, 'one personal access token was made');
  const [made] = f.issued;
  assert.match(made!.name, /^Muster Agent on \S/, 'named for Muster Agent on this computer');
  assert.equal(made!.expires_in_days, 90);
  assert.equal(made!.by, f.sessions[0], 'it was made with the sign-in token Multica sent back');
  assert.ok(f.calls.some(c => c.path === '/api/me' && c.auth === `Bearer ${made!.token}`), 'the new token was checked with /api/me');
  assert.deepEqual([...r.secrets.values.values()], [made!.token], 'the new token is the stored token; the sign-in token is stored nowhere');
  const config = await r.call<PaperclipConfigView>('paperclip.config.get');
  assert.deepEqual([config.mode, config.baseUrl, config.backend, config.hasToken, config.signedIn?.name], ['custom', f.origin, 'multica', true, 'Dana Founder']);
  const list = (await r.call<{ servers: MusterServerEntryView[] }>('musterServer.list')).servers;
  assert.deepEqual(list.map(s => [s.url, s.kind]), [[f.origin, 'multica']]);
  const probe = await r.call<{ ok: boolean; companies?: { name: string }[] }>('paperclip.test', {});
  assert.equal(probe.ok, true, 'the stored token reads the server');
  assert.deepEqual(probe.companies?.map(c => c.name), ['Acme', 'Lab']);
});

// Spec: MUS-SPEC-13-894B (docs/spec/clauses/13-muster-server.md#mus-spec-13-894b)
test('a Multica sign-in callback with the wrong state is refused and makes no token', { timeout: 30_000 }, async t => {
  const dir = await home(t), f = await fake(t), r = runtime(t, dir);
  const waiting = await start(r, f.origin);
  const { callback } = callbackOf(waiting.approvalUrl!);
  const session = await sessionFrom(f, waiting.approvalUrl!);
  const wrong = await fetch(`${callback}?token=${encodeURIComponent(session)}&state=${'0'.repeat(32)}`);
  assert.equal(wrong.status, 400, 'the wrong state is refused');
  await new Promise(res => setTimeout(res, 100));
  assert.equal(f.issued.length, 0, 'no token is made from it');
  assert.equal((await r.call<PaperclipSignInState>('paperclip.signin.status')).phase, 'waiting', 'the sign-in keeps waiting');
  await signInWindow(waiting.approvalUrl!);
  assert.equal((await settled(r)).phase, 'signed-in', 'the right state still finishes it');
  assert.equal(f.issued.length, 1);
});

// Spec: MUS-SPEC-13-894C (docs/spec/clauses/13-muster-server.md#mus-spec-13-894c)
test('only the first Multica sign-in callback counts: a second one is ignored and makes no second token', { timeout: 30_000 }, async t => {
  const dir = await home(t), f = await fake(t), r = runtime(t, dir);
  const waiting = await start(r, f.origin);
  const { callback, state } = callbackOf(waiting.approvalUrl!);
  const session = await sessionFrom(f, waiting.approvalUrl!);
  const url = `${callback}?token=${encodeURIComponent(session)}&state=${state}`;
  const both = await Promise.all([fetch(url).then(res => res.status, () => 0), fetch(url).then(res => res.status, () => 0)]);
  assert.deepEqual(both.filter(s => s === 200).length, 1, `exactly one callback is answered as signed in (${both.join(', ')})`);
  assert.equal((await settled(r)).phase, 'signed-in');
  assert.equal(f.issued.length, 1, 'one personal access token, not two');
  assert.equal(await refused(url), true, 'after the sign-in nothing listens on the callback port');
  assert.equal(f.issued.length, 1);
});

// Spec: MUS-SPEC-13-894D (docs/spec/clauses/13-muster-server.md#mus-spec-13-894d)
test('cancelling or timing out a Multica sign-in shuts its loopback listener', { timeout: 30_000 }, async t => {
  const dir = await home(t), f = await fake(t), r = runtime(t, dir);
  const waiting = await start(r, f.origin);
  const { callback, state } = callbackOf(waiting.approvalUrl!);
  assert.equal((await fetch(`${callback}?state=${state}`)).status, 400, 'the listener is up while waiting');
  const cancelled = await r.call<PaperclipSignInState>('paperclip.signin.cancel');
  assert.equal(cancelled.phase, 'cancelled');
  await new Promise(res => setTimeout(res, 50));
  assert.equal(await refused(callback), true, 'after Cancel the callback port is closed');
  const quick = runtime(t, await home(t), { timeoutMs: 300 });
  const again = await start(quick, f.origin);
  const second = callbackOf(again.approvalUrl!).callback;
  const ended = await settled(quick);
  assert.equal(ended.phase, 'failed');
  assert.match(ended.message ?? '', /did not send the sign-in back in time/);
  assert.match(ended.message ?? '', /personal access token .*Other ways to connect/);
  assert.equal(await refused(second), true, 'after the time limit the callback port is closed');
  assert.equal(f.issued.length, 0);
});

// Spec: MUS-SPEC-13-894E (docs/spec/clauses/13-muster-server.md#mus-spec-13-894e)
test('neither Multica token ever reaches the window, the server files or another address', { timeout: 30_000 }, async t => {
  const dir = await home(t), f = await fake(t), other = await fake(t), r = runtime(t, dir);
  const waiting = await start(r, f.origin);
  await signInWindow(waiting.approvalUrl!);
  assert.equal((await settled(r)).phase, 'signed-in');
  await r.call('paperclip.config.get'); await r.call('musterServer.list'); await r.call('musterServer.check');
  const session = f.sessions[0]!, pat = f.issued[0]!.token;
  const seen = JSON.stringify([r.answers, r.events]);
  for (const [name, secret] of [['sign-in token', session], ['personal access token', pat]] as const) {
    assert.equal(seen.includes(secret), false, `the ${name} is in no answer or event the window gets`);
  }
  const onDisk = await readFile(join(dir, 'servers.json'), 'utf8').catch(() => '') + await readFile(join(dir, 'server.json'), 'utf8').catch(() => '');
  assert.equal(onDisk.includes(session) || onDisk.includes(pat), false, 'no token in the server files');
  const withSession = f.calls.filter(c => c.auth === `Bearer ${session}`);
  assert.deepEqual(withSession.map(c => `${c.method} ${c.path}`), ['POST /api/tokens'], 'the sign-in token is used once, to make the personal access token');
  assert.equal(other.calls.length, 0, 'another server received nothing');
});

// Spec: MUS-SPEC-13-894F (docs/spec/clauses/13-muster-server.md#mus-spec-13-894f)
test('a Multica server too old for sign-in from Muster ends with Multica’s words and points to the token fallback', { timeout: 30_000 }, async t => {
  const noTokens = await fake(t), r = runtime(t, await home(t), { timeoutMs: 2000 });
  noTokens.tokensRoute = false;
  const waiting = await start(r, noTokens.origin);
  const shown = await signInWindow(waiting.approvalUrl!);
  assert.doesNotMatch(shown.text, /you are signed in/i, 'the window does not claim success');
  const failed = await settled(r);
  assert.equal(failed.phase, 'failed');
  assert.match(failed.message ?? '', /404 page not found/, 'Multica’s own answer');
  assert.match(failed.message ?? '', /too old/);
  assert.match(failed.message ?? '', /personal access token .*Other ways to connect/);
  assert.equal(r.secrets.values.size, 0, 'nothing is stored');
  assert.equal((await r.call<PaperclipConfigView>('paperclip.config.get')).hasToken, false, 'not connected');
  const noCallback = await fake(t), q = runtime(t, await home(t), { timeoutMs: 400 });
  noCallback.cliCallback = false;
  const page = await signInWindow((await start(q, noCallback.origin)).approvalUrl!);
  assert.match(page.text, /Sign in to Multica/, 'the old page just shows its own sign-in');
  const ended = await settled(q);
  assert.equal(ended.phase, 'failed');
  assert.match(ended.message ?? '', /did not send the sign-in back in time/);
  assert.match(ended.message ?? '', /Other ways to connect/);
  assert.equal(q.secrets.values.size, 0);
});

// ---------------------------------------------------------------- the sign-in window (Electron faked)
function fakeElectron() {
  const external: string[] = [];
  const windows: { options: any; url?: string; closed: boolean; listeners: Record<string, Function[]>; wc: Record<string, Function> }[] = [];
  const runtime: SignInRuntime = {
    getSession() { return { cookies: { get: async () => [], remove: async () => undefined }, clearStorageData: async () => undefined, setPermissionRequestHandler() {} } as SessionLike; },
    createWindow(options) {
      const w: (typeof windows)[number] = { options, closed: false, listeners: {} as Record<string, Function[]>, wc: {} as Record<string, Function> }; windows.push(w);
      const win = { loadURL: async (url: string) => { w.url = url; }, show() {}, focus() {}, close() { w.closed = true; for (const l of w.listeners.closed ?? []) l(); }, isDestroyed: () => w.closed,
        on(event: string, l: Function) { (w.listeners[event] ??= []).push(l); return win; },
        webContents: { on(event: string, l: Function) { w.wc[event] = l; return win; }, setWindowOpenHandler() {} } } as unknown as WindowLike;
      return win;
    },
    async openExternal(url) { external.push(url); },
  };
  return { runtime, external, windows };
}

// Spec: MUS-SPEC-13-894H (docs/spec/clauses/13-muster-server.md#mus-spec-13-894h)
test('the Multica sign-in window goes only to its own loopback callback, and closing it early abandons the sign-in', async t => {
  const HOST = 'https://projects.acme.example', fx = fakeElectron(), abandoned: string[] = [];
  const windows = new ServerSignInWindows({ runtime: fx.runtime, watchMs: 60_000, onSession: () => undefined, onAbandoned: (url: string) => { abandoned.push(url); } });
  t.after(() => windows.dispose());
  const login = `${HOST}/login?cli_callback=${encodeURIComponent('http://127.0.0.1:53111/callback')}&cli_state=${'a'.repeat(32)}`;
  await windows.open({ url: login, baseUrl: HOST });
  const w = fx.windows[0]!, prefs = w.options.webPreferences;
  assert.equal(w.url, login);
  assert.equal(prefs.partition, sessionPartition(HOST));
  assert.deepEqual([prefs.nodeIntegration, prefs.contextIsolation, prefs.sandbox, prefs.webSecurity, prefs.webviewTag], [false, true, true, true, false], 'isolated like every sign-in window');
  assert.equal(w.options.title, 'Sign in to Multica · projects.acme.example');
  const go = (event: string, url: string) => { let prevented = false; w.wc[event]!({ url, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(go('will-navigate', `${HOST}/login?step=code`), false, 'Multica’s own pages are allowed');
  assert.equal(go('will-redirect', 'http://127.0.0.1:53112/callback?token=x&state=y'), true, 'another loopback port is refused');
  assert.equal(go('will-navigate', 'http://127.0.0.1:53111/elsewhere'), true, 'another path on the callback port is refused');
  assert.equal(go('will-navigate', 'https://evil.example.net/'), true, 'another site is refused');
  await new Promise(res => setTimeout(res, 20));
  assert.deepEqual(fx.external, ['https://evil.example.net/'], 'another site goes to the system browser; a loopback address never does');
  w.closed = true; for (const l of w.listeners.closed ?? []) l();
  await new Promise(res => setTimeout(res, 20));
  assert.deepEqual(abandoned, [login], 'closing before the callback abandons the sign-in, once');
  await windows.open({ url: login, baseUrl: HOST });
  const w2 = fx.windows[1]!;
  let prevented = false;
  w2.wc['will-redirect']!({ url: `http://127.0.0.1:53111/callback?token=x&state=${'a'.repeat(32)}`, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'its own callback is allowed in the window');
  await new Promise(res => setTimeout(res, 20));
  assert.equal(fx.external.some(u => u.includes('token=')), false, 'the callback (and its token) is never sent to the system browser');
  w2.closed = true; for (const l of w2.listeners.closed ?? []) l();
  await new Promise(res => setTimeout(res, 20));
  assert.deepEqual(abandoned, [login], 'closing after the callback is not abandoning');
  await windows.open({ url: `${HOST}/cli-auth/abc`, baseUrl: HOST });
  const plain = fx.windows[2]!;
  let blocked = false;
  plain.wc['will-redirect']!({ url: 'http://127.0.0.1:53111/callback', preventDefault() { blocked = true; } });
  assert.equal(blocked, true, 'a page without cli_callback may not go to 127.0.0.1');
  assert.notEqual(plain.options.title.startsWith('Sign in to Multica'), true);
  windows.dispose();
});
