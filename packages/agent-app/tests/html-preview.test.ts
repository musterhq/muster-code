/** #html-preview: agent pages inline (render_html), spin-up previews (preview_open / preview_close), the web-server probe and
 *  the sandbox's security rules, with fakes for the browser, the file system and the network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {BrowserBridge, agentBrowserOwner} from '../src/main/agent-tools/browser-bridge.ts';
import {BROWSER_TOOL_SPECS, PREVIEW_TOOL_NAMES} from '../src/main/agent-tools/browser-tools.ts';
import {HtmlRenderStore} from '../src/main/agent-tools/html-render-store.ts';
import {ReportRegistry, reportCsp} from '../src/main/report-origin.ts';
import {WebProbe} from '../src/runtime/listening-ports.ts';
import {computerAction} from '../src/shared/computer-use.ts';
import {HTML_RENDER_MAX_BYTES, htmlRenderIdOf, htmlRenderRef, isHtmlRenderTool, readReportHeight, readReportLink, sanitizeHtmlRenderTheme} from '../src/shared/html-render.ts';
import {describeLoadError, isWebResponse, looksLikeServerDown, previewFilePath, previewUrl} from '../src/shared/preview.ts';
import {prepareReportHtml, REPORT_HEIGHT_SCRIPT, THEME_BOOTSTRAP_SCRIPT} from '../src/shared/report-html.ts';
import {classifyTool} from '../src/renderer/components/toolPresentation.ts';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `muster-${name}-`));

// ---- the sandbox: CSP, served document, frame messages -------------------------------------------------------------------

test('no network by default; an allowed page gets https only, never http, file:, frames, workers, forms or eval', () => {
  const local = reportCsp(true);
  assert.doesNotMatch(local, /https?:|file:|\*|unsafe-eval|'self'/);
  assert.ok(local.includes("connect-src 'none'"));
  const net = reportCsp(true, true);
  for (const directive of ["script-src 'unsafe-inline' https:", "style-src 'unsafe-inline' https:", 'img-src data: blob: https:', 'font-src data: https:', 'connect-src https:', "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "default-src 'none'"]) assert.ok(net.includes(directive), directive);
  assert.doesNotMatch(net, /http:|file:|muster|\*|unsafe-eval|'self'|wss?:/, 'nothing but https: is added');
  assert.ok(reportCsp(false, true).includes("script-src 'none'") && reportCsp(false, true).includes("connect-src 'none'"), 'a page that must not run never fetches');
});

test('the served page carries the network grant main gave it, and the theme bootstrap only when themed', () => {
  const registry = new ReportRegistry();
  const plain = registry.register({html: '<html><head><title>T</title></head><body><script>run()</script></body></html>'});
  const plainBody = registry.respond(plain.url);
  assert.equal(plainBody.headers['content-security-policy'], reportCsp(true, false));
  assert.doesNotMatch(plainBody.body, /muster-theme/, 'an ordinary report is not themed');
  const themed = registry.register({html: '<html><head><title>T</title><script>run()</script></head></html>', themed: true, network: true});
  const served = registry.respond(themed.url);
  assert.equal(served.headers['content-security-policy'], reportCsp(true, true));
  const order = ['<style id="muster-theme">', THEME_BOOTSTRAP_SCRIPT, REPORT_HEIGHT_SCRIPT, '<script>run()</script>'].map(part => served.body.indexOf(part));
  assert.ok(order.every(index => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]!), 'theme, bootstrap and height reporter run before the page');
  // A page that may not run gets no bootstrap even when asked to be themed.
  assert.doesNotMatch(prepareReportHtml('<p>x</p>', false, {themed: true}), /<script/);
});

test('injection lands in <head>, never inside <header> or another tag that starts with "head"', () => {
  const out = prepareReportHtml('<!doctype html><html lang="en"><body><header><h1>T</h1></header></body></html>', true, {themed: true});
  assert.ok(out.indexOf('<head><meta charset') > 0 && out.indexOf('<head>') < out.indexOf('<header>'));
  assert.match(out.slice(out.indexOf('<header>')), /^<header><h1>T<\/h1><\/header>/, 'the header is untouched');
});

test('frame messages: heights are clamped numbers; links are http(s) only, without credentials', () => {
  assert.equal(readReportHeight({muster: 'report-height', height: 10.2}), 11);
  assert.equal(readReportHeight({muster: 'report-height', height: 1e12}), 100_000);
  for (const bad of [null, 'x', {muster: 'report-height', height: -1}, {muster: 'report-height', height: '9'}, {muster: 'other', height: 9}]) assert.equal(readReportHeight(bad), undefined);
  assert.deepEqual(readReportLink({muster: 'report-link', url: 'https://example.com/a', metaKey: true}), {url: 'https://example.com/a', external: true});
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'muster-report://aa/index.html', 'muster-plugin://x', 'https://user:pw@example.com', 'chrome://settings', 'x'.repeat(5000)]) {
    assert.equal(readReportLink({muster: 'report-link', url}), undefined, url.slice(0, 40));
  }
});

test('theme variables are sanitized: no rule or tag can be closed from a value or a name', () => {
  const theme = sanitizeHtmlRenderTheme({appearance: 'light', variables: {'--foreground': 'red;}</style><script>x()</script>', 'color': 'blue', '--Bad Name': 'x', '--chart-1': '#123456'}})!;
  assert.equal(theme.appearance, 'light');
  assert.deepEqual(Object.keys(theme.variables).sort(), ['--chart-1', '--foreground']);
  assert.doesNotMatch(theme.variables['--foreground']!, /[;{}<>]/);
  assert.equal(sanitizeHtmlRenderTheme('nope'), undefined);
  // The in-page bootstrap applies the same rules to anything it receives.
  assert.ok(THEME_BOOTSTRAP_SCRIPT.includes('e.source===parent'), 'theme messages only from the parent window');
  assert.ok(THEME_BOOTSTRAP_SCRIPT.includes('/^https?:$/.test(u.protocol)'), 'only http(s) links leave the page');
  assert.doesNotThrow(() => new Function(THEME_BOOTSTRAP_SCRIPT.replace(/^<script>|<\/script>$/g, '')), 'the bootstrap parses');
});

// ---- render_html store -----------------------------------------------------------------------------------------------

test('the page store: random ids, bounded size, ids that cannot walk the file system, network only when asked and allowed', () => {
  const dir = tmp('renders'), store = new HtmlRenderStore(dir, 3);
  const page = store.create({chatId: 'c1', title: '  Sales\n dashboard ', html: '<h1>Hi</h1>'});
  assert.match(page.id, /^[a-f0-9]{32}$/);
  assert.equal(page.title, 'Sales dashboard');
  assert.equal(page.networkRequested, false); assert.equal(page.networkAllowed, false);
  assert.equal((store.view(page.id) as Record<string, unknown>).chatId, undefined, 'the renderer never gets the chat binding');
  assert.equal(fs.statSync(path.join(dir, `${page.id}.json`)).mode & 0o777, 0o600);
  for (const id of ['../x', `${page.id}/../../etc/passwd`, 'A'.repeat(32), '', 42]) assert.equal(store.get(id), undefined);
  assert.throws(() => store.create({chatId: 'c1', title: 'x', html: 'x'.repeat(HTML_RENDER_MAX_BYTES + 1)}), /at most/);
  assert.throws(() => store.create({chatId: 'c1', title: 'x', html: '  '}), /needs the page/);
  assert.throws(() => store.allowNetwork(page.id), /did not ask/, 'a page that never asked cannot be given network');
  const asks = store.create({chatId: 'c1', title: 'Map', html: '<p>map</p>', network: true});
  assert.equal(asks.networkAllowed, false);
  assert.equal(store.allowNetwork(asks.id).networkAllowed, true);
  assert.equal(store.get(asks.id)!.networkAllowed, true, 'the grant is persisted');
  assert.equal(store.create({chatId: 'c1', title: 'x', html: '<p>x</p>', network: true, allowNetwork: true}).networkAllowed, true);
  assert.equal(store.create({chatId: 'c1', title: 'x', html: '<p>x</p>', allowNetwork: true}).networkAllowed, false, 'allowed only what was asked for');
  assert.ok(fs.readdirSync(dir).length <= 3, 'bounded number of pages');
});

// ---- the bridge: render_html, preview_open, preview_close -------------------------------------------------------------

function fakeBridge(options: {permissionMode?: string; folder?: string; files?: Record<string, string>; links?: Record<string, string>; loadError?: {url: string; code: number; description: string}} = {}) {
  const emitted: Array<Record<string, unknown>> = [], opened: string[] = [], closed: string[] = [];
  const tabs = new Set<string>();
  let url = 'about:blank';
  const page = {attached: true, fill: true, state: () => ({owner: 'o', url, title: 'App'} as never), contents: {
    executeJavaScriptInIsolatedWorld: async () => ({url, title: 'App', outline: '- button "Go" [ref=e1]', text: 'hello'}),
    sendInputEvent() {}, insertText: async () => {}, isLoading: () => false, getZoomFactor: () => 1,
  }};
  const browser = {
    agentOpen: (owner: string, _profile: string, target?: string) => { tabs.add(owner); if (target) { url = target; opened.push(target); } return page.state(); },
    hasTab: (owner: string) => tabs.has(owner), agentPage: () => page, back: () => page.state(), reload: () => page.state(), console: () => [],
    status: () => ({owner: 'o', url, title: 'App', ...(options.loadError ? {loadError: options.loadError} : {})} as never),
    frame: async () => ({dataUrl: 'data:image/jpeg;base64,AA', width: 320, height: 200, url, title: 'App'}),
    close: (owner: string) => { tabs.delete(owner); closed.push(owner); },
  };
  const renders = new HtmlRenderStore(tmp('bridge-renders'));
  const files = options.files ?? {}, links = options.links ?? {};
  const bridge = new BrowserBridge({dir: tmp('bridge'), browser, execPath: '/usr/bin/env', script: '/x/browser-mcp.cjs', emit: event => emitted.push(event as never), lease: async () => 'agent',
    renders, readFile: async file => { if (!(file in files)) throw new Error('ENOENT'); return files[file]!; }, realpath: async file => { if (file in links) return links[file]!; if (file in files || file === options.folder) return file; throw new Error('ENOENT'); },
    snapshot: async () => ({chats: [{id: 'c1', mode: 'agent', permissionMode: options.permissionMode ?? 'workspace', ...(options.folder ? {folderId: 'f1'} : {})}], folders: options.folder ? [{id: 'f1', path: options.folder, name: 'app'}] : [], projects: [], version: 1} as never)});
  const text = (result: {content: Array<{type: string; text?: string}>}) => result.content.map(part => part.text ?? '').join('\n');
  return {bridge, emitted, opened, closed, renders, text};
}

test('render_html stores the page and answers with its reference; the tool row finds it on every route shape', async () => {
  const {bridge, renders, text} = fakeBridge();
  const result = await bridge.call('c1', 'render_html', {title: 'Q3', html: '<h1>Q3</h1>'});
  assert.notEqual(result.isError, true);
  const id = /muster-html:([a-f0-9]{32})/.exec(text(result))![1]!;
  assert.equal(renders.get(id)!.chatId, 'c1');
  assert.match(text(result), /no network access/);
  // Codex (result object), Claude Code / OpenCode / HTTP (normalised to mcpToolCall), and an output string.
  const shapes: Array<Record<string, unknown>> = [
    {type: 'mcpToolCall', server: 'muster_browser', tool: 'render_html', arguments: {title: 'Q3'}, result: {content: [{type: 'text', text: text(result)}]}},
    {type: 'mcpToolCall', server: 'muster_browser', tool: 'render_html', arguments: '{"title":"Q3"}', result: text(result)},
    {type: 'dynamicToolCall', tool: 'mcp__muster_browser__render_html', arguments: {title: 'Q3'}, output: text(result)},
  ];
  for (const data of shapes) {
    assert.equal(isHtmlRenderTool(data), true);
    assert.equal(htmlRenderIdOf(data), id);
    const row = classifyTool(data);
    assert.equal(row.verb, 'Showed'); assert.equal(row.subject, 'Q3'); assert.equal(row.htmlRender?.id, id);
    assert.equal(computerAction(data), undefined, 'not a browser step');
  }
  assert.equal(isHtmlRenderTool({type: 'mcpToolCall', server: 'someone_else', tool: 'render_html'}), false, 'another server\'s render_html is not ours');
  assert.equal(htmlRenderIdOf({result: htmlRenderRef('zz')}), undefined);
  const tooBig = await bridge.call('c1', 'render_html', {title: 'x', html: 'x'.repeat(HTML_RENDER_MAX_BYTES + 10)});
  assert.equal(tooBig.isError, true);
});

test('network for a page: asked on the card in Workspace mode, granted up front in Full access (which never prompts)', async () => {
  const workspace = fakeBridge();
  const asked = await workspace.bridge.call('c1', 'render_html', {title: 'Map', html: '<p>m</p>', network: true});
  const askedId = /muster-html:([a-f0-9]{32})/.exec(workspace.text(asked))![1]!;
  assert.equal(workspace.renders.get(askedId)!.networkAllowed, false);
  assert.match(workspace.text(asked), /user is asked on the card/);
  const full = fakeBridge({permissionMode: 'full'});
  const granted = await full.bridge.call('c1', 'render_html', {title: 'Map', html: '<p>m</p>', network: true});
  assert.equal(full.renders.get(/muster-html:([a-f0-9]{32})/.exec(full.text(granted))![1]!)!.networkAllowed, true);
  assert.match(full.text(granted), /Network access \(https only\) is allowed/);
});

// Spec: MUS-SPEC-21-578B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-578b)
test('preview_open(url) opens the agent tab, shows the mini player (or the pane) and reports an unreachable server', async () => {
  const {bridge, emitted, opened, text} = fakeBridge();
  const ok = await bridge.call('c1', 'preview_open', {url: '0.0.0.0:5173'});
  assert.notEqual(ok.isError, true);
  assert.deepEqual(opened, ['http://localhost:5173/']);
  const shown = emitted.find(event => event.type === 'previewShown')!;
  assert.equal(shown.owner, agentBrowserOwner('c1')); assert.equal(shown.panel, false);
  assert.match(text(ok), /mini player/);
  await bridge.call('c1', 'preview_open', {url: 'http://localhost:5173', panel: true});
  assert.equal(emitted.filter(event => event.type === 'previewShown').at(-1)!.panel, true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'muster-report://x/index.html', 'ftp://x', '']) assert.equal((await bridge.call('c1', 'preview_open', {url})).isError, true, url);
  const down = fakeBridge({loadError: {url: 'http://localhost:3000/', code: -102, description: 'ERR_CONNECTION_REFUSED'}});
  const failed = await down.bridge.call('c1', 'preview_open', {url: 'http://localhost:3000'});
  assert.equal(failed.isError, true);
  assert.match(down.text(failed), /Connection refused \(-102\)[\s\S]*dev server/);
  assert.ok(down.emitted.some(event => event.type === 'previewShown'), 'the person still sees the preview (with its unreachable page)');
});

test('preview_open(file) shows a workspace .html file, never one outside the folder (paths or symlinks), never a non-HTML file', async () => {
  const folder = '/work/app';
  const {bridge, emitted, renders, text} = fakeBridge({folder, files: {'/work/app/dist/report.html': '<h1>R</h1>', '/work/app/notes.txt': 'x', '/etc/passwd.html': 'secret', '/work/app/link.html': ''}, links: {'/work/app/link.html': '/etc/passwd.html'}});
  const ok = await bridge.call('c1', 'preview_open', {file: 'dist/report.html'});
  assert.notEqual(ok.isError, true, text(ok));
  const event = emitted.find(item => item.type === 'previewFile')!;
  assert.equal(renders.get(event.renderId)!.html, '<h1>R</h1>');
  assert.equal(event.title, 'report.html');
  for (const file of ['../../etc/passwd.html', '/etc/passwd.html', 'notes.txt', 'link.html', 'missing.html']) assert.equal((await bridge.call('c1', 'preview_open', {file})).isError, true, file);
  assert.equal(emitted.filter(item => item.type === 'previewFile').length, 1, 'nothing else was opened');
  const noFolder = fakeBridge();
  assert.match(noFolder.text(await noFolder.bridge.call('c1', 'preview_open', {file: 'a.html'})), /no folder/);
});

test('preview_close closes the agent tab and tells the renderer; the card button opens a preview the same way', async () => {
  const {bridge, emitted, closed} = fakeBridge();
  assert.match((await bridge.call('c1', 'preview_close', {})).content[0]!.type, /text/);
  await bridge.call('c1', 'preview_open', {url: 'http://localhost:5173'});
  await bridge.call('c1', 'preview_close', {});
  assert.deepEqual(closed, [agentBrowserOwner('c1')]);
  assert.ok(emitted.some(event => event.type === 'previewClosed'));
  const opened = await bridge.openPreview('c1', 'localhost:4321');
  assert.equal(opened.url, 'http://localhost:4321/');
  await assert.rejects(bridge.openPreview('c1', 'file:///etc/passwd'), /Only http and https/);
  await assert.rejects(bridge.openPreview('nope', 'http://localhost:1'), /no longer exists/);
  await assert.rejects(bridge.openPreview('../x', 'http://localhost:1'), /Open a chat/);
});

test('the preview tools are offered on every tool route, are not page actions, and read well in the transcript', () => {
  for (const name of PREVIEW_TOOL_NAMES) {
    const spec = BROWSER_TOOL_SPECS.find(item => item.name === name)!;
    assert.ok(spec, name); assert.equal(spec.mutates, false, `${name} works in read-only chats`);
  }
  assert.match(BROWSER_TOOL_SPECS.find(item => item.name === 'render_html')!.description, /--chart-1[\s\S]*network: true/);
  assert.equal(computerAction({type: 'mcpToolCall', server: 'muster_browser', tool: 'preview_open', arguments: {url: 'http://localhost:5173'}})!.label, 'Opened preview of localhost:5173');
  assert.equal(computerAction({type: 'mcpToolCall', server: 'muster_browser', tool: 'preview_open', arguments: {file: '/w/dist/index.html'}})!.object, 'index.html');
  assert.equal(computerAction({type: 'mcpToolCall', server: 'muster_browser', tool: 'preview_close', arguments: {}})!.label, 'Closed the preview');
});

// ---- spin-up detection ------------------------------------------------------------------------------------------------

test('previewUrl and previewFilePath accept what dev servers print and nothing else', () => {
  assert.equal(previewUrl('http://0.0.0.0:3000/app'), 'http://localhost:3000/app');
  assert.equal(previewUrl(':8080'), 'http://localhost:8080/');
  assert.equal(previewUrl('127.0.0.1:5173'), 'http://127.0.0.1:5173/');
  assert.equal(previewUrl('https://example.com'), 'https://example.com/');
  for (const bad of ['file:///x', 'javascript:1', 'about:blank', 'http://a:b@c', 42, '']) assert.equal(previewUrl(bad), undefined);
  assert.equal(previewFilePath('/w/app', 'dist/index.html'), '/w/app/dist/index.html');
  assert.equal(previewFilePath('/w/app', '/w/app/a.htm'), '/w/app/a.htm');
  assert.equal(previewFilePath('/w/app', 'file:///w/app/a.html'), '/w/app/a.html');
  for (const bad of ['../x.html', '/w/app2/a.html', '/w/a.html', 'a.js', 'x\0.html', 'dist/../../a.html']) assert.equal(previewFilePath('/w/app', bad), undefined, bad);
  assert.equal(describeLoadError('net::ERR_CONNECTION_REFUSED'), 'Connection refused');
  assert.equal(describeLoadError('ERR_SOMETHING_NEW'), 'ERR_SOMETHING_NEW');
  assert.equal(looksLikeServerDown('http://localhost:3000', 'ERR_CONNECTION_REFUSED'), true);
  assert.equal(looksLikeServerDown('https://example.com', 'ERR_CONNECTION_REFUSED'), false);
});

test('the web probe: an HTML answer or a redirect is a web server; JSON, errors, timeouts are not; answers are cached', async () => {
  assert.equal(isWebResponse(200, 'text/html; charset=utf-8'), true);
  assert.equal(isWebResponse(302, null, '/app'), true);
  assert.equal(isWebResponse(302, null, ''), false);
  assert.equal(isWebResponse(200, 'application/json'), false);
  assert.equal(isWebResponse(204, 'text/html'), false);
  assert.equal(isWebResponse(500, 'text/html'), false);
  let now = 0;
  const seen: string[] = [];
  const answers: Record<string, () => Promise<{status: number; contentType: string | null; location: string | null}>> = {
    'http://127.0.0.1:5173/': async () => ({status: 200, contentType: 'text/html', location: null}),
    'http://127.0.0.1:9229/': async () => ({status: 200, contentType: 'application/json', location: null}),
    'https://127.0.0.1:9229/': async () => { throw new Error('ECONNRESET'); },
    'http://127.0.0.1:8443/': async () => { throw new Error('socket hang up'); },
    'https://127.0.0.1:8443/': async () => ({status: 200, contentType: 'text/html', location: null}),
    'http://127.0.0.1:7000/': () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5)),
    'https://127.0.0.1:7000/': () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5)),
  };
  const probe = new WebProbe({now: () => now, probe: async url => { seen.push(url); return answers[url]!(); }});
  assert.equal(await probe.isWeb(1, 5173), true);
  assert.equal(await probe.isWeb(2, 9229), false, 'a debugger port answering JSON is not a page');
  assert.equal(await probe.isWeb(3, 8443), true, 'https-only dev servers count');
  assert.equal(await probe.isWeb(4, 7000), false);
  const before = seen.length;
  assert.equal(await probe.isWeb(1, 5173), true);
  assert.equal(seen.length, before, 'cached');
  now += 20_000;
  await probe.isWeb(1, 5173);
  assert.equal(seen.length, before + 1, 're-probed after the cache expires');
});
