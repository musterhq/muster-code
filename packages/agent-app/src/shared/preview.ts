/**
 * Spin-up previews (#html-preview): what the agent may open with preview_open, how a failed load reads, and how a local
 * listener is recognised as a web server. Pure: shared by main, the runtime, the renderer and the tests.
 *
 * Portions adapted from T3 Code (https://github.com/pingdotgg/t3code) at commit 13aa882c22d584de5388dfce3b3ca413387ba059:
 * the friendly load-error wording (apps/web/src/components/preview/previewConstants.ts), the loopback rules
 * (packages/shared/src/preview.ts) and the web-server probe (apps/server/src/preview/PortScanner.ts: only HTML answers count,
 * redirects are not followed, a short timeout). Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md.
 */

/** Chromium net error names to plain English. */
export const PREVIEW_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: 'DNS address could not be found',
  ERR_NAME_RESOLUTION_FAILED: 'DNS address could not be found',
  ERR_CONNECTION_REFUSED: 'Connection refused',
  ERR_CONNECTION_RESET: 'Connection was reset',
  ERR_CONNECTION_CLOSED: 'Connection was closed',
  ERR_CONNECTION_TIMED_OUT: 'Connection timed out',
  ERR_INTERNET_DISCONNECTED: 'No internet connection',
  ERR_TIMED_OUT: 'Connection timed out',
  ERR_ADDRESS_UNREACHABLE: 'Address is unreachable',
  ERR_EMPTY_RESPONSE: 'The server sent no data',
  ERR_CERT_AUTHORITY_INVALID: 'Certificate authority is not trusted',
  ERR_CERT_COMMON_NAME_INVALID: 'Certificate hostname mismatch',
  ERR_CERT_DATE_INVALID: 'Certificate is expired or not yet valid',
  ERR_TOO_MANY_REDIRECTS: 'Too many redirects',
});
export function describeLoadError(description: string): string {
  const key = description.replace(/^net::/, '').trim();
  return PREVIEW_ERROR_MESSAGES[key] ?? (key || 'Network error');
}
/** A refused or empty answer from a local address usually means the dev server is not running (yet). */
export function looksLikeServerDown(url: string, description: string): boolean {
  return isLoopbackUrl(url) && /CONNECTION_REFUSED|EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED/.test(description);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '::', '[::]']);
export const isLoopbackHost = (host: string) => LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
export function isLoopbackUrl(raw: string): boolean { try { return isLoopbackHost(new URL(raw).hostname); } catch { return false; } }

/** http(s) only, no credentials, bounded; `0.0.0.0` (what dev servers print) becomes `localhost`; a bare `:5173` or `localhost:5173` gets http://. */
export function previewUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  if (!text || text.length > 2048) return undefined;
  if (/^:\d{1,5}(\/|$)/.test(text)) text = `localhost${text}`;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(\/|$)/i.test(text)) text = `http://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
  return url.href;
}

const sep = (path: string) => path.includes('\\') && !path.includes('/') ? '\\' : '/';
/** Lexical check: an .html/.htm path (absolute or relative to `root`) that stays inside `root`. Symlinks are checked by the caller with realpath. */
export function previewFilePath(root: string, file: string): string | undefined {
  if (!root || typeof file !== 'string' || !file.trim() || file.length > 4096 || file.includes('\0')) return undefined;
  const s = sep(root), parts: string[] = [];
  const raw = file.trim().replace(/^file:\/\//, '');
  const absolute = raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw);
  for (const part of (absolute ? raw : `${root}${s}${raw}`).split(/[\\/]+/)) {
    if (part === '' || part === '.') { if (!parts.length) parts.push(''); continue; }
    if (part === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(part);
  }
  const resolved = parts.join(s) || s;
  const base = root.replace(/[\\/]+$/, '');
  if (resolved !== base && !resolved.startsWith(base + s)) return undefined;
  if (!/\.html?$/i.test(resolved)) return undefined;
  return resolved;
}

// ---- web-server probe -----------------------------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Is an HTTP answer a page a person would open? HTML, or a redirect with a target (dev servers redirect / to /app). */
export function isWebResponse(status: number, contentType: string | null | undefined, location?: string | null): boolean {
  if (REDIRECTS.has(status)) return !!location?.trim();
  if (status < 200 || status >= 300 || status === 204 || status === 205) return false;
  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}
