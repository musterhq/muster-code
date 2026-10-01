/** Wave 1: C12 + S87 per-agent git identity applied to commits. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { envOverrides, validateIdentity } from '../src/runtime/governance/git-identity.ts';
import { envFromOverrides } from '../src/runtime/adapters/shared.ts';
import { wave1 } from './wave1-harness.ts';

const log = (cwd: string) => execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%an <%ae> | %cn <%ce>'], { encoding: 'utf8' }).trim();

test('C12: identities are validated and become run environment that every adapter understands', () => {
  assert.throws(() => validateIdentity({ name: '', email: 'a@b.co' }), /git name/); assert.throws(() => validateIdentity({ name: 'A', email: 'nope' }), /valid git email/);
  const o = envOverrides({ name: 'CTO Agent', email: 'cto@agents.dev' });
  assert.deepEqual(envFromOverrides(o), { GIT_AUTHOR_NAME: 'CTO Agent', GIT_AUTHOR_EMAIL: 'cto@agents.dev', GIT_COMMITTER_NAME: 'CTO Agent', GIT_COMMITTER_EMAIL: 'cto@agents.dev', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'CTO Agent', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cto@agents.dev' });
  assert.deepEqual(envFromOverrides({ 'shell_environment_policy.set.lower': 'x', 'other.key': 'y' }), {});
});

test('C12: a run in the task’s worktree commits as the agent, not as the founder, whichever way the tool finds the identity', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, gitIdentity: { name: 'CTO Agent', email: 'cto@agents.dev' } });
  for (const mode of ['W1-COMMIT-ENV', 'W1-COMMIT-CFG']) {
    const job = await h.addTask(`${mode} commit`, { kind: 'agent', id: cto.id });
    const run = await h.s.invoke('paperclip.task.start', { taskId: job.id });
    await h.settled(job.id);
    assert.equal(log(run.worktree), 'CTO Agent <cto@agents.dev> | CTO Agent <cto@agents.dev>', `${mode}: the commit carries the agent identity`);
  }
  assert.equal(execFileSync('git', ['-C', h.repo, 'config', 'user.name'], { encoding: 'utf8' }).trim(), 'Founder', 'the main checkout keeps the founder identity');
  assert.ok(h.calls.some(c => c.overrides['shell_environment_policy.set.GIT_AUTHOR_EMAIL'] === 'cto@agents.dev'), 'the run option carried the environment');
  assert.ok((await h.activity('task.git-identity')).some(a => /commits in this run as CTO Agent <cto@agents.dev>/.test(a.summary)));
});

test('C12: in the main checkout nothing is written either', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, gitIdentity: { name: 'CTO Agent', email: 'cto@agents.dev' } });
  const job = await h.addTask('Main checkout', { kind: 'agent', id: cto.id }); await h.start(job.id); await h.settled(job.id);
  assert.ok((await h.activity('task.git-identity')).some(a => /your git config is not touched/.test(a.summary)));
  assert.equal(execFileSync('git', ['-C', h.repo, 'config', 'user.email'], { encoding: 'utf8' }).trim(), 'founder@example.com');
  const none = await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, gitIdentity: null }); assert.equal(none.gitIdentity, null);
});
