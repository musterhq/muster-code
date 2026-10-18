// Real FileTab load-full/find path and browser selection/layout. See run-virtual-file-source.mjs.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {FileTab} from '../src/renderer/components/FileTab';
import {HighlightedSourceTable} from '../src/renderer/components/HighlightedCode';
import {VirtualFileSource} from '../src/renderer/components/VirtualFileSource';
import {getState, openFile} from '../src/renderer/store';
import '../src/renderer/styles.css';
const assert = (condition: unknown, message: string) => {if (!condition) throw new Error(message);};
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => {await frame(); await frame();};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {if (check()) {await settle(); return;} await frame();}
  throw new Error('Timed out waiting for file view');
};
const lines = Array.from({length: 21_184}, (_, i) => `${String(i + 1).padStart(5, '0')} ${'abcdefghij'.repeat(9)}${i === 0 || i === 21_183 ? ' NEEDLE' : ''}`);
const source = lines.join('\n');
window.muster = {
  subscribe: () => () => {},
  invoke: (async (command: string) => {
    if (command === 'files.read') return {path: 'big.txt', text: source.slice(0, 512 * 1024), truncated: true};
    if (command === 'files.readFull') return {path: 'big.txt', text: source, truncated: false};
    if (command === 'files.openWith.apps') return {apps: []};
    if (command === 'files.annotations.list' || command === 'files.list') return [];
    return undefined;
  }) as typeof window.muster.invoke,
};
async function run() {
  const host = document.getElementById('root')!, root = createRoot(host);
  await settle();
  const beforeStart = performance.now();
  flushSync(() => root.render(<HighlightedSourceTable source={source} language="text"/>));
  void host.offsetHeight;
  const before = {milliseconds: performance.now() - beforeStart, nodes: host.querySelectorAll('*').length};
  const smallRowHeight = host.querySelector('tr[data-line]')!.getBoundingClientRect().height;
  flushSync(() => root.render(null));
  await openFile('folder', 'big.txt');
  const tab = getState().tabs.find(tab => tab.path === 'big.txt')!;
  flushSync(() => root.render(<FileTab tab={tab}/>));
  const loadButton = () => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Load full file'));
  await until(() => !!loadButton());
  const longTasks: number[] = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
  observer.observe({type: 'longtask'});
  await new Promise(resolve => setTimeout(resolve, 50));
  longTasks.length = 0;
  const start = performance.now();
  loadButton()!.click();
  await until(() => !host.querySelector('.pane-truncated'));
  const after = {milliseconds: performance.now() - start, nodes: host.querySelectorAll('*').length};
  const rows = () => host.querySelectorAll('tr[data-line]');
  assert(rows().length < 100, 'full-file DOM must stay bounded (fails with old full table)');
  assert(after.nodes < 500, 'full-file DOM must contain fewer than 500 elements');
  const scroller = host.querySelector<HTMLElement>('.code-scroll')!;
  let first = host.querySelector<HTMLElement>('[data-line="1"] .code-line')!;
  assert(Math.abs(first.parentElement!.getBoundingClientRect().height - smallRowHeight) < 0.01, `virtual rows keep the small-file row height (${smallRowHeight})`);
  assert(host.querySelector('.virtual-file-source table')?.getAttribute('aria-rowcount') === String(lines.length), 'table reports every source row to assistive tech');
  // A scrollbar drag jumps far in one step; the rows under the viewport must be painted in that same frame.
  const textLeft = first.getBoundingClientRect().left;
  for (const fraction of [0.37, 0.81, 0.12]) {
    scroller.scrollTop = Math.floor(scroller.scrollHeight * fraction);
    await frame();
    const box = scroller.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + 60, box.top + box.height / 2);
    assert(hit?.closest('tr')?.hasAttribute('data-line'), `jump to ${fraction} paints rows in the same frame`);
    assert(Math.abs(hit!.closest('tr')!.querySelector('.code-line')!.getBoundingClientRect().left - textLeft) < 0.5, 'the gutter keeps one width at any scroll position');
  }
  scroller.scrollTop = 0;
  await settle();
  first = host.querySelector<HTMLElement>('[data-line="1"] .code-line')!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(first.firstChild!, 2, first.firstChild!, 8);
  await settle();
  scroller.scrollTop = scroller.scrollHeight;
  await until(() => !!host.querySelector('[data-line="21184"]'));
  assert(!!host.querySelector('[data-line="1"]'), 'scrolling retains the selection anchor');
  const last = host.querySelector('[data-line="21184"] .code-line')!;
  selection.extend(last.firstChild!, 9);
  await settle();
  const copy = () => {
    const data = new DataTransfer();
    scroller.dispatchEvent(new ClipboardEvent('copy', {bubbles: true, cancelable: true, clipboardData: data}));
    return data.getData('text/plain');
  };
  const expected = source.slice(2, source.lastIndexOf('\n') + 10);
  assert(copy() === expected, 'copy reconstructs unmounted lines');
  selection.setBaseAndExtent(last.firstChild!, 9, first.firstChild!, 2);
  assert(copy() === expected, 'backward selection copies the same source range');
  // A drag released over rows that are not mounted yet still copies the original text up to that point.
  const spacer = host.querySelector<HTMLElement>('.virtual-file-spacer')!;
  selection.setBaseAndExtent(first.firstChild!, 2, spacer.firstChild!, 0);
  const gapStart = Number(spacer.dataset.gapStart);
  assert(copy() === source.slice(2, source.split('\n').slice(0, gapStart - 1).join('\n').length + 1), 'selection ending in a spacer copies through the hidden rows');
  selection.setBaseAndExtent(last.firstChild!, 9, first.firstChild!, 2);
  let context: {text: string; source: {startLine: number; endLine: number}} | undefined;
  const accept = (event: Event) => {context = (event as CustomEvent).detail; event.preventDefault();};
  window.addEventListener('muster:composer-add-context', accept);
  last.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  await until(() => !!host.querySelector('.file-selection-context'));
  host.querySelector<HTMLButtonElement>('.file-selection-context')!.click();
  assert(context?.text === expected.slice(0, 8000) && context?.source.startLine === 1 && context?.source.endLine === 21184, 'Add to chat keeps source text and line bounds');
  window.removeEventListener('muster:composer-add-context', accept);
  scroller.focus();
  scroller.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ctrlKey: true, key: 'a'}));
  assert(copy() === source, 'Select All copies the entire source');
  selection.removeAllRanges();
  window.dispatchEvent(new KeyboardEvent('keydown', {ctrlKey: true, key: 'f', bubbles: true}));
  await until(() => !!host.querySelector('input[aria-label="Find in file"]'));
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Find in file"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
  input.dispatchEvent(new Event('input', {bubbles: true}));
  await until(() => host.querySelector('.file-find-count')?.textContent === '1/2');
  host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click();
  await until(() => host.querySelector('mark[data-current="true"]')?.closest('tr')?.getAttribute('data-line') === '21184');
  const searchScroller = host.querySelector<HTMLElement>('.code-scroll')!;
  assert(searchScroller.scrollTop > 400_000, 'search navigates to an offscreen match');
  const markBox = host.querySelector('mark[data-current="true"]')!.getBoundingClientRect(), viewBox = searchScroller.getBoundingClientRect();
  assert(markBox.left >= viewBox.left && markBox.right <= viewBox.right, `the current match is scrolled into view sideways (${markBox.left}-${markBox.right} in ${viewBox.left}-${viewBox.right})`);
  host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click();
  await until(() => host.querySelector('mark[data-current="true"]')?.closest('tr')?.getAttribute('data-line') === '1');
  assert(rows().length < 100, 'find stays virtualized');
  host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.click();
  await until(() => host.querySelector('mark[data-current="true"]')?.closest('tr')?.getAttribute('data-line') === '21184');
  await new Promise(resolve => setTimeout(resolve, 60));
  observer.disconnect();
  assert(longTasks.length === 0, `load/scroll/search/selection must have no >50ms tasks: ${longTasks}`);
  root.unmount();
  // The horizontal scroll range must not follow whichever rows are mounted: a long line near the top
  // keeps its scroll position while short lines further down are on screen.
  const varied = Array.from({length: 5_000}, (_, i) => i === 3 ? 'x'.repeat(600) : `short ${i}`).join('\n');
  const plainRoot = createRoot(host);
  flushSync(() => plainRoot.render(<div className="code-scroll" style={{height: 300}}><VirtualFileSource source={varied}/></div>));
  await settle();
  const plain = host.querySelector<HTMLElement>('.code-scroll')!;
  plain.scrollLeft = plain.scrollWidth;
  const left = plain.scrollLeft;
  plain.scrollTop = 40_000;
  await settle();
  assert(left > 0 && plain.scrollLeft === left, `horizontal scroll stays at ${left} after scrolling down (got ${plain.scrollLeft})`);
  plainRoot.unmount();
  return {bytes: source.length, lines: lines.length, before, after, longTasks};
}
(globalThis as typeof globalThis & {testResult: Promise<unknown>}).testResult = run();
