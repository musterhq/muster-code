/** #645: a 2 MB file the last turn edited, and its blame view, stay windowed (under 2,000 DOM nodes) with diff markers,
 *  Keep / Undo, hunk stepping, Copy and in-file search still working. Run via scripts/test-renderer.mjs. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require = createRequire(import.meta.url), {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput = null;
const saved = new Map<string, string>();
const storage = {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }};
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver, ResizeObserver: class {observe() {} disconnect() {} unobserve() {}}, requestAnimationFrame: (fn: any) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, localStorage: storage, sessionStorage: storage});
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
// A selection over text nodes: just enough Range / Selection for the copy path.
const textBefore = (root: any, node: any, offset: number): string => {
  let out = '', done = false;
  const walk = (current: any) => {
    if (done) return;
    if (current === node) { out += current.nodeType === 3 ? current.nodeValue.slice(0, offset) : ''; done = true; return; }
    if (current.nodeType === 3) { out += current.nodeValue; return; }
    for (const child of Array.from<any>(current.childNodes)) walk(child);
  };
  walk(root);
  return out;
};
window.document.createRange = () => ({selectNodeContents(el: any) { (this as any).el = el; }, setEnd(node: any, offset: number) { (this as any).node = node; (this as any).offset = offset; }, toString() { return textBefore((this as any).el, (this as any).node, (this as any).offset); }}) as any;
let selection: any = {isCollapsed: true, rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, toString: () => ''};
window.getSelection = () => selection;
(globalThis as any).getSelection = window.getSelection;

const line = (n: number) => `const value${n} = compute(${n}, 'plain text that pads this line out to about a hundred and twenty characters');`;
const COUNT = 18_000; // under the 20,000-line hunk limit, so the whole file diffs
const after = Array.from({length: COUNT}, (_, i) => line(i + 1)).join('\n') + '\n';
assert.ok(after.length > 2_000_000, `fixture is about 2 MB (${after.length})`);
const edited = after.split('\n');
edited[1] = '// edited line near the top NEEDLE';
edited[8999] = edited[8999] + ' // changed in the middle';
const current = edited.join('\n');
// before: the file as it stood before the turn — line 2 was different, a block in the middle did not exist, and a line near the end was there.
const baseLines = current.split('\n');
baseLines[1] = line(2);
baseLines[8999] = line(9000);
baseLines.splice(12_000, 0, '// added by the turn 1', '// added by the turn 2');
const before = baseLines.join('\n');
// the turn deleted one line near the end
const trimmed = current.split('\n');
trimmed.splice(17_500, 1);
const text = trimmed.join('\n');
const hunks = (await import('../src/shared/review-hunks')).computeHunks(before.replace('\n', '\n'), text, 5000)!;
assert.ok(hunks.length >= 3, `the fixture has several hunks (${hunks.length})`);

const chat = {id: 'chat', title: 'Chat', folderId: 'f', pinned: false, archived: false, draft: '', status: 'completed', updatedAt: '', model: 'm', mode: 'agent'};
const snapshot = {version: 1, chats: [chat], folders: [{id: 'f', name: 'Repo', path: '/repo'}], projects: [], activeChatId: 'chat'};
const blameShas = Array.from({length: COUNT}, (_, i) => i < 9000 ? 'a'.repeat(40) : 'b'.repeat(40));
const commits = {['a'.repeat(40)]: {sha: 'a'.repeat(40), short: 'aaaaaaa', author: 'Ada', authoredAt: new Date().toISOString(), summary: 'first', uncommitted: false}, ['b'.repeat(40)]: {sha: 'b'.repeat(40), short: 'bbbbbbb', author: 'Bo', authoredAt: new Date().toISOString(), summary: 'second', uncommitted: false}};
const calls: {command: string; input: any}[] = [];
let marks: any[] = [];
window.muster = {subscribe() { return () => {}; }, async invoke(command: string, input: any) {
  calls.push({command, input});
  if (command === 'app.snapshot') return snapshot;
  if (command === 'chat.timeline') return {items: [], revision: 0};
  if (command === 'settings.get') return {values: {}};
  if (command === 'files.read') return {path: input.path, text, truncated: false};
  if (command === 'files.openWith.apps' || command === 'files.annotations.list' || command === 'files.list') return command === 'files.openWith.apps' ? {apps: []} : [];
  if (command === 'review.baselines') return [{runId: 'r1', chatId: 'chat', folderId: 'f', treeSha: 't1', at: new Date().toISOString()}];
  if (command === 'review.marks') return marks;
  if (command === 'review.fileDiff') return {path: input.path, status: 'M', before, after: text, truncated: false, size: {before: before.length, after: text.length}, beforeHash: 'b', afterHash: 'a', revision: '1', label: 'turn'};
  if (command === 'review.undoHunk') return {stale: false, afterHash: 'a2'};
  if (command === 'review.keep') { marks = input.hunkIds.map((hunkId: string) => ({runId: 'r1', path: input.path, hunkId, state: 'kept', at: ''})); return marks; }
  if (command === 'git.blame') return {lines: blameShas, commits, truncated: false};
  return undefined;
}};
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const store = await import('../src/renderer/store');
const {FileTab} = await import('../src/renderer/components/FileTab');
const {InlineFileSource} = await import('../src/renderer/components/InlineFileSource');
await store.boot(); await delay(30);
const errors: unknown[] = [];
const host = document.getElementById('root')!;
const root = createRoot(host, {onUncaughtError: (error: unknown) => errors.push(error)});
const nodes = () => host.querySelectorAll('*').length;
const until = async (check: () => boolean, label: string) => { for (let i = 0; i < 150 && !check(); i++) await delay(20); assert.ok(check(), label); };
const scroller = () => host.querySelector<HTMLElement>('.code-scroll')!;
const scrollTo = async (top: number) => { scroller().scrollTop = top; scroller().dispatchEvent(new window.Event('scroll')); await delay(20); };

// Spec: MUS-SPEC-07-645A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-645a)
await check('a 2 MB edited file and its blame view stay windowed', async () => {
await store.openFile('f', 'big.ts');
const tab = store.getState().tabs.find(item => item.path === 'big.ts')!;
root.render(<FileTab tab={tab}/>);

// --- Edited-file view: the cumulative review of the last turn ---------------------------------------------------------
await until(() => !!host.querySelector('.inline-file-review-bar'), 'the review bar shows for a file the last turn edited');
assert.deepEqual(errors, []);
assert.ok(nodes() < 2000, `a 2 MB edited file draws fewer than 2,000 nodes (${nodes()})`);
assert.ok(host.querySelector('.virtual-row-source'), 'the edited view is windowed');
assert.ok(host.querySelectorAll('tr[data-line]').length < 100, 'only a window of rows is mounted');
assert.match(host.querySelector('.inline-file-review-count')?.textContent ?? '', new RegExp(`${hunks.length} changes`), 'the bar counts every change in the file, mounted or not');
assert.equal(host.querySelector('.virtual-row-source table')?.getAttribute('aria-rowcount'), String(host.querySelector('.virtual-row-source')!.getAttribute('data-row-count')), 'the table reports every row');
// Markers: the first hunk replaced line 2 — a removed row and an added row, with +/− markers.
assert.ok(host.querySelector('tr.file-inline-diff-deleted .file-inline-diff-marker'), 'a removed line shows its − marker');
assert.ok(host.querySelector('tr.file-inline-diff-added[data-line="2"] .file-inline-diff-marker'), 'an added line shows its + marker');
// Keep / Undo on the hunk that is on screen.
const firstGroup = host.querySelector('.file-hunk-actions')!;
assert.ok(firstGroup, 'the first hunk has Undo / Keep controls');
firstGroup.querySelector<HTMLButtonElement>('button[title="Revert this change"]')!.click();
await until(() => calls.some(call => call.command === 'review.undoHunk'), 'Undo asks the host to revert that hunk');
assert.equal(calls.find(call => call.command === 'review.undoHunk')!.input.hunkId, hunks[0].id, 'and names the first hunk');
await until(() => host.querySelector<HTMLButtonElement>('.file-hunk-actions button.is-primary')?.disabled === false, 'the controls unlock once the Undo settles');
host.querySelector<HTMLButtonElement>('.file-hunk-actions button.is-primary')!.click();
await until(() => calls.some(call => call.command === 'review.keep'), 'Keep records the hunk');
assert.deepEqual(calls.find(call => call.command === 'review.keep')!.input.hunkIds, [hunks[0].id]);
await delay(60);
// Hunk stepping reaches a hunk that is not mounted: Previous wraps from the first to the last.
const stepsAway = () => host.querySelector(`[data-hunk-start="${hunks[hunks.length - 1].id}"]`);
assert.ok(!stepsAway(), 'the last hunk is far off screen to begin with');
await until(() => new RegExp(`${hunks.length - 1} changes?`).test(host.querySelector('.inline-file-review-count')?.textContent ?? ''), 'a kept hunk leaves the count and the first hunk loses its markers');
assert.ok(!host.querySelector('tr.file-inline-diff-deleted'), 'the kept hunk is no longer painted');
host.querySelector<HTMLButtonElement>('button[aria-label="Previous change"]')!.click();
await until(() => !!stepsAway(), 'Previous change scrolls an unmounted hunk into the window');
assert.ok(nodes() < 2000, `stepping keeps the DOM bounded (${nodes()})`);
await scrollTo(0);
assert.ok(host.querySelector('tr[data-line="1"]'), 'scrolling back to the top mounts the first rows again');
// Copy reads the source, including rows that are not mounted: anchor near the top, focus at the very end.
const cell = (n: number) => host.querySelector<HTMLElement>(`tr[data-line="${n}"] .code-line`)!;
selection = {isCollapsed: false, rangeCount: 1, anchorNode: cell(3).firstChild, anchorOffset: 6, focusNode: cell(3).firstChild, focusOffset: 12, toString: () => 'x', getRangeAt: () => ({getBoundingClientRect: () => ({top: 0, bottom: 0, left: 0, right: 0})})};
window.document.dispatchEvent(new window.Event('selectionchange'));
await scrollTo(scroller().scrollHeight || 21 * COUNT);
await until(() => !!host.querySelector(`tr[data-line="${COUNT - 1}"]`), 'the end of the file is mounted');
assert.ok(host.querySelectorAll('tr[data-vrow]').length < 100, 'only a window plus the selection anchor is mounted');
selection = {...selection, focusNode: cell(COUNT - 1).firstChild, focusOffset: 9};
const copied = () => { const data = new Map<string, string>(); const event: any = new window.Event('copy', {bubbles: true, cancelable: true}); event.clipboardData = {setData: (type: string, value: string) => data.set(type, value)}; scroller().dispatchEvent(event); return data.get('text/plain'); };
const sourceLines = text.split('\n');
const expected = [sourceLines[2].slice(6), ...sourceLines.slice(3, COUNT - 2), sourceLines[COUNT - 2].slice(0, 9)].join('\n');
const got = copied();
assert.equal(got?.length, expected.length, 'Copy returns the whole selected range, including the unmounted rows');
assert.ok(got === expected, 'with the exact source text');
selection = {isCollapsed: true, rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, toString: () => ''};
window.document.dispatchEvent(new window.Event('selectionchange'));
await scrollTo(0);

// --- In-file search over the same file ----------------------------------------------------------------------------------
const findKey = Object.assign(new window.Event('keydown', {bubbles: true, cancelable: true}), {key: 'f', ctrlKey: true});
window.dispatchEvent(findKey);
await until(() => !!host.querySelector('input[aria-label="Find in file"]'), 'Cmd+F opens find');
const input = host.querySelector<HTMLInputElement>('input[aria-label="Find in file"]')!;
// React's value tracker must see a change: set the value, reset the tracker, then fire input (as sidebar-navigation does).
// linkedom's event system does not drive React's input listener here, so call the field's own onChange (as projects-parity-components does).
Object.defineProperty(input, 'value', {configurable: true, get: () => 'needle', set: () => {}});
const props = Object.keys(input).find(key => key.startsWith('__reactProps'))!;
(input as unknown as Record<string, {onChange(event: unknown): void}>)[props].onChange({target: input, currentTarget: input});
await until(() => host.querySelector('.file-find-count')?.textContent === '1/1', 'find counts matches in the whole file (the edited line near the top)');
assert.ok(host.querySelector('mark[data-current="true"]'), 'the current match is marked');
assert.ok(nodes() < 2000, `search keeps the DOM bounded (${nodes()})`);
host.querySelector<HTMLButtonElement>('button[aria-label="Close find"]')!.click();
await until(() => !host.querySelector('input[aria-label="Find in file"]'), 'find closes');

// --- Blame view ---------------------------------------------------------------------------------------------------------
host.querySelector<HTMLButtonElement>('button[aria-label="Show blame"]')!.click();
await until(() => !!host.querySelector('[data-testid="blame-view"] .blame-table'), 'blame loads');
assert.ok(nodes() < 2000, `a 2 MB blame view draws fewer than 2,000 nodes (${nodes()})`);
assert.ok(host.querySelectorAll('.blame-table tr[data-line]').length < 100, 'only a window of blame rows is mounted');
assert.match(host.querySelector('.blame-table tr[data-line="1"] .blame-note')?.textContent ?? '', /aaaaaaa.*Ada/, 'the first line names its commit');
await scrollTo(21 * 9000);
await until(() => !!host.querySelector('.blame-table tr[data-line="9001"]'), 'scrolling mounts the rows further down');
assert.match(host.querySelector('.blame-table tr[data-line="9001"] .blame-note')?.textContent ?? '', /bbbbbbb.*Bo/, 'where the second commit starts, its note appears');
assert.ok(!host.querySelector('.blame-table tr[data-line="1"]'), 'and the first rows are unmounted');
assert.ok(nodes() < 2000, `scrolling keeps the blame DOM bounded (${nodes()})`);
host.querySelector<HTMLButtonElement>('button[aria-label="Hide blame"]')!.click();
await delay(30);
assert.deepEqual(errors, []);

// --- The latest-edit patch path (no turn baseline) is windowed too -------------------------------------------------------
root.render(<InlineFileSource source={after} path="big.ts" patch={'@@ -1,3 +1,3 @@\n ' + line(1) + '\n-old\n+' + line(2) + '\n ' + line(3) + '\n'} status="completed"/>);
await until(() => !!host.querySelector('.inline-file-source'), 'the patch view renders');
await delay(30);
assert.ok(host.querySelector('tr.file-inline-diff-added[data-line="2"]'), 'its edited line is marked');
assert.ok(host.querySelectorAll('tr[data-line]').length < 100 && nodes() < 2000, `and the patch view of a 2 MB file is bounded (${nodes()} nodes)`);

// --- A small file keeps the plain full table ------------------------------------------------------------------------------
root.render(<InlineFileSource source={'one\ntwo\nthree\n'} path="small.ts" patch={'@@ -1,3 +1,3 @@\n one\n-old\n+two\n three\n'} status="completed"/>);
await delay(40);
assert.ok(!host.querySelector('.virtual-row-source'), 'a small file is not windowed');
assert.ok(host.querySelector('tr.file-inline-diff-added[data-line="2"]'), 'and still marks its edit');
root.unmount();
assert.deepEqual(errors, []);
});
console.log('Large edited file DOM checks passed: bounded edited view and blame view, markers, Keep/Undo, hunk stepping, copy, search.');
