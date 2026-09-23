import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';

// store.ts is written for a bundler (extensionless specifiers, a DOM/localStorage
// runtime) and is never imported directly by Node's ESM loader elsewhere in this
// suite. Bundle it the same way scripts/test-renderer.mjs bundles renderer code,
// then run it against a tiny in-memory localStorage/window shim.
let dir = '';
async function loadStore() {
  // Inside the package so the bundle's external imports (react, …) resolve from node_modules.
  const base = new URL('../dist/', import.meta.url).pathname;
  await mkdir(base, {recursive: true});
  dir = await mkdtemp(join(base, 'store-bundle-'));
  const outfile = join(dir, 'store.mjs');
  await build({
    entryPoints: [new URL('../src/renderer/store.ts', import.meta.url).pathname],
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    loader: {'.css': 'empty'}, jsx: 'automatic',
  });
  return import(`file://${outfile}`);
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.has(key) ? data.get(key)! : null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  } as Storage;
}
(globalThis as {localStorage?: Storage}).localStorage = memoryStorage();

const store = await loadStore();
test.after(async () => { if (dir) await rm(dir, {recursive: true, force: true}); });

function resetTabs(): void {
  for (const tab of [...store.getState().tabs]) store.closeTab(tab.id);
}

test('a single-click preview replaces the previous preview tab in place, not appended', () => {
  resetTabs();
  store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'}, {preview: true});
  store.openTab({id: 'file:f:b.ts', kind: 'file', folderId: 'f', path: 'b.ts', title: 'b.ts'}, {preview: true});
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:b.ts'], 'the second preview replaces the first rather than adding a tab');
  assert.equal(store.getState().tabs[0].preview, true);
  assert.equal(store.getState().activeTabId, 'file:f:b.ts');
});

test('opening a permanent tab keeps a separate preview tab intact until it is replaced or promoted', () => {
  resetTabs();
  store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'}); // permanent
  store.openTab({id: 'file:f:b.ts', kind: 'file', folderId: 'f', path: 'b.ts', title: 'b.ts'}, {preview: true});
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts', 'file:f:b.ts']);
  assert.equal(store.getState().tabs.find((t: {id: string}) => t.id === 'file:f:a.ts')?.preview, false);
  assert.equal(store.getState().tabs.find((t: {id: string}) => t.id === 'file:f:b.ts')?.preview, true);
  // A double-click (makeTabPermanent) promotes the preview without changing its position or id.
  store.makeTabPermanent('file:f:b.ts');
  assert.equal(store.getState().tabs.find((t: {id: string}) => t.id === 'file:f:b.ts')?.preview, false);
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts', 'file:f:b.ts']);
  // A third preview now opens as a new tab: nothing left to replace.
  store.openTab({id: 'file:f:c.ts', kind: 'file', folderId: 'f', path: 'c.ts', title: 'c.ts'}, {preview: true});
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts', 'file:f:b.ts', 'file:f:c.ts']);
});

test('reopening an already-open tab never demotes it back to a preview; an edit (setTabDirty) promotes a preview', () => {
  resetTabs();
  store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'}); // permanent
  store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'}, {preview: true});
  assert.equal(store.getState().tabs.find((t: {id: string}) => t.id === 'file:f:a.ts')?.preview, false);
  store.openTab({id: 'file:f:b.ts', kind: 'file', folderId: 'f', path: 'b.ts', title: 'b.ts'}, {preview: true});
  store.setTabDirty('file:f:b.ts', true);
  assert.equal(store.getState().tabs.find((t: {id: string}) => t.id === 'file:f:b.ts')?.preview, false, 'an edit promotes the preview tab it happens in');
  assert.equal(store.getState().dirtyTabs['file:f:b.ts'], true);
});

test('a closed tab reopens to the same descriptor (the "reopen closed" stack, backed by openTab)', () => {
  resetTabs();
  store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'});
  store.openTab({id: 'file:f:b.ts', kind: 'file', folderId: 'f', path: 'b.ts', title: 'b.ts'});
  const closedDescriptor = store.getState().tabs.find((t: {id: string}) => t.id === 'file:f:b.ts');
  store.closeTab('file:f:b.ts');
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts']);
  assert.equal(store.getState().fileBodies['file:f:b.ts'], undefined, 'closing drops its cached body');
  store.openTab(closedDescriptor);
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts', 'file:f:b.ts']);
  assert.equal(store.getState().activeTabId, 'file:f:b.ts');
});

test('reorderTab and moveTabDirection move a tab within the strip without touching others', () => {
  resetTabs();
  for (const path of ['a.ts', 'b.ts', 'c.ts']) store.openTab({id: `file:f:${path}`, kind: 'file', folderId: 'f', path, title: path});
  store.reorderTab('file:f:c.ts', 0);
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['c.ts', 'a.ts', 'b.ts']);
  store.moveTabDirection('file:f:c.ts', 'right');
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['a.ts', 'c.ts', 'b.ts']);
});

test('closeOtherTabs and closeTabsToRight keep pinned tabs and the anchor', () => {
  resetTabs();
  for (const path of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) store.openTab({id: `file:f:${path}`, kind: 'file', folderId: 'f', path, title: path});
  store.pinTab('file:f:a.ts', true);
  store.closeOtherTabs('file:f:c.ts');
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['a.ts', 'c.ts'], 'the pinned tab and the anchor both survive');
  for (const path of ['b.ts', 'd.ts']) store.openTab({id: `file:f:${path}`, kind: 'file', folderId: 'f', path, title: path});
  store.closeTabsToRight('file:f:c.ts');
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['a.ts', 'c.ts'], 'pinned a.ts and everything up to and including c.ts survive');
});

test('bulk close keeps tabs with unsaved changes open and says so (WRK-03)', () => {
  for (const tab of [...store.getState().tabs]) { store.pinTab(tab.id, false); store.setTabDirty(tab.id, false); store.closeTab(tab.id); }
  for (const path of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) store.openTab({id: `file:f:${path}`, kind: 'file', folderId: 'f', path, title: path});
  store.setTabDirty('file:f:a.ts', true);
  store.setTabDirty('file:f:b.ts', true);
  const before = store.getState().notices.length;
  store.closeOtherTabs('file:f:c.ts');
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['a.ts', 'b.ts', 'c.ts'], 'dirty a.ts and b.ts are not discarded');
  const notices = store.getState().notices;
  assert.equal(notices.length, before + 1, 'one notice for the whole bulk close');
  assert.equal(notices.at(-1).message, '2 tabs with unsaved changes were kept open.');
  assert.equal(store.getState().dirtyTabs['file:f:a.ts'], true, 'the unsaved marker survives');

  for (const path of ['d.ts', 'e.ts']) store.openTab({id: `file:f:${path}`, kind: 'file', folderId: 'f', path, title: path});
  store.setTabDirty('file:f:e.ts', true);
  store.closeTabsToRight('file:f:a.ts');
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['a.ts', 'b.ts', 'e.ts'], 'clean c.ts/d.ts close, dirty b.ts/e.ts stay');
  assert.equal(store.getState().notices.at(-1).message, '2 tabs with unsaved changes were kept open.');

  const count = store.getState().notices.length;
  store.setTabDirty('file:f:b.ts', false); store.setTabDirty('file:f:e.ts', false);
  store.closeTabsToRight('file:f:a.ts');
  assert.deepEqual(store.getState().tabs.map((t: {path: string}) => t.path), ['a.ts']);
  assert.equal(store.getState().notices.length, count, 'no notice when nothing unsaved was kept');
});

test('bulk close ends browser views and terminal shells the way a single close does', async () => {
  for (const tab of [...store.getState().tabs]) { store.pinTab(tab.id, false); store.setTabDirty(tab.id, false); store.closeTab(tab.id); }
  const calls: Array<[string, unknown]> = [];
  const g = globalThis as {window?: unknown};
  const hadWindow = 'window' in g, previous = g.window;
  g.window = {muster: {invoke: async (command: string, input: unknown) => { calls.push([command, input]); return command === 'terminal.list' ? [{id: 't1', status: 'running'}] : undefined; }, subscribe: () => () => {}}};
  try {
    store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'});
    store.openTab({id: 'browser:b1', kind: 'browser', title: 'Docs', url: 'https://example.com'});
    store.openTab({id: 'processes:c1', kind: 'processes', chatId: 'c1', title: 'Terminal'});
    store.closeOtherTabs('file:f:a.ts');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls.filter(([command]) => command === 'browser.close'), [['browser.close', {owner: 'browser:b1'}]], 'the browser view is closed, not orphaned');
    assert.ok(calls.some(([command, input]) => command === 'terminal.kill' && (input as {id: string}).id === 't1'), 'running shells of the Terminal tab are ended');
    assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts']);
    assert.equal(store.getState().activeTabId, 'file:f:a.ts');
  } finally {
    if (hadWindow) g.window = previous; else delete g.window;
  }
});

test('Close Others on a tab that is no longer open changes nothing', () => {
  for (const tab of [...store.getState().tabs]) store.closeTab(tab.id);
  store.openTab({id: 'file:f:a.ts', kind: 'file', folderId: 'f', path: 'a.ts', title: 'a.ts'});
  store.closeOtherTabs('file:f:gone.ts');
  assert.deepEqual(store.getState().tabs.map((t: {id: string}) => t.id), ['file:f:a.ts']);
  assert.equal(store.getState().activeTabId, 'file:f:a.ts');
});
