/** #778: syntax colours stay on in large files, windowed views, Find and blame. A stand-in worker colours every token and
 *  records what each view asks for, so the suite sees which rows are coloured and that a big file is never sent whole.
 *  Run via scripts/test-renderer.mjs. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require = createRequire(import.meta.url), {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(window.document, {oninput: null});
const saved = new Map<string, string>();
const storage = {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); }};

// The stand-in for syntax-highlight-worker: colours every line, answers whole-source and block requests like the real one.
const BLOCK = 256, COLOUR = '#abcdef';
interface WorkerMessage { id: number; type?: 'blocks' | 'close'; doc: number; source?: string; from: number; to: number }
const requests: Array<Omit<WorkerMessage, 'source'> & {source?: number}> = [];
const rowsOf = (lines: string[]) => lines.map(line => line ? [{content: line, color: COLOUR}] : []);
class FakeHighlightWorker {
  onmessage?: (event: {data: unknown}) => void;
  onerror?: () => void;
  private docs = new Map<number, string[]>();
  postMessage(message: WorkerMessage) {
    requests.push({...message, source: message.source === undefined ? undefined : message.source.length});
    setTimeout(() => {
      if (message.type === 'close') { this.docs.delete(message.doc); return; }
      if (message.type === 'blocks') {
        if (message.source !== undefined) this.docs.set(message.doc, message.source.split('\n'));
        const lines = this.docs.get(message.doc);
        if (!lines) { this.onmessage?.({data: {id: message.id, missing: true}}); return; }
        const blocks = [];
        for (let index = message.from; index <= message.to && index * BLOCK < lines.length; index++) blocks.push({start: index * BLOCK, rows: rowsOf(lines.slice(index * BLOCK, (index + 1) * BLOCK))});
        this.onmessage?.({data: {id: message.id, blocks}});
        return;
      }
      const whole = message.source ?? '';
      this.onmessage?.({data: {id: message.id, rows: whole.length > 1024 * 1024 ? null : rowsOf(whole.split('\n'))}});
    }, 0);
  }
  terminate() {}
}
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver, ResizeObserver: class {observe() {} disconnect() {} unobserve() {}}, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, localStorage: storage, sessionStorage: storage, Worker: FakeHighlightWorker});
const styles = () => ({getPropertyValue: () => '', direction: 'ltr', position: 'static', overflow: 'visible', display: 'block', animationName: 'none', transitionProperty: 'none', transitionDuration: '0s', animationDuration: '0s'});
Object.assign(globalThis, {getComputedStyle: styles}); window.getComputedStyle = styles;
// linkedom does no layout: give the scroller a scrollTop, a 600px viewport and 21px rows, and let the table move as it scrolls.
const tops = new WeakMap<object, number>();
Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {get() { return tops.get(this) ?? 0; }, set(value: number) { tops.set(this, value); }});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {get() { return 600; }});
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const scroller = this.closest?.('.code-scroll');
  const top = this.classList.contains('virtual-row-source') ? 40 - (scroller?.scrollTop ?? 0) : 0;
  const height = this.classList.contains('code-scroll') ? 600 : 21;
  return {x: 0, y: top, width: 800, height, left: 0, top, right: 800, bottom: top + height};
};
window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.focus = function () {};
const selection = {isCollapsed: true, rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, toString: () => ''};
window.getSelection = () => selection as unknown as Selection;
Object.assign(globalThis, {getSelection: window.getSelection});

const line = (n: number) => `const value${n} = compute(${n}, 'plain text that pads this line out to about a hundred and twenty characters');`;
const COUNT = 3000; // about 340 KB: past the 256 KB window threshold, well past the old 96 KB colour limit
const big = Array.from({length: COUNT}, (_, i) => line(i + 1)).join('\n') + '\n';
assert.ok(big.length > 300_000 && big.length < 512 * 1024, `fixture is a few hundred KB (${big.length})`);
const small = 'alpha beta\nBeta gamma\nbeta delta\nepsilon\n';
let text = big, path = 'big.ts';
const at = new Date().toISOString();
const chat = {id: 'chat', title: 'Chat', folderId: 'f', pinned: false, archived: false, draft: '', status: 'completed', updatedAt: at, model: 'm', mode: 'agent'};
const snapshot = {version: 1, chats: [chat], folders: [{id: 'f', name: 'Repo', path: '/repo'}], projects: [], activeChatId: 'chat'};
const sha = 'a'.repeat(40);
const commits = {[sha]: {sha, short: 'aaaaaaa', author: 'Ada', authoredAt: at, summary: 'first', uncommitted: false}};
window.muster = {subscribe() { return () => {}; }, async invoke(command: string, input: {path: string}) {
  if (command === 'app.snapshot') return snapshot;
  if (command === 'chat.timeline') return {items: [], revision: 0};
  if (command === 'settings.get') return {values: {}};
  if (command === 'files.read') return {path: input.path, text, truncated: false, revision: 'r1'};
  if (command === 'files.openWith.apps') return {apps: []};
  if (command === 'files.annotations.list' || command === 'files.list') return [];
  if (command === 'review.baselines') return [];
  if (command === 'git.blame') return {lines: Array.from({length: COUNT}, () => sha), commits, truncated: false};
  return undefined;
}};
const React = await import('react');
const {createRoot} = await import('react-dom/client');
Object.assign(globalThis, {IS_REACT_ACT_ENGINE: false});
const store = await import('../src/renderer/store');
const {FileTab} = await import('../src/renderer/components/FileTab');
const {InlineFileSource} = await import('../src/renderer/components/InlineFileSource');
const {BlameView} = await import('../src/renderer/components/BlameView');
await store.boot(); await delay(30);
const errors: unknown[] = [];
const host = document.getElementById('root')!;
const root = createRoot(host, {onUncaughtError: (error: unknown) => errors.push(error)});
const until = async (ok: () => boolean, label: string) => { for (let i = 0; i < 150 && !ok(); i++) await delay(20); assert.ok(ok(), label); };
const nodes = () => host.querySelectorAll('*').length;
const painted = () => [...host.querySelectorAll('.code-line span[style]')].filter(span => (span.getAttribute('style') ?? '').includes('abcdef')).length;
const mountedRows = () => host.querySelectorAll('tr[data-line]').length;
const sourcesSent = () => requests.filter(request => typeof request.source === 'number');
const scrollTo = async (top: number) => { const scroller = host.querySelector<HTMLElement>('.code-scroll')!; scroller.scrollTop = top; scroller.dispatchEvent(new window.Event('scroll')); await delay(40); };
const type = async (value: string) => {
  const input = host.querySelector('.file-find-bar input')! as HTMLInputElement & Record<string, {onChange: (event: unknown) => void}>;
  Object.defineProperty(input, 'value', {configurable: true, get: () => value, set: () => {}});
  const props = input[Object.keys(input).find(name => name.startsWith('__reactProps'))!];
  props.onChange({target: input, currentTarget: input}); await delay(60);
};
const openFind = async () => { const event = new window.Event('keydown', {bubbles: true, cancelable: true}); Object.assign(event, {key: 'f', metaKey: true, ctrlKey: false}); window.dispatchEvent(event); await delay(60); };

await store.openFile('f', 'big.ts');
const tab = () => store.getState().tabs.find(item => item.path === path)!;
root.render(<FileTab tab={tab()}/>);

// Spec: MUS-SPEC-07-778E (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-778e)
// Protected: syntax highlighting
await check('a file past the old 96 KB colour limit is coloured, and only the mounted rows are coloured and asked for', async () => {
  await until(() => !!host.querySelector('.virtual-file-source'), 'a file over 256 KB opens windowed');
  await until(() => painted() > 0, 'the mounted rows of a 340 KB file are coloured');
  assert.ok(mountedRows() < 100 && nodes() < 1500, `the DOM stays within the windowed budget (${mountedRows()} rows, ${nodes()} nodes)`);
  const whole = requests.filter(request => request.type === undefined && (request.source ?? 0) > 96 * 1024);
  assert.equal(whole.length, 0, 'the file is not sent to the worker as one source to colour in one pass');
  assert.equal(sourcesSent().length, 1, 'the source goes to the worker once');
  assert.ok(requests.filter(request => request.type === 'blocks').every(request => request.to <= 3), 'only blocks near the top of the file are asked for');
  await scrollTo(2000 * 21);
  await until(() => !!host.querySelector('[data-line="2000"]') && painted() > 0 && [...host.querySelectorAll('[data-line="2000"] .code-line span[style]')].length > 0, 'rows far down are coloured once scrolled to');
  assert.ok(requests.some(request => request.type === 'blocks' && request.from >= 6), 'scrolling asks for the blocks under the new window');
  assert.equal(sourcesSent().length, 1, 'and does not send the source again');
  assert.ok(mountedRows() < 100 && nodes() < 1500, `still bounded after scrolling (${mountedRows()} rows, ${nodes()} nodes)`);
  assert.deepEqual(errors, []);
});

// Spec: MUS-SPEC-07-778C (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-778c)
// Protected: syntax highlighting
await check('Find keeps the colours and marks the matches, in a windowed file and in a small one', async () => {
  await scrollTo(0);
  await openFind();
  await type('value2999');
  await until(() => !!host.querySelector('mark[data-current="true"]'), 'the match is marked in the windowed file');
  assert.ok(!host.querySelector('.file-find-plain'), 'Find no longer swaps in a plain <pre>');
  await until(() => [...host.querySelectorAll('.code-line span[style]')].length > 0, 'the windowed file keeps its colours while Find is open');
  const mark = host.querySelector('mark[data-current="true"]')!;
  assert.equal(mark.textContent, 'value2999', 'the mark covers exactly the match');
  assert.ok(mark.querySelector('span[style]') || (mark.parentElement?.closest('span[style]')), 'the match keeps its token colour');
  assert.ok(mountedRows() < 100, 'Find stays windowed');
  // A small file: the full table with the matches laid over the colours.
  text = small; path = 'notes.ts';
  await store.openFile('f', 'notes.ts');
  root.render(<FileTab tab={tab()}/>);
  await until(() => !!host.querySelector('.source-code-table') && !host.querySelector('.virtual-file-source'), 'a small file opens as a full table');
  await openFind();
  await type('beta');
  await until(() => host.querySelectorAll('mark').length === 3, 'every match is marked');
  assert.deepEqual([...host.querySelectorAll('mark')].map(item => item.getAttribute('data-current')), ['true', 'false', 'false'], 'the current match is the first');
  await until(() => [...host.querySelectorAll('.code-line span[style]')].length > 0, 'the small file keeps its colours while Find is open');
  assert.ok(!host.querySelector('.file-find-plain'), 'no plain <pre> here either');
  assert.deepEqual([...host.querySelectorAll('.source-code-table .code-line')].map(cell => cell.textContent), ['alpha beta', 'Beta gamma', 'beta delta', 'epsilon', ''], 'the text itself is unchanged');
});

// Spec: MUS-SPEC-07-778F (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-778f)
// Protected: syntax highlighting
await check('the edited-file and blame views of a file over 256 KB colour their mounted rows', async () => {
  root.render(<InlineFileSource source={big} path="big.ts" patch={'@@ -1,3 +1,3 @@\n ' + line(1) + '\n-old\n+' + line(2) + '\n ' + line(3) + '\n'} status="completed"/>);
  await until(() => !!host.querySelector('.virtual-row-source'), 'the edited view is windowed');
  await until(() => painted() > 0, 'its mounted rows are coloured');
  assert.ok(host.querySelector('tr.file-inline-diff-added[data-line="2"] .code-line span[style]'), 'an added row keeps its marker and has colour');
  assert.ok(mountedRows() < 100 && nodes() < 2000, `the edited view stays windowed (${mountedRows()} rows, ${nodes()} nodes)`);
  root.render(<BlameView folderId="f" path="big.ts" source={big}/>);
  await until(() => !!host.querySelector('.virtual-row-source') && painted() > 0, 'the blame view is windowed and coloured');
  assert.ok(mountedRows() < 100 && nodes() < 2000, `the blame view stays windowed (${mountedRows()} rows, ${nodes()} nodes)`);
  assert.deepEqual(errors, []);
});
root.unmount();
console.log('syntax-highlight-778-dom: ok');
process.exit(0);
