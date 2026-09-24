/**
 * EXT-10: plugin UI served from its own `muster-plugin://<token>/` origin. The renderer shows it in an
 * `<iframe sandbox="allow-scripts">` (opaque origin: no access to Muster's DOM, storage, cookies or preload bridge,
 * no Node), every response carries a strict CSP (no network, no nested frames, no forms), and only files inside the
 * plugin folder with an allowlisted type are served. Tokens are random, per open, and bounded in number.
 */
import {randomBytes} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {PluginUiEntry} from '../shared/domains/artifacts-protocol.ts';

export const PLUGIN_SCHEME = 'muster-plugin';
const MAX_TOKENS = 32, MAX_FILE_BYTES = 5 * 1024 * 1024;
const TOKEN = /^[a-f0-9]{32}$/;
export const PLUGIN_UI_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
/** No network (connect-src 'none'), no frames, workers, plugins, forms or base rewrites; only the plugin's own files. */
export function pluginUiCsp(token: string): string {
  const own = `'self' ${PLUGIN_SCHEME}://${token}`;
  return [`default-src 'none'`, `script-src ${own} 'unsafe-inline'`, `style-src ${own} 'unsafe-inline'`, `img-src ${own} data: blob:`, `font-src ${own} data:`, `media-src ${own} data: blob:`,
    `connect-src 'none'`, `frame-src 'none'`, `child-src 'none'`, `worker-src 'none'`, `object-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `manifest-src 'none'`].join('; ');
}

export interface PluginUiResponse {status: number; headers: Record<string, string>; body: Buffer | string}
interface Registered {token: string; root: string; entry: string; title: string; key: string}

export class PluginUiRegistry {
  private tokens = new Map<string, Registered>();
  /** Reopening the same app reuses its token, so a remounted tab keeps one origin. */
  register(entry: PluginUiEntry): {url: string; title: string} {
    const key = `${entry.pluginId}\u0000${entry.app}`;
    let found = [...this.tokens.values()].find(item => item.key === key && item.root === entry.root && item.entry === entry.entry);
    if (found) this.tokens.delete(found.token);
    else found = {token: randomBytes(16).toString('hex'), root: entry.root, entry: entry.entry, title: entry.title, key};
    this.tokens.set(found.token, found);
    while (this.tokens.size > MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    return {url: `${PLUGIN_SCHEME}://${found.token}/${found.entry.split('/').map(encodeURIComponent).join('/')}`, title: found.title};
  }
  /** Main-frame guard: only a registered plugin URL may load in a subframe. */
  allows(url: string): boolean {
    try { const parsed = new URL(url); return parsed.protocol === `${PLUGIN_SCHEME}:` && this.tokens.has(parsed.hostname); } catch { return false; }
  }
  async respond(url: string, read: (file: string) => Promise<Buffer> = file => fs.readFile(file)): Promise<PluginUiResponse> {
    const fail = (status: number, text: string): PluginUiResponse => ({status, headers: {'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff'}, body: text});
    let parsed: URL;
    try { parsed = new URL(url); } catch { return fail(400, 'Bad request'); }
    const registered = parsed.protocol === `${PLUGIN_SCHEME}:` && TOKEN.test(parsed.hostname) ? this.tokens.get(parsed.hostname) : undefined;
    if (!registered) return fail(404, 'This plugin view has expired. Reopen it from Plugins.');
    let relative: string;
    try { relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, ''); } catch { return fail(400, 'Bad request'); }
    if (!relative) relative = registered.entry;
    const parts = relative.split('/').filter(part => part && part !== '.');
    if (!parts.length || parts.includes('..') || relative.includes('\0') || relative.includes('\\')) return fail(403, 'Forbidden');
    const type = PLUGIN_UI_TYPES[path.extname(parts.at(-1)!).slice(1).toLowerCase()];
    if (!type) return fail(403, 'This file type is not served to plugin UI.');
    let file: string;
    try {
      file = await fs.realpath(path.join(registered.root, ...parts));
      const inside = path.relative(registered.root, file);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return fail(403, 'Forbidden');
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return fail(404, 'Not found');
    } catch { return fail(404, 'Not found'); }
    const body = await read(file);
    return {status: 200, body, headers: {
      'content-type': type, 'content-security-policy': pluginUiCsp(registered.token), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), display-capture=(), usb=(), serial=(), hid=()',
      // Module scripts from an opaque-origin frame are CORS requests; the token already scopes who can ask.
      ...(/javascript|json|font/.test(type) ? {'access-control-allow-origin': '*'} : {}),
    }};
  }
}
