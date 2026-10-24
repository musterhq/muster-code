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


// Spec: MUS-SPEC-16-561A (docs/spec/clauses/16-notifications-and-attention.md#mus-spec-16-561a)
test('a confirmation or Undo notice is not lost while persistent errors fill the stack', () => {
  for (const n of [...store.getState().notices]) store.dismissNotice(n.id);
  for (let i = 1; i <= 4; i++) store.pushNotice(`Problem ${i}`, {kind: 'error'});
  assert.equal(store.getState().notices.length, 4);
  const id = store.pushNotice('Archived 2 chats', {kind: 'success', action: {label: 'Undo', run: () => {}}});
  const notices = store.getState().notices as {id: number; message: string; kind: string}[];
  assert.ok(notices.some(n => n.id === id), 'the new notice is shown, with its Undo');
  assert.ok(notices.length <= 4, 'the stack stays bounded');
  assert.ok(notices.some(n => n.message === 'Problem 4'), 'the newest error is kept');
  for (const n of [...store.getState().notices]) store.dismissNotice(n.id);
});
