/**
 * "Sign in to Muster Server" inside the app. The server's OWN approval and login page opens in a window whose cookie jar is a persistent
 * partition of its own, one per server origin (runtime/server/session.ts), so a hosted Paperclip can give this Mac a browser session and
 * its live socket becomes instant. Muster never sees the password: it is typed on the server's page. The window:
 *  - has no Node, context isolation and the sandbox on; permissions and pop-ups are refused;
 *  - stays on the server's origin: any other address (a redirect, a link, window.open) goes to the system browser instead;
 *  - shares nothing with another server's partition, the app's browser tabs or the app's own window.
 * The session cookie is read from the partition (for that origin only, session-token cookie only) and handed to the runtime, which keeps it
 * encrypted. Nothing is stored here, and the cookie never reaches the renderer. Electron is injected so tests drive fakes.
 */
import { createRequire } from 'node:module';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { sessionCookieHeader, sessionPartition, type CookieLike } from '../runtime/server/session.ts';

export interface WindowLike {
  loadURL(url: string): Promise<void>;
  show(): void; focus(): void; close(): void; isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): unknown;
  webContents: {
    on(event: 'will-navigate' | 'will-redirect', listener: (event: { url: string; preventDefault(): void }) => void): unknown;
    on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  };
}
export interface SessionLike {
  cookies: { get(filter: { url: string }): Promise<CookieLike[]>; remove(url: string, name: string): Promise<void> };
  clearStorageData(): Promise<void>;
  setPermissionRequestHandler(handler: (...args: unknown[]) => void): void;
}
export interface SignInRuntime {
  createWindow(options: BrowserWindowConstructorOptions, parent: unknown): WindowLike;
  getSession(partition: string): SessionLike;
  openExternal(url: string): Promise<void>;
}
export interface SignInWindowOptions { runtime?: SignInRuntime; onSession(baseUrl: string, cookie: string): Promise<unknown> | unknown; watchMs?: number; timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } }

function electronRuntime(): SignInRuntime {
  const { BrowserWindow: Window, session, shell } = createRequire(__filename)('electron') as typeof import('electron');
  return {
    createWindow: (options, parent) => new Window({ ...options, ...(parent ? { parent: parent as BrowserWindow } : {}) }) as unknown as WindowLike,
    getSession: partition => session.fromPartition(partition) as unknown as SessionLike & Session,
    openExternal: url => shell.openExternal(url),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** https, or http for this computer alone: a session cookie never crosses a network in clear text. */
export function serverOriginOf(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error('That is not a server address.'); }
  if (url.username || url.password) throw new Error('Leave credentials out of the address.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error('Sign in needs an https:// address (plain http is only allowed for this Mac).');
  return url.origin;
}
const isWeb = (url: string): boolean => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };

export class ServerSignInWindows {
  private readonly runtime: SignInRuntime;
  private readonly windows = new Map<string, { window: WindowLike; timer: ReturnType<typeof setInterval> | null; last: string | null }>();
  private readonly timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  constructor(private readonly options: SignInWindowOptions) { this.runtime = options.runtime ?? electronRuntime(); this.timers = options.timers ?? { setInterval, clearInterval }; }

  /** Opens (or brings forward) the sign-in window for a server. `url` must be on the server's own origin. */
  async open(input: { url: string; baseUrl: string }, parent?: unknown): Promise<{ opened: true }> {
    const origin = serverOriginOf(input.baseUrl);
    if (serverOriginOf(input.url) !== origin) throw new Error('The sign-in page must be on the server’s own address.');
    const existing = this.windows.get(origin);
    if (existing && !existing.window.isDestroyed()) { existing.window.show(); existing.window.focus(); await existing.window.loadURL(input.url).catch(() => undefined); return { opened: true }; }
    const partition = sessionPartition(origin), jar = this.runtime.getSession(partition);
    jar.setPermissionRequestHandler((...args: unknown[]) => { const callback = args.find(a => typeof a === 'function') as ((allow: boolean) => void) | undefined; callback?.(false); });
    const window = this.runtime.createWindow({
      width: 540, height: 760, minWidth: 420, minHeight: 520, title: `Sign in to Muster Server · ${new URL(origin).host}`, autoHideMenuBar: true, show: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, webviewTag: false },
    }, parent);
    const entry: { window: WindowLike; timer: ReturnType<typeof setInterval> | null; last: string | null } = { window, timer: null, last: null };
    this.windows.set(origin, entry);
    // Stay on the server's origin. Anything else belongs in the system browser, never in a window that holds this server's session.
    const guard = (event: { url: string; preventDefault(): void }) => {
      let same = false; try { same = new URL(event.url).origin === origin; } catch { /* unparsable: refused */ }
      if (!same) { event.preventDefault(); if (isWeb(event.url)) void this.runtime.openExternal(event.url).catch(() => undefined); }
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => { if (isWeb(url)) void this.runtime.openExternal(url).catch(() => undefined); return { action: 'deny' }; });
    const capture = async () => {
      const header = sessionCookieHeader(await jar.cookies.get({ url: origin }).catch(() => []), origin);
      if (!header || header === entry.last) return;
      entry.last = header;
      await this.options.onSession(origin, header);
    };
    entry.timer = this.timers.setInterval(() => { void capture(); }, this.options.watchMs ?? 1500);
    window.on('closed', () => { if (entry.timer) this.timers.clearInterval(entry.timer); entry.timer = null; void capture().finally(() => { if (this.windows.get(origin) === entry) this.windows.delete(origin); }); });
    await window.loadURL(input.url).catch(() => undefined);
    void capture();
    return { opened: true };
  }

  /** Closes the window (for "Use my browser instead"). */
  close(baseUrl: string): void { const entry = this.windows.get(serverOriginOf(baseUrl)); if (entry && !entry.window.isDestroyed()) entry.window.close(); }

  /** Sign out: the window closes and this server's partition loses its cookies and storage. Other servers' partitions are untouched. */
  async clear(baseUrl: string): Promise<void> {
    const origin = serverOriginOf(baseUrl), entry = this.windows.get(origin);
    if (entry && !entry.window.isDestroyed()) entry.window.close();
    this.windows.delete(origin);
    const jar = this.runtime.getSession(sessionPartition(origin));
    for (const cookie of await jar.cookies.get({ url: origin }).catch(() => [])) await jar.cookies.remove(origin, cookie.name).catch(() => undefined);
    await jar.clearStorageData().catch(() => undefined);
  }

  dispose(): void { for (const [, entry] of this.windows) { if (entry.timer) this.timers.clearInterval(entry.timer); if (!entry.window.isDestroyed()) entry.window.close(); } this.windows.clear(); }
}
