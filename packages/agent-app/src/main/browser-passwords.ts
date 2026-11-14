/**
 * #843: fill a sign-in form in the in-app browser from the person's own 1Password, through the `op` CLI (the same
 * binary #842's secret requests use). Filling is a user action from the browser toolbar only; no agent tool reaches it.
 *
 * The key menu lists Login items whose saved address matches the page's site (`op item list`, which carries no
 * passwords). Choosing one reads that item (`op item get`), checks again that it belongs to the page and that the
 * page did not navigate while 1Password asked, then types the username and password into the page's fields as
 * trusted text input. The password is held only in this call's memory: it is never written to disk, logged, cached,
 * emitted, embedded in a page script or returned. The password field is marked in the agents' isolated world so
 * their snapshots and screenshots keep it masked even if the page shows it as plain text.
 */
import {execFile} from 'node:child_process';
import type {BrowserFillResult, BrowserLogin, BrowserLogins} from '../shared/browser-protocol.ts';
import {AGENT_WORLD} from './agent-tools/browser-tools.ts';

export interface PasswordFillTarget {
  getURL(): string;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: {code: string}[], userGesture?: boolean): Promise<unknown>;
  insertText(text: string): Promise<void>;
}
export interface BrowserPasswords {
  logins(pageUrl: string): Promise<BrowserLogins>;
  fill(target: PasswordFillTarget, input: {id: unknown; vault: unknown}): Promise<BrowserFillResult>;
}
export interface BrowserPasswordsDeps {
  /** The `op` binary, or undefined when it is not installed. */
  onePassword(): string | undefined;
  /** 1Password may wait for Touch ID or the desktop app's approval. */
  timeoutMs?: number;
}

/** 1Password item and vault ids: 26 lowercase base-32 characters. Anything else never reaches `op`. */
const OP_ID = /^[a-z0-9]{26}$/;
const MAX_LIST_BYTES = 16 * 1024 * 1024, MAX_ITEM_BYTES = 1024 * 1024, MAX_VALUE = 4096;
export const MISSING_CLI = 'Install the 1Password CLI (op) and turn on its desktop app integration to fill logins.';

function pageAddress(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Logins can only be filled on a web page.'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) throw new Error('Logins can only be filled on a web page.');
  return url;
}
function savedAddress(href: unknown): URL | undefined {
  if (typeof href !== 'string' || !href.trim() || href.length > 2048) return undefined;
  const text = href.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url : undefined;
  } catch { return undefined; }
}
const bareHost = (host: string) => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** A saved address matches the page when the host is the same or the page is on a subdomain of it, the page is not
 *  less secure (an https login is never offered on http) and a saved port, if any, is the page's port. */
export function siteMatches(saved: unknown, page: string): boolean {
  const login = savedAddress(saved);
  let at: URL;
  try { at = pageAddress(page); } catch { return false; }
  if (!login) return false;
  const want = bareHost(login.hostname), host = bareHost(at.hostname);
  if (!want || !(host === want || (want.includes('.') && host.endsWith(`.${want}`)))) return false;
  if (login.protocol === 'https:' && at.protocol !== 'https:') return false;
  if (login.port && login.port !== at.port) return false;
  return true;
}
const text = (value: unknown, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const urlsOf = (item: Record<string, unknown>) => Array.isArray(item.urls) ? (item.urls as {href?: unknown}[]).map(entry => entry?.href) : [];

/** The first line of `op`'s complaint, bounded; never its output. */
function opError(stderr: unknown, fallback: string): Error {
  const line = String(stderr ?? '').trim().split('\n')[0]?.replace(/^\[ERROR\]\s*[\d/ :]*\s*/, '').slice(0, 200);
  return new Error(line ? `${fallback}: ${line}` : `${fallback}.`);
}

/** The login fields of the page, resolved in the agents' isolated world: the visible password field (a sign-in one
 *  before a new-password one) and the username field before it in the same form. With no password field (a first,
 *  username-only step) the username field alone. `step` focuses one of them and selects its text, so the next
 *  trusted text input replaces it; a focused password field is remembered as secret for the agent tools.
 *  The focused field is armed as the only one that may take the coming value (see FILL_GUARD). */
export function loginFieldScript(step: 'find' | 'username' | 'password'): string {
  return `(() => {
  const usable = el => { if (el.disabled || el.readOnly) return false; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const passwords = [...document.querySelectorAll('input[type=password]')].filter(usable);
  const password = passwords.find(el => /current-password/.test(el.autocomplete || '')) || passwords.find(el => !/new-password/.test(el.autocomplete || '')) || passwords[0] || null;
  const scope = (password && password.form) || document;
  const texts = [...scope.querySelectorAll('input')].filter(el => ['text', 'email', 'tel', ''].includes(el.type) && usable(el));
  const before = password ? texts.filter(el => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) : texts.filter(el => /username|email/.test(el.autocomplete || '') || el.type === 'email' || /user|mail|login/i.test((el.name || '') + ' ' + (el.id || '')));
  const named = el => /username|email/.test(el.autocomplete || '') || el.type === 'email' || /user|mail|login|account/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || ''));
  const username = before.slice().reverse().find(named) || before[before.length - 1] || null;
  const step = ${JSON.stringify(step)};
  if (step === 'find') return {username: !!username, password: !!password};
  const el = step === 'password' ? password : username;
  if (!el) return {ok: false};
  if (step === 'password') (globalThis.__musterSecrets ||= new WeakSet()).add(el);
  ${FILL_GUARD}
  globalThis.__musterFill = {el, step, blocked: false};
  el.scrollIntoView({block: 'center'}); el.focus();
  try { el.select(); } catch { el.value = ''; }
  return {ok: document.activeElement === el};
})()`;
}
/** #843 (MUS-SPEC-09-843G): installed once in the agents' isolated world. While a value is being typed, input that would
 *  land anywhere but the armed field (focus moved, field removed) is cancelled before it is inserted and the fill is
 *  marked blocked. Any field that takes input while the password is typed is remembered as secret. */
const FILL_GUARD = `if (!globalThis.__musterFillGuard) {
    globalThis.__musterFillGuard = true;
    addEventListener('beforeinput', event => {
      const fill = globalThis.__musterFill;
      if (!fill) return;
      if (fill.step === 'password' && event.target instanceof Element) (globalThis.__musterSecrets ||= new WeakSet()).add(event.target);
      if (fill.blocked || event.target !== fill.el || document.activeElement !== fill.el || !fill.el.isConnected) { fill.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    addEventListener('input', event => { const fill = globalThis.__musterFill; if (fill && fill.step === 'password' && event.target instanceof Element) (globalThis.__musterSecrets ||= new WeakSet()).add(event.target); }, true);
  }`;
/** #843 (MUS-SPEC-09-843G): right before a value is typed, the armed field must still be exactly the focused element,
 *  connected, and the kind of field the value is for. `done` disarms the guard and reads whether it cancelled anything
 *  (a page that replaced its document has no armed fill left, and nothing there was cancelled). */
export function fillCheckScript(step: 'username' | 'password' | 'done'): string {
  return `(() => {
  const fill = globalThis.__musterFill;
  if (${JSON.stringify(step)} === 'done') { globalThis.__musterFill = null; return {ok: !fill?.blocked, armed: !!fill}; }
  if (!fill || fill.step !== ${JSON.stringify(step)} || fill.blocked) return {ok: false};
  const el = fill.el;
  const kind = fill.step === 'password' ? el.type === 'password' || !!globalThis.__musterSecrets?.has(el) : ['text', 'email', 'tel', ''].includes(el.type);
  const ok = el.isConnected && document.activeElement === el && kind && el.tagName === 'INPUT';
  if (!ok) fill.blocked = true;
  return {ok};
})()`;
}
export const FILL_CHANGED = 'The page changed during the fill.';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export function createBrowserPasswords(deps: BrowserPasswordsDeps): BrowserPasswords {
  const timeout = deps.timeoutMs ?? 90_000;
  const run = (op: string, args: string[], maxBuffer: number, fallback: string) => new Promise<string>((resolve, reject) =>
    execFile(op, args, {timeout, maxBuffer, windowsHide: true}, (failure, stdout, stderr) => failure ? reject(opError(stderr, fallback)) : resolve(String(stdout))));
  const parse = (raw: string, what: string): unknown => { try { return JSON.parse(raw); } catch { throw new Error(`1Password returned ${what} Muster could not read.`); } };
  return {
    async logins(pageUrl) {
      const page = pageAddress(pageUrl);
      const op = deps.onePassword();
      if (!op) return {manager: '1password', available: false, logins: [], message: MISSING_CLI};
      const items = parse(await run(op, ['item', 'list', '--categories', 'Login', '--format', 'json'], MAX_LIST_BYTES, '1Password could not list logins'), 'a list');
      const logins: BrowserLogin[] = [];
      for (const raw of Array.isArray(items) ? items : []) {
        const item = record(raw), vault = record(item.vault);
        if (typeof item.id !== 'string' || !OP_ID.test(item.id) || typeof vault.id !== 'string' || !OP_ID.test(vault.id)) continue;
        const match = savedAddress(urlsOf(item).find(href => siteMatches(href, page.href)));
        if (!match) continue;
        logins.push({id: item.id, vault: vault.id, title: text(item.title) || bareHost(match.hostname), username: text(item.additional_information), site: bareHost(match.hostname)});
      }
      logins.sort((a, b) => a.title.localeCompare(b.title) || a.username.localeCompare(b.username));
      return {manager: '1password', available: true, logins: logins.slice(0, 50)};
    },
    async fill(target, input) {
      const id = input?.id, vault = input?.vault;
      if (typeof id !== 'string' || !OP_ID.test(id) || typeof vault !== 'string' || !OP_ID.test(vault)) throw new Error('That is not a 1Password login.');
      const start = pageAddress(target.getURL());
      const found = record(await target.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{code: loginFieldScript('find')}]));
      if (found.username !== true && found.password !== true) throw new Error('No sign-in form was found on this page.');
      const op = deps.onePassword();
      if (!op) throw new Error(MISSING_CLI);
      // The item (with its password) lives only in this scope; it is dropped when the fill returns.
      const item = record(parse(await run(op, ['item', 'get', id, '--vault', vault, '--format', 'json'], MAX_ITEM_BYTES, '1Password could not read that login'), 'a login'));
      const site = bareHost(start.hostname);
      if (!urlsOf(item).some(href => siteMatches(href, start.href))) throw new Error(`That login is not saved for ${site}. Nothing was filled.`);
      const fields = Array.isArray(item.fields) ? item.fields.map(record) : [];
      const value = (purpose: string) => { const field = fields.find(entry => entry.purpose === purpose && typeof entry.value === 'string'); return typeof field?.value === 'string' ? field.value : ''; };
      const username = value('USERNAME'), password = value('PASSWORD');
      if (username.length > MAX_VALUE || password.length > MAX_VALUE) throw new Error('That login is too long to fill.');
      // Checked again right before each value is typed: typing the username can make the page navigate, and the password
      // must never land on a page of another origin.
      const sameOrigin = () => { try { return new URL(target.getURL()).origin === start.origin; } catch { return false; } };
      if (!sameOrigin()) throw new Error('The page changed while 1Password was asked. Nothing was filled.');
      let filled = 0;
      const disarm = async () => record(await target.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{code: fillCheckScript('done')}]).catch(() => ({ok: true}))).ok === true;
      // The guard is disarmed on every way out, so it never outlives this fill.
      try { for (const [step, entry] of [['username', username], ['password', password]] as const) {
        if (!entry || (step === 'username' ? found.username : found.password) !== true) continue;
        const focus = record(await target.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{code: loginFieldScript(step)}], true));
        if (focus.ok !== true) continue;
        const stopped = () => new Error(filled ? `${FILL_CHANGED} The password was not filled.` : `${FILL_CHANGED} Nothing was filled.`);
        // Checked together, right before the value is typed: the page is on the same origin and the armed field is still the
        // focused one. In the gap that remains, the guard cancels input that would land anywhere else (MUS-SPEC-09-843G).
        const ready = record(await target.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{code: fillCheckScript(step)}]));
        if (!sameOrigin()) throw new Error(filled ? 'The page changed after the username was typed. The password was not filled.' : 'The page changed while 1Password was asked. Nothing was filled.');
        if (ready.ok !== true) throw stopped();
        await target.insertText(entry);
        if (!await disarm()) throw stopped();
        filled |= step === 'username' ? 1 : 2;
      } } finally { await disarm(); }
      if (!filled) throw new Error(password || username ? 'No sign-in form was found on this page.' : 'That login has no username or password.');
      return {title: text(item.title) || site, filled: filled === 3 ? 'login' : filled === 1 ? 'username' : 'password'};
    },
  };
}
