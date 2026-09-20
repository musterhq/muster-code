const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createAgentService } = require('../dist/runtime/service.cjs');

function provider() {
  return { info: () => [], run: async () => ({ runId: 'unused', status: 'completed' }), stop: async () => true, dispose() {} };
}

test('memory scope is authoritative to the registered folder context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muster-memory-scope-'));
  const dataDir = join(root, 'state');
  const service = createAgentService({ dataDir, provider: provider(), onEvent() {} });
  try {
    const first = await service.invoke('folder.add', { path: root });
    const secondRoot = await mkdtemp(join(tmpdir(), 'muster-memory-other-'));
    try {
      const second = await service.invoke('folder.add', { path: secondRoot });
      await assert.rejects(
        service.invoke('memory.add', { folderId: first.id, summary: 'must not cross scope', provenance: ['test'], scopes: [{ kind: 'workspace', id: second.id }] }),
        /match the selected context/,
      );
      await service.invoke('memory.add', { folderId: first.id, summary: 'first folder fact', provenance: ['test'], scopes: [{ kind: 'workspace', id: first.id }] });
      await require('../dist/runtime/core-memory.cjs').addMemory({summary:'foreign scope must stay hidden', provenance:['test'], scopes:[{kind:'workspace',id:second.id}], explicitUserRequest:true}, root);
      await service.invoke('memory.add', { summary: 'personal fact', provenance: ['test'], scopes: [{ kind: 'user', id: 'local' }] });
      assert.deepEqual((await service.invoke('memory.list', { folderId: first.id })).map(entry => entry.summary), ['first folder fact']);
      assert.deepEqual((await service.invoke('memory.list', {})).map(entry => entry.summary), ['personal fact']);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

