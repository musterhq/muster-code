/** Review fix: a value Muster lent to a run is redacted from everything that run stores. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { forgetLiterals, lendLiterals, redactLiterals, redactLiteralsDeep } from '../src/runtime/literal-redaction.ts';
import { wave1 } from './wave1-harness.ts';

const VALUE = 'tok_live_not_a_known_pattern_77aa88bb';
test('literal redaction replaces exact values, deeply, for the chat that was lent them only', () => {
  lendLiterals('c1', [VALUE, 'abc']);
  assert.equal(redactLiterals('c1', `x ${VALUE} y ${VALUE}`), 'x [redacted] y [redacted]');
  assert.deepEqual(redactLiteralsDeep('c1', { a: [`k=${VALUE}`], n: 1 }), { a: ['k=[redacted]'], n: 1 });
  assert.equal(redactLiterals('c2', VALUE), VALUE); assert.equal(redactLiterals('c1', 'abc'), 'abc', 'too-short values are not masked');
  forgetLiterals('c1'); assert.equal(redactLiterals('c1', VALUE), VALUE);
});

test('an agent that prints the token (env, echo, its reply) leaves no value in the timeline or the tool output log', async t => {
  const h = await wave1(t, { secrets: true });
  const cto = await h.member('CTO');
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: VALUE });
  await h.s.invoke('project.secrets.grant', { projectId: h.project.id, name: 'NPM_TOKEN', memberId: cto.id, granted: true });
  const job = await h.addTask('W1-ECHO prints it', { kind: 'agent', id: cto.id }); const run = await h.start(job.id); await h.settled(job.id);
  const timeline = JSON.stringify((await h.s.invoke('chat.timeline', { id: run.chatId })).items);
  assert.ok(!timeline.includes(VALUE), 'not in the timeline');
  assert.ok(timeline.includes('[redacted]'), 'and the masking is visible');
  const files: string[] = [];
  for (const e of readdirSync(h.dataDir, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[]) if (e.isFile() && !/oss-repo|\.git|secrets\.json/.test(join(e.parentPath, e.name))) { try { if (readFileSync(join(e.parentPath, e.name)).includes(VALUE)) files.push(e.name); } catch { /* unreadable */ } }
  assert.deepEqual(files.filter(f => !/\.sqlite/.test(f)), [], 'not in any output log');
});
