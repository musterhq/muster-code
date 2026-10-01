/** Review fix: secret names that steer the shell, loader, git, Node or Muster are refused, by you and by an agent's request. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReservedName, secretRequests } from '../src/runtime/governance/blocks.ts';
import { validName } from '../src/runtime/governance/secrets.ts';
import { wave1 } from './wave1-harness.ts';

const RESERVED = ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_SSH_COMMAND', 'GIT_AUTHOR_NAME', 'GIT_CONFIG_COUNT', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MUSTER_DATA', 'PYTHONPATH', 'BASH_ENV', 'SHELL', 'NPM_CONFIG_REGISTRY'];
test('reserved names are refused by validName and by the request parser; ordinary names pass', () => {
  for (const n of RESERVED) { assert.ok(isReservedName(n), n); assert.throws(() => validName(n.toLowerCase()), /reserved/); assert.match(secretRequests(`\`\`\`muster-secret-request\n{"name":"${n}","purpose":"x"}\n\`\`\``).errors[0] ?? '', /reserved/); }
  for (const ok of ['NPM_TOKEN', 'DEPLOY_KEY', 'STRIPE_SECRET', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) { assert.equal(isReservedName(ok), false, ok); assert.equal(validName(ok), ok); }
});

test('saving a reserved name through the command is refused and stores nothing', async t => {
  const h = await wave1(t, { secrets: true });
  await assert.rejects(h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NODE_OPTIONS', value: 'tok_value_whatever_1' }), /reserved/);
  assert.equal((await h.s.invoke('project.secrets.list', { projectId: h.project.id })).secrets.length, 0);
});
