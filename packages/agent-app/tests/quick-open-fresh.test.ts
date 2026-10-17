import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

const provider: ProviderAdapter = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'claude/claude-fable-5', name: 'Fixture'}]}], run: async () => ({status: 'completed', finalMessage: 'ok'}), stop: async () => true, dispose() {}};
const call = <T>(service: ReturnType<typeof createAgentService>, command: string, input?: unknown) => (service.invoke as unknown as (c: string, i: unknown) => Promise<T>)(command, input);

test('quick open finds a file created after its first search', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-qo-data-')), work = await mkdtemp(join(tmpdir(), 'muster-qo-work-'));
  t.after(() => Promise.all([rm(dataDir, {recursive: true, force: true}), rm(work, {recursive: true, force: true})]));
  const service = createAgentService({dataDir, provider, onEvent: () => {}});
  t.after(() => service.dispose());
  await writeFile(join(work, 'first.txt'), 'x');
  const folder = await call<{id: string}>(service, 'folder.add', {path: work});
  const before = await call<{results: {path: string}[]}>(service, 'files.quickOpen', {folderId: folder.id, query: 'fresh'});
  assert.equal(before.results.length, 0);
  await call(service, 'files.create', {folderId: folder.id, path: 'fresh-notes.md', kind: 'file'});
  const after = await call<{results: {path: string}[]}>(service, 'files.quickOpen', {folderId: folder.id, query: 'fresh'});
  assert.deepEqual(after.results.map(r => r.path), ['fresh-notes.md']);
});
