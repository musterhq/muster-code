import {test} from 'node:test';
import assert from 'node:assert/strict';

const stored = new Map<string, string>();
Object.assign(globalThis, {sessionStorage: {getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }}});
const view = await import('../src/renderer/resourceViewState.ts');

test('folder expansion is keyed by folder and path, notifies subscribers and mirrors to sessionStorage', () => {
  view.resetResourceViewState();
  let calls = 0;
  const stop = view.subscribeExpansion(() => { calls++; });
  const before = view.expansionRevision();
  view.setExpanded('f1', 'src', true);
  view.setExpanded('f1', 'src', true); // no-op
  view.setExpanded('f2', 'src', true);
  assert.equal(view.isExpanded('f1', 'src'), true);
  assert.equal(view.isExpanded('f1', 'docs'), false);
  assert.deepEqual(view.expandedPaths('f1'), ['src']);
  assert.equal(calls, 2);
  assert.ok(view.expansionRevision() > before);
  assert.match(stored.get('muster.resourceView.expanded.v1')!, /src/);
  view.setExpanded('f1', 'src', false);
  assert.equal(view.isExpanded('f1', 'src'), false);
  assert.equal(view.isExpanded('f2', 'src'), true);
  stop();
});

test('scroll offsets are kept per tab and bounded', () => {
  view.resetResourceViewState();
  view.saveScrollOffset('file:a', 420.6);
  view.saveScrollOffset('file:b', -5);
  assert.equal(view.scrollOffset('file:a'), 421);
  assert.equal(view.scrollOffset('file:b'), undefined);
  view.saveScrollOffset('file:a', 0);
  assert.equal(view.scrollOffset('file:a'), undefined, 'top of document is the default, not stored');
  for (let index = 0; index < 250; index++) view.saveScrollOffset(`tab:${index}`, index + 1);
  assert.equal(view.scrollOffset('tab:0'), undefined, 'oldest entries fall out');
  assert.equal(view.scrollOffset('tab:249'), 250);
  view.resetResourceViewState();
});

test('storage failures never break the in-memory state', async () => {
  Object.assign(globalThis, {sessionStorage: {getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }}});
  view.setExpanded('f3', 'lib', true);
  assert.equal(view.isExpanded('f3', 'lib'), true);
  view.resetResourceViewState();
});
