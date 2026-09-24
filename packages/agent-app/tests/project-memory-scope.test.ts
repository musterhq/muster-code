import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectMemoryScope} from '../src/runtime/memory-adapter.ts';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';

// The memory core as the app bundles it (its sources use .js specifiers, so it is bundled rather than imported).
const compiled = buildSync({entryPoints: [join(import.meta.dirname, '../vendor/muster-runtime/packages/core/src/memory.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, define: {'import.meta.url': JSON.stringify(import.meta.url)}}).outputFiles[0]!.text;
const loaded = {exports: {} as Record<string, unknown>};
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports);
const {addMemory, searchMemory} = loaded.exports as {addMemory(input: unknown, cwd: string): Promise<unknown>; searchMemory(input: unknown, cwd: string): Promise<unknown[]>};

test('a Project memory bank uses a scope the memory core accepts (no "Invalid memory scope kind: project")', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'muster-project-memory-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const scope = projectMemoryScope('p1');
  assert.notEqual(scope.kind, 'project');
  await assert.rejects(searchMemory({query: 'x', scopes: [{kind: 'project', id: 'p1'}] as never}, cwd), /Invalid memory scope kind: project/, 'the core really rejects the raw project kind');
  await addMemory({summary: 'Ship behind a flag', provenance: ['test'], scopes: [scope as never]}, cwd);
  const found = await searchMemory({query: 'flag', scopes: [scope as never]}, cwd);
  assert.equal(found.length, 1);
  assert.deepEqual(projectMemoryScope('p2'), {kind: 'workspace', id: 'project-p2'}, 'banks of different Projects stay distinct');
});
