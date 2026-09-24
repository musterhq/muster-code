import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAttachedSkill } from '../src/runtime/plugin-library.ts';

test('skill attachment resolver rechecks allowed roots and returns bounded content identity', async t => {
  const base = await mkdtemp(join(tmpdir(), 'muster-skill-attach-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace');
  const skillDir = join(workspace, '.agents', 'skills', 'review');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), 'Use the review checklist.');
  const canonicalSkillDir = await realpath(skillDir);
  const resolved = await resolveAttachedSkill(canonicalSkillDir, [workspace]);
  assert.equal(resolved?.content, 'Use the review checklist.');
  assert.equal(resolved?.digest, createHash('sha256').update('Use the review checklist.').digest('hex'));
  assert.equal(await resolveAttachedSkill(join(base, 'untrusted'), [workspace]), null);

  const outside = join(base, 'outside');
  const escaped = join(workspace, '.agents', 'skills', 'escaped');
  await mkdir(outside); await symlink(outside, escaped);
  assert.equal(await resolveAttachedSkill(await realpath(escaped), [workspace]), null, 'symlink cannot point skill lookup outside the allowed root');

  await writeFile(join(skillDir, 'SKILL.md'), 'x'.repeat(50000));
  assert.equal(await resolveAttachedSkill(canonicalSkillDir, [workspace]), null, 'oversized skill is rejected instead of injected');
});
