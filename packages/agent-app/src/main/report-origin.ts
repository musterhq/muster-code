/**
 * Visuals program: untrusted HTML (an agent's ```html-report, a Canvas HTML page) served from its own
 * `muster-report://<token>/` origin, never from the app's. The renderer shows it in `<iframe sandbox="allow-scripts">`
 * (opaque origin: no access to Muster's DOM, storage, cookies or preload bridge, no Node, no top navigation, no popups,
 * no forms), and every response carries a strict CSP: no network at all (`connect-src 'none'`, no remote scripts, images
 * or fonts, no frames, workers or plugins). Documents live in main's memory only, under random per-document tokens, in
 * bounded number and size. This is the one path for "render untrusted visual content": reports and Canvas pages share it.
 */
import {createHash, randomBytes} from 'node:crypto';
import {prepareReportHtml, REPORT_HEIGHT_SOURCE} from '../shared/report-html.ts';

export {prepareReportHtml, REPORT_HEIGHT_SCRIPT} from '../shared/report-html.ts';

export const REPORT_SCHEME = 'muster-report';
export const MAX_REPORT_BYTES = 4_000_000;
const MAX_DOCUMENTS = 48, MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const TOKEN = /^[a-f0-9]{32}$/;

/**
 * No network (`connect-src 'none'`), no frames, workers, plugins, forms or base rewrites. Inline script and style only, and
 * only when `scripts`. A page the person allowed network for (render_html, per page) may also load https: scripts, styles,
 * images, fonts and media and fetch over https:, nothing else: never http:, file:, a custom scheme or the app's own origins,
 * and still no frames, workers, forms or popups.
 */
export function reportCsp(scripts: boolean, network = false, measure = false): string {
  const remote = network ? ' https:' : '';
  // Measure-only (a page shown, never run): the one script allowed is Muster's height reporter, by hash. Hash sources also block inline
  // event handlers and javascript: URLs, so nothing of the page's own runs.
  const script = scripts ? `'unsafe-inline'${remote}` : measure ? `'${REPORT_HEIGHT_HASH}'` : `'none'`;
  return [`default-src 'none'`, `script-src ${script}`, `style-src 'unsafe-inline'${remote}`, `img-src data: blob:${remote}`, `font-src data:${remote}`, `media-src data: blob:${remote}`,
    `connect-src ${network && scripts ? 'https:' : `'none'`}`, `frame-src 'none'`, `child-src 'none'`, `worker-src 'none'`, `object-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `manifest-src 'none'`].join('; ');
}

/** CSP hash source of the height reporter (the only script a measure-only page may run). */
export const REPORT_HEIGHT_HASH = `sha256-${createHash('sha256').update(REPORT_HEIGHT_SOURCE).digest('base64')}`;

export interface ReportResponse {status: number; headers: Record<string, string>; body: string}
interface Document {token: string; key?: string; html: string; scripts: boolean; themed: boolean; network: boolean; measure: boolean; version: number; bytes: number}
export interface ReportInput {html: string; scripts?: boolean; key?: string; /** Muster's theme variables and the theme/link bootstrap (agent pages). */ themed?: boolean; /** Only for a page the person allowed network for; main decides, never the renderer alone. */ network?: boolean; /** With scripts off: run only the height reporter so the frame fits the page (reportCsp). */ measure?: boolean}

export class ReportRegistry {
  private documents = new Map<string, Document>();
  private bytes = 0;

  /** Registering again under the same `key` (a Canvas being edited) replaces the content under the same token and bumps the version in the URL. */
  register(input: ReportInput): {url: string; token: string; version: number} {
    if (typeof input?.html !== 'string') throw new Error('Nothing to show.');
    const bytes = Buffer.byteLength(input.html);
    if (bytes > MAX_REPORT_BYTES) throw new Error(`This page is ${(bytes / 1_000_000).toFixed(1)} MB; the limit is ${MAX_REPORT_BYTES / 1_000_000} MB.`);
    const key = typeof input.key === 'string' && input.key.length > 0 && input.key.length <= 160 ? input.key : undefined;
    let found = key ? [...this.documents.values()].find(item => item.key === key) : undefined;
    if (found) { this.bytes -= found.bytes; this.documents.delete(found.token); found.html = input.html; found.scripts = input.scripts !== false; found.themed = input.themed === true; found.network = input.network === true; found.measure = input.scripts === false && input.measure === true; found.version++; found.bytes = bytes; }
    else found = {token: randomBytes(16).toString('hex'), ...(key ? {key} : {}), html: input.html, scripts: input.scripts !== false, themed: input.themed === true, network: input.network === true, measure: input.scripts === false && input.measure === true, version: 1, bytes};
    this.documents.set(found.token, found); this.bytes += bytes;
    // Oldest first: a tab left open long ago is the first to expire (its view says so and offers a reload).
    while (this.documents.size > MAX_DOCUMENTS || this.bytes > MAX_TOTAL_BYTES) {
      const oldest = this.documents.keys().next().value as string;
      if (oldest === found.token) break;
      this.bytes -= this.documents.get(oldest)!.bytes; this.documents.delete(oldest);
    }
    return {url: `${REPORT_SCHEME}://${found.token}/index.html?v=${found.version}`, token: found.token, version: found.version};
  }

  /** Main-frame guard: only a registered report URL may load in a subframe. */
  allows(url: string): boolean {
    try { const parsed = new URL(url); return parsed.protocol === `${REPORT_SCHEME}:` && this.documents.has(parsed.hostname); } catch { return false; }
  }

  html(token: string): {html: string; scripts: boolean} | undefined {
    const found = this.documents.get(token);
    return found ? {html: found.html, scripts: found.scripts} : undefined;
  }

  respond(url: string): ReportResponse {
    const fail = (status: number, text: string): ReportResponse => ({status, headers: {'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store'}, body: text});
    let parsed: URL;
    try { parsed = new URL(url); } catch { return fail(400, 'Bad request'); }
    const found = parsed.protocol === `${REPORT_SCHEME}:` && TOKEN.test(parsed.hostname) ? this.documents.get(parsed.hostname) : undefined;
    if (!found) return fail(404, 'This view has expired. Reopen it from the conversation.');
    // One document, no subresources: everything a report needs is inline.
    if (parsed.pathname !== '/' && parsed.pathname !== '/index.html') return fail(404, 'Not found');
    return {status: 200, body: prepareReportHtml(found.html, found.scripts, {themed: found.themed, measure: found.measure}), headers: {
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': reportCsp(found.scripts, found.network, found.measure), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), display-capture=(), usb=(), serial=(), hid=()',
    }};
  }
}

// ---- PDF export (main process; never inside the sandbox) ----------------------------------------------------------------

/** The slice of Electron the printer needs, so the logic is testable without a window. */
export interface PrintWindow {
  loadURL(url: string): Promise<void>;
  printToPDF(options: {printBackground: boolean; preferCSSPageSize: boolean}): Promise<Buffer>;
  destroy(): void;
}
export interface PrintDeps {
  createWindow(): PrintWindow;
  settleMs?: number;
  timeoutMs?: number;
  wait?(ms: number): Promise<void>;
}

/**
 * Renders a registered document in a hidden, sandboxed window on a throwaway session (no preload, no Node, network cancelled
 * by the caller's session filter, CSP as served) and returns the PDF. Always destroys the window.
 */
export async function printReport(registry: ReportRegistry, token: string, deps: PrintDeps): Promise<Buffer> {
  const document = registry.html(token);
  if (!document) throw new Error('This report has expired. Reopen it from the conversation and try again.');
  const url = `${REPORT_SCHEME}://${token}/index.html`;
  const wait = deps.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const window = deps.createWindow();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The report took too long to load for printing.')), deps.timeoutMs ?? 20_000); });
    await Promise.race([window.loadURL(url), timeout]);
    // Scripts that draw the page (a chart library, a table builder) get a moment to finish before the page is laid out for print.
    await Promise.race([wait(deps.settleMs ?? 600), timeout]);
    return await Promise.race([window.printToPDF({printBackground: true, preferCSSPageSize: true}), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    try { window.destroy(); } catch { /* already gone */ }
  }
}
