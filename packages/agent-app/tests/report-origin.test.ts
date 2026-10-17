/** Visuals program A: untrusted HTML is served from its own origin under a no-network CSP; PDF export runs in main, never in the sandbox. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {MAX_REPORT_BYTES, prepareReportHtml, printReport, REPORT_HEIGHT_SCRIPT, REPORT_SCHEME, ReportRegistry, reportCsp, type PrintWindow} from '../src/main/report-origin.ts';

const origin = (url: string) => url.replace(/\/index\.html.*$/, '');

test('a registered report is served from its own random origin with the strict CSP and hardening headers', () => {
  const registry = new ReportRegistry();
  const {url, token} = registry.register({html: '<h1>Hi</h1>'});
  assert.match(url, new RegExp(`^${REPORT_SCHEME}://[a-f0-9]{32}/index\\.html\\?v=1$`));
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(registry.allows(url), true);
  assert.equal(registry.allows(`${REPORT_SCHEME}://${'0'.repeat(32)}/index.html`), false, 'unknown tokens');
  assert.equal(registry.allows('https://example.test/'), false);
  assert.equal(registry.allows('not a url'), false);
  const response = registry.respond(url);
  assert.equal(response.status, 200);
  assert.match(response.body, /<h1>Hi<\/h1>/);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['content-security-policy'], reportCsp(true));
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['permissions-policy']!, /camera=\(\)/);
  assert.notEqual(new ReportRegistry().register({html: 'x'}).token, token, 'tokens are random per document');
});

test('the CSP allows no network at all and no way out of the sandbox', () => {
  const csp = reportCsp(true);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "manifest-src 'none'", 'img-src data: blob:', 'font-src data:', "script-src 'unsafe-inline'"]) assert.ok(csp.includes(directive), directive);
  assert.doesNotMatch(csp, /https?:|\*|unsafe-eval|'self'/, 'no remote source, wildcard, eval or own-origin source');
  assert.ok(reportCsp(false).includes("script-src 'none'"), 'a page that must not run gets no script source');
  assert.doesNotMatch(reportCsp(false), /unsafe-inline'; style/, 'sanity: script-src is not unsafe-inline when scripts are off');
});

test('only the one document is served: no subresources, no traversal, expired and malformed URLs fail closed', () => {
  const registry = new ReportRegistry();
  const {url} = registry.register({html: '<p>x</p>'});
  const base = origin(url);
  assert.equal(registry.respond(`${base}/index.html`).status, 200);
  assert.equal(registry.respond(`${base}/`).status, 200);
  for (const path of ['/other.html', '/a/b.js', '/index.html/x', '/favicon.ico', '/%2e%2e/other.html']) assert.equal(registry.respond(`${base}${path}`).status, 404, path);
  // URL parsing resolves `..` before the registry sees the path; either way the only document there is index.html.
  assert.equal(registry.respond(`${base}/../index.html`).status, 200);
  const expired = registry.respond(`${REPORT_SCHEME}://${'a'.repeat(32)}/index.html`);
  assert.equal(expired.status, 404);
  assert.match(expired.body, /expired/);
  assert.equal(expired.headers['content-security-policy'], "default-src 'none'");
  assert.equal(registry.respond('garbage').status, 400);
  assert.equal(registry.respond(`https://example.test/index.html`).status, 404, 'other schemes are not served');
  assert.equal(registry.respond(`${REPORT_SCHEME}://not-a-token/index.html`).status, 404);
});

test('a key re-uses one token across edits and bumps the version; scripts can be switched off per document', () => {
  const registry = new ReportRegistry();
  const first = registry.register({html: '<p>one</p>', key: 'canvas:1', scripts: false});
  const second = registry.register({html: '<p>two</p>', key: 'canvas:1', scripts: false});
  assert.equal(second.token, first.token);
  assert.match(second.url, /\?v=2$/);
  const response = registry.respond(second.url);
  assert.match(response.body, /<p>two<\/p>/);
  assert.doesNotMatch(response.body, /ResizeObserver/, 'no height script in a page that cannot run scripts');
  assert.ok(response.headers['content-security-policy']!.includes("script-src 'none'"));
  assert.notEqual(registry.register({html: '<p>x</p>', key: 'canvas:2'}).token, first.token);
  const loud = registry.register({html: '<p>x</p>'});
  assert.ok(registry.respond(loud.url).body.includes(REPORT_HEIGHT_SCRIPT));
});

test('documents are bounded in size and count; the oldest expire first', () => {
  const registry = new ReportRegistry();
  assert.throws(() => registry.register({html: 'x'.repeat(MAX_REPORT_BYTES + 1)}), /limit is 4 MB/);
  assert.throws(() => registry.register({html: 5 as unknown as string}), /Nothing to show/);
  const first = registry.register({html: 'first'});
  for (let index = 0; index < 60; index++) registry.register({html: `doc ${index}`});
  assert.equal(registry.respond(first.url).status, 404, 'the oldest expired');
  const newest = registry.register({html: 'newest'});
  assert.equal(registry.respond(newest.url).status, 200);
  const big = new ReportRegistry();
  const tokens = Array.from({length: 14}, (_, index) => big.register({html: `${index}`.padEnd(3_900_000, 'x')}));
  assert.equal(big.respond(tokens.at(-1)!.url).status, 200, 'the newest always survives');
  assert.equal(big.respond(tokens[0]!.url).status, 404, 'total size is capped');
  const keyed = new ReportRegistry();
  assert.doesNotThrow(() => { for (let index = 0; index < 5; index++) keyed.register({html: 'y'.repeat(3_000_000), key: 'k'}); }, 'replacing a keyed document does not accumulate');
});

test('prepareReportHtml makes a standards-mode UTF-8 document and puts the height reporter first', () => {
  const full = prepareReportHtml('<!doctype html><html><head><title>T</title></head><body>b</body></html>', true);
  assert.ok(full.startsWith('<!doctype html>'));
  assert.ok(full.indexOf(REPORT_HEIGHT_SCRIPT) < full.indexOf('<title>'), 'before the page’s own head content');
  assert.ok(full.includes('<meta charset="utf-8">'));
  assert.equal((full.match(/<!doctype/gi) ?? []).length, 1);
  const fragment = prepareReportHtml('<p>just a fragment</p>', true);
  assert.ok(fragment.startsWith('<!doctype html><meta charset="utf-8">'));
  assert.ok(fragment.endsWith('<p>just a fragment</p>'));
  const noHead = prepareReportHtml('<html><body>x</body></html>', true);
  assert.match(noHead, /^<!doctype html><html><head><meta charset="utf-8"><script>/);
  const declared = prepareReportHtml('<!DOCTYPE html><body>x</body>', true);
  assert.ok(declared.startsWith('<!DOCTYPE html><meta charset="utf-8">'), 'a declared doctype stays first');
  assert.equal(prepareReportHtml('<meta charset="utf-8"><p>x</p>', false).match(/charset/g)?.length, 1, 'no second charset when one is declared');
  assert.ok(!prepareReportHtml('<p>x</p>', false).includes('<script'), 'no script injected when scripts are off');
  assert.match(REPORT_HEIGHT_SCRIPT, /parent\.postMessage\(\{muster:'report-height',height:h\},'\*'\)/);
  assert.doesNotMatch(REPORT_HEIGHT_SCRIPT, /fetch|XMLHttpRequest|localStorage|document\.cookie|eval|import\(/, 'it reads layout and sends one number');
});

function fakeWindow(overrides: Partial<PrintWindow> = {}): {window: PrintWindow; log: string[]} {
  const log: string[] = [];
  return {log, window: {
    loadURL: async url => { log.push(`load ${url}`); },
    printToPDF: async options => { log.push(`print ${JSON.stringify(options)}`); return Buffer.from('%PDF-1.7'); },
    destroy: () => { log.push('destroy'); },
    ...overrides,
  }};
}

test('PDF export prints a registered report in a hidden window and always destroys it', async () => {
  const registry = new ReportRegistry();
  const {token} = registry.register({html: '<p>x</p>'});
  const {window, log} = fakeWindow();
  const pdf = await printReport(registry, token, {createWindow: () => window, wait: async () => {}});
  assert.equal(pdf.toString(), '%PDF-1.7');
  assert.deepEqual(log, [`load ${REPORT_SCHEME}://${token}/index.html`, 'print {"printBackground":true,"preferCSSPageSize":true}', 'destroy']);
  await assert.rejects(printReport(registry, 'f'.repeat(32), {createWindow: () => window}), /expired/);
  const failing = fakeWindow({printToPDF: async () => { throw new Error('boom'); }});
  await assert.rejects(printReport(registry, token, {createWindow: () => failing.window, wait: async () => {}}), /boom/);
  assert.equal(failing.log.at(-1), 'destroy', 'destroyed on failure');
  const hung = fakeWindow({loadURL: () => new Promise<void>(() => {})});
  await assert.rejects(printReport(registry, token, {createWindow: () => hung.window, timeoutMs: 30, wait: async () => {}}), /too long/);
  assert.equal(hung.log.at(-1), 'destroy', 'destroyed on timeout');
  const throwsOnDestroy = fakeWindow({destroy: () => { throw new Error('already gone'); }});
  await assert.doesNotReject(printReport(registry, token, {createWindow: () => throwsOnDestroy.window, wait: async () => {}}));
});

test('the desktop shell wires the report origin: privileged scheme, frame guard, renderer CSP, PDF save dialog', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /scheme: REPORT_SCHEME, privileges: \{standard: true, secure: true, supportFetchAPI: false\}/);
  assert.match(main, /protocol\.handle\(REPORT_SCHEME, serveReport\)/);
  assert.match(main, /will-frame-navigate[\s\S]{0,200}reports\.allows\(event\.url\)/);
  assert.match(main, /case 'reports\.open'/);
  assert.match(main, /case 'reports\.pdf'/);
  assert.match(main, /dialog\.showSaveDialog\(window, \{ title: 'Export report as PDF'/, 'the person chooses where the PDF goes');
  const print = main.slice(main.indexOf("case 'reports.pdf'"), main.indexOf("case 'browser.open'"));
  assert.match(print, /sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true/, 'the print window has no Node and no preload');
  assert.doesNotMatch(print, /preload/);
  assert.match(main, /muster-report-print/);
  assert.match(main, /callback\(\{cancel: !\/\^\(muster-report\|data\|blob\):\/\.test\(details\.url\)\}\)/, 'the print session cancels every other request');
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /frame-src muster-plugin: muster-report:"/);
  assert.doesNotMatch(html, /unsafe-eval/, 'the renderer CSP stays eval-free (charts run on the expression interpreter)');
});
