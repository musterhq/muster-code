/** Review fix: deleting a project removes its secret values from the encrypted store. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

test('deleting a project clears every version of its secrets from secrets.json', async t => {
  const h = await wave1(t, { secrets: true });
  const names = () => Object.keys((JSON.parse(readFileSync(join(h.dataDir, 'secrets.json'), 'utf8')) as { secrets: Record<string, unknown> }).secrets).filter(k => k.startsWith('ps_'));
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: 'tok_value_one_0001' });
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: 'tok_value_two_0002' });
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'DEPLOY_KEY', value: 'tok_value_deploy_03' });
  assert.equal(names().length, 3);
  await h.s.invoke('project.delete', { id: h.project.id });
  assert.deepEqual(names(), [], 'no ciphertext of the deleted project remains');
});
