/**
 * F28 end to end: a real runtime (WorkspaceWatchService → workspaceChanged) bridged into the real
 * renderer store (subscribe → refreshResources → loadDir). A directory the agent creates on disk while
 * the Files tab is open must appear in the tree without any user action.
 */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service';
import type {AgentEvent} from '../src/shared/protocol';

const root = await mkdtemp(join(tmpdir(), 'muster-refresh-e2e-'));
const folder = join(root, 'todo'); await mkdir(join(folder, 'apps', 'api'), {recursive: true});
await writeFile(join(folder, 'package.json'), '{}');
const listeners = new Set<(event: AgentEvent) => void>();
const service = createAgentService({dataDir: join(root, 'state'), onEvent: event => { for (const listener of listeners) listener(event); }});
const saved = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key)},
  window: {setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, innerWidth: 1400, muster: {
    subscribe(listener: (event: AgentEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    invoke: (command: string, input: unknown) => (service.invoke as (c: string, i: unknown) => Promise<unknown>)(command, input),
  }},
});
const until = async (label: string, check: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(25); } };
let failed = false;
try {
  const added = await service.invoke('folder.add', {path: folder});
  const store = await import('../src/renderer/store');
  await store.boot();
  const chat = await service.invoke('chat.create', {folderId: added.id});
  await store.selectChat(chat.id);
  store.openFilesTab(added.id, added.name);
  await store.loadDir(added.id, '');
  const names = () => (store.getState().files[store.dirKey(added.id, '')]?.value ?? []).map((entry: {name: string}) => entry.name).sort();
  assert.deepEqual(names(), ['apps', 'package.json']);
  await store.loadDir(added.id, 'apps');
  // The agent scaffolds apps/web/** after the tree was listed (the dogfood state in F28).
  await sleep(400);
  await mkdir(join(folder, 'apps', 'web', 'src'), {recursive: true});
  await writeFile(join(folder, 'apps', 'web', 'src', 'App.tsx'), 'export {}');
  await writeFile(join(folder, 'README.md'), '# todo');
  const appsNames = () => (store.getState().files[store.dirKey(added.id, 'apps')]?.value ?? []).map((entry: {name: string}) => entry.name).sort();
  await until('watcher refresh of the root listing', () => names().includes('README.md'));
  await until('watcher refresh of an expanded directory', () => appsNames().includes('web'));
  assert.deepEqual(appsNames(), ['api', 'web']);

  // A load joining an in-flight listing re-reads afterwards instead of keeping the older result.
  const first = store.loadDir(added.id, '');
  await writeFile(join(folder, 'CHANGELOG.md'), '');
  await Promise.all([first, store.loadDir(added.id, '')]);
  assert.ok(names().includes('CHANGELOG.md'), 'the joined load ends on a listing taken after the latest write');
  console.log('PASS: watcher → workspaceChanged → refreshResources keeps the Files tree current (root + expanded dirs, in-flight joins)');
} catch (error) {
  failed = true; console.error(error instanceof Error ? error.stack : error);
} finally {
  await service.dispose(); await rm(root, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
