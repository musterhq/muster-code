// #771: Muster's own visualize plugin. An agent's page can also be drawn to a PNG that is saved with the chat and attached
// to the reply; the picture is made in a hidden, sandboxed window; and visuals need no other app's plugin cache: Muster's
// coding-client home leaves another app's visualize plugin out and installs Muster's own visualize skill.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {existsSync, lstatSync, readFileSync, readlinkSync} from 'node:fs';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {BrowserBridge} from '../src/main/agent-tools/browser-bridge.ts';
import {BROWSER_TOOL_SPECS} from '../src/main/agent-tools/browser-tools.ts';
import {HtmlRenderStore} from '../src/main/agent-tools/html-render-store.ts';
import {REPORT_SCHEME, ReportRegistry, capturePage, type CaptureWindow} from '../src/main/report-origin.ts';
import {prepareMusterCodexHome} from '../src/runtime/codex-home.ts';
import {computerRunOptions} from '../src/runtime/domains/computer.ts';
import {MUSTER_SKILLS} from '../src/runtime/office-skills.ts';
import {readChatImage} from '../src/runtime/file-assets.ts';
import {localImagePath} from '../src/renderer/local-image-path.ts';
import {COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE, BROWSER_NOTE} from '../src/shared/computer-use.ts';
import {HTML_RENDER_FALLBACK, type HtmlRenderRecord} from '../src/shared/html-render.ts';

const appDir = resolve(import.meta.dirname, '..');
const skillsSource = join(appDir, 'resources', 'skills');
async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'muster-771-')); t.after(() => rm(path, {recursive: true, force: true})); return path; }
const realPng = (width = 640, height = 400) => { const canvas = createCanvas(width, height), g = canvas.getContext('2d'); g.fillStyle = '#1b1c1f'; g.fillRect(0, 0, width, height); g.fillStyle = '#60a5fa'; g.fillRect(40, 40, 200, 120); return canvas.toBuffer('image/png'); };
const text = (result: {content: Array<{type: string; text?: string}>}) => result.content.map(part => part.text ?? '').join('\n');

function bridgeWith(root: string, capture?: (page: HtmlRenderRecord) => Promise<Buffer>) {
  const browser = {agentOpen: () => ({}) as never, hasTab: () => false, agentPage: () => { throw new Error('no page'); }, back: () => ({}) as never, reload: () => ({}) as never, console: () => [], frame: async () => undefined};
  const renders = new HtmlRenderStore(join(root, 'html-renders'));
  const bridge = new BrowserBridge({dir: join(root, 'agent-tools'), browser, execPath: '/usr/bin/env', script: '/x/browser-mcp.cjs', emit() {}, lease: async () => 'agent', renders,
    ...(capture ? {capture, imagesDir: join(root, 'html-render-images')} : {}),
    snapshot: async () => ({chats: [{id: 'c1', mode: 'agent', permissionMode: 'workspace', folderId: 'f1'}], folders: [{id: 'f1', path: join(root, 'project'), name: 'project'}], projects: [], version: 1} as never)});
  return {bridge, renders};
}

// Spec: MUS-SPEC-21-771E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771e)
test('an agent renders its page to a PNG saved with the chat and attaches it to the reply', async t => {
  const root = await directory(t);
  const captured: HtmlRenderRecord[] = [];
  const {bridge, renders} = bridgeWith(root, async page => { captured.push(page); return realPng(); });
  const result = await bridge.call('c1', 'render_html', {title: 'Revenue by month', html: '<h1>Revenue</h1>', image: true});
  assert.notEqual(result.isError, true, text(result));
  const id = /muster-html:([a-f0-9]{32})/.exec(text(result))![1]!;
  assert.equal(renders.get(id)!.chatId, 'c1', 'the page is still shown inline');
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.id, id); assert.equal(captured[0]!.networkAllowed, false, 'the capture gets the page with its own network grant');
  const path = /PNG of it at (\/\S+\.png)/.exec(text(result))?.[1];
  assert.ok(path, text(result));
  assert.ok(path!.startsWith(join(root, 'html-render-images', 'c1') + '/'), 'saved with the chat, not in the project folder');
  assert.ok(!existsSync(join(root, 'project')), 'nothing written into the project');
  const image = await readChatImage(path!);
  assert.equal(image.mime, 'image/png'); assert.equal(image.width, 640); assert.equal(image.height, 400);
  assert.equal(lstatSync(path!).mode & 0o777, 0o600);
  const markdown = /(!\[[^\]]*\]\([^)]+\))/.exec(text(result))?.[1];
  assert.ok(markdown, 'the answer gives the Markdown to attach it');
  assert.equal(localImagePath(/\]\(([^)]+)\)/.exec(markdown!)![1]), path, 'the Markdown is a local reply image, so the reply and the turn gallery show it');
  assert.match(markdown!, /^!\[Revenue by month\]/);

  // A capture that fails still shows the page and says so.
  const failing = bridgeWith(await directory(t), async () => { throw new Error('GPU process gone'); });
  const failed = await failing.bridge.call('c1', 'render_html', {title: 'X', html: '<p>x</p>', image: true});
  assert.notEqual(failed.isError, true);
  assert.match(text(failed), /muster-html:[a-f0-9]{32}/);
  assert.match(text(failed), /could not make a picture of it: GPU process gone/i);
  // Not a PNG: refused, never saved.
  const bogus = bridgeWith(await directory(t), async () => Buffer.from('not a png'));
  assert.match(text(await bogus.bridge.call('c1', 'render_html', {title: 'X', html: '<p>x</p>', image: true})), /could not make a picture/i);
  // No capture in this window (Muster Server, tests): the page shows, and the answer says pictures are not available.
  const none = bridgeWith(await directory(t));
  assert.match(text(await none.bridge.call('c1', 'render_html', {title: 'X', html: '<p>x</p>', image: true})), /pictures of pages are not available/i);
  // Without image: true nothing is drawn.
  await bridge.call('c1', 'render_html', {title: 'Y', html: '<p>y</p>'});
  assert.equal(captured.length, 1);
});

// Spec: MUS-SPEC-21-771F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771f)
test('the page is drawn to a PNG in a hidden window sized to its content, with network only when granted, and the window always closes', async () => {
  const registry = new ReportRegistry();
  const page = (networkAllowed: boolean): HtmlRenderRecord => ({id: 'a'.repeat(32), chatId: 'c1', title: 'P', html: '<h1>P</h1>', networkRequested: networkAllowed, networkAllowed, createdAt: ''});
  const theme = {appearance: 'light' as const, variables: HTML_RENDER_FALLBACK.light};
  const fake = (overrides: Partial<CaptureWindow> = {}, height = 9000) => {
    const log: string[] = [];
    const window: CaptureWindow = {
      loadURL: async url => { log.push(`load ${url}`); }, contentHeight: async () => height,
      setSize: (width, h) => { log.push(`size ${width}x${h}`); }, capture: async () => { log.push('capture'); return realPng(10, 10); }, destroy: () => { log.push('destroy'); }, ...overrides,
    };
    return {window, log};
  };
  const networks: boolean[] = [];
  const first = fake();
  const png = await capturePage(registry, page(false), {theme, createWindow: ({network}) => { networks.push(network); return first.window; }, wait: async () => {}});
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(first.log[0]!.startsWith(`load ${REPORT_SCHEME}://`), true);
  assert.match(first.log[0]!, /\/index\.html\?v=1#muster-theme=/);
  assert.equal(JSON.parse(decodeURIComponent(first.log[0]!.split('#muster-theme=')[1]!)).appearance, 'light', 'drawn in the app theme');
  assert.deepEqual(first.log.slice(1), ['size 720x4000', 'capture', 'destroy'], 'sized to the page, clamped');
  const token = /muster-report:\/\/([a-f0-9]{32})\//.exec(first.log[0]!)![1]!;
  const served = registry.respond(`${REPORT_SCHEME}://${token}/index.html`);
  assert.match(served.headers['content-security-policy']!, /connect-src 'none'/, 'no network without a grant');
  assert.match(served.body, /id="muster-theme"/, 'themed page');
  const granted = fake({}, 300);
  await capturePage(registry, page(true), {theme, createWindow: ({network}) => { networks.push(network); return granted.window; }, wait: async () => {}});
  assert.deepEqual(networks, [false, true], 'the window gets network only for a page that has it');
  assert.ok(granted.log.includes('size 720x300'));
  const grantedToken = /muster-report:\/\/([a-f0-9]{32})\//.exec(granted.log[0]!)![1]!;
  assert.match(registry.respond(`${REPORT_SCHEME}://${grantedToken}/index.html`).headers['content-security-policy']!, /connect-src https:/);

  const failing = fake({capture: async () => { throw new Error('boom'); }});
  await assert.rejects(capturePage(registry, page(false), {theme, createWindow: () => failing.window, wait: async () => {}}), /boom/);
  assert.equal(failing.log.at(-1), 'destroy', 'closed on failure');
  const hung = fake({loadURL: () => new Promise<void>(() => {})});
  await assert.rejects(capturePage(registry, page(false), {theme, createWindow: () => hung.window, timeoutMs: 30, wait: async () => {}}), /too long/);
  assert.equal(hung.log.at(-1), 'destroy', 'closed on timeout');
});

// Spec: MUS-SPEC-21-771G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771g)
test('Muster\'s home leaves out another app\'s visualize plugin and installs Muster\'s own visualize skill', async t => {
  const root = await directory(t), source = join(root, 'person-home'), home = join(root, 'muster-home');
  for (const dir of ['plugins/cache/bundled-market/visualize/1.0.57/skills/visualize', 'plugins/cache/bundled-market/latex/1.0', 'plugins/cache/other-market/visualize/2.0',
    'plugins/cache/curated/github/1.0', 'skills/visualize', 'skills/my-skill']) await mkdir(join(source, dir), {recursive: true});
  await writeFile(join(source, 'plugins/cache/bundled-market/visualize/1.0.57/skills/visualize/SKILL.md'), '---\nname: visualize\n---\nAnother app.\n');
  await writeFile(join(source, 'skills/visualize/SKILL.md'), '---\nname: visualize\n---\nAnother app.\n');
  await mkdir(home, {recursive: true});
  await symlink(join(source, 'plugins'), join(home, 'plugins'));
  for (let run = 0; run < 2; run++) prepareMusterCodexHome(source, home, {musterSkills: skillsSource});
  const linkTo = (path: string) => { try { return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null; } catch { return null; } };
  assert.ok(!existsSync(join(home, 'plugins/cache/bundled-market/visualize')), 'another app\'s visualize plugin is not linked in');
  assert.ok(!existsSync(join(home, 'plugins/cache/other-market/visualize')), 'in any marketplace');
  assert.equal(linkTo(join(home, 'plugins/cache/bundled-market/latex')), join(source, 'plugins/cache/bundled-market/latex'), 'the marketplace\'s other plugins still load');
  assert.equal(linkTo(join(home, 'plugins/cache/curated')), join(source, 'plugins/cache/curated'));
  assert.equal(linkTo(join(home, 'skills/my-skill')), join(source, 'skills/my-skill'));
  assert.equal(linkTo(join(home, 'skills/visualize')), null);
  assert.equal(readFileSync(join(home, 'skills/visualize/SKILL.md'), 'utf8'), readFileSync(join(skillsSource, 'visualize/SKILL.md'), 'utf8'), 'Muster\'s visualize skill is installed');
  assert.equal(readFileSync(join(source, 'skills/visualize/SKILL.md'), 'utf8'), '---\nname: visualize\n---\nAnother app.\n', 'the person\'s home is untouched');
  assert.ok(existsSync(join(source, 'plugins/cache/bundled-market/visualize/1.0.57')));
});

// Spec: MUS-SPEC-21-771H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771h)
test('with no other app\'s plugin cache, an agent chat is told to visualize with Muster\'s own tools', async t => {
  const root = await directory(t), source = join(root, 'empty-home'), home = join(root, 'muster-home');
  await mkdir(source);
  prepareMusterCodexHome(source, home, {musterSkills: skillsSource});
  assert.ok(MUSTER_SKILLS.includes('visualize'));
  const skill = readFileSync(join(home, 'skills/visualize/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: visualize\ndescription: .{40,}/m);
  for (const word of [/render_html/, /image: true/, /```mermaid/, /```chart/]) assert.match(skill, word);
  assert.doesNotMatch(skill, /\bcodex\b|chatgpt|openai|cursor|\bt3\b|claude/i, 'names no other product');
  // Turn notes on a machine with Muster's computer use and on one without it.
  const launcher = join(root, 'browser-launcher'); await writeFile(launcher, '#!/bin/sh\n');
  for (const computer of [launcher, undefined]) {
    const notes = computerRunOptions({id: 'c1', mode: 'agent'}, launcher, computer)!.developerInstructions;
    assert.match(notes, /render_html/); assert.match(notes, /image: true/);
    assert.doesNotMatch(notes, /visualize plugin/i, 'never sends the agent to another app\'s visualize plugin');
  }
  for (const note of [COMPUTER_USE_NOTE, MUSTER_COMPUTER_NOTE, BROWSER_NOTE]) assert.doesNotMatch(note, /visualize plugin/i);
  const spec = BROWSER_TOOL_SPECS.find(tool => tool.name === 'render_html')!;
  assert.equal((spec.inputSchema as {properties: Record<string, {type: string}>}).properties.image?.type, 'boolean');
});
