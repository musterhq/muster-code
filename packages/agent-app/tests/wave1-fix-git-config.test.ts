/** Review fix M3: an agent's git identity never writes to the founder's git config, and the Git tab's commit carries it. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { wave1 } from './wave1-harness.ts';

const gitDir = (cwd: string) => execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();

test('M3: after identity runs in a worktree and in the checkout, the main repository config is byte-identical', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, gitIdentity: { name: 'CTO Agent', email: 'cto@agents.dev' } });
  const config = join(h.repo, '.git', 'config'), before = await readFile(config);
  const job = await h.addTask('W1-COMMIT-CFG via config env', { kind: 'agent', id: cto.id });
  const run = await h.s.invoke('paperclip.task.start', { taskId: job.id }); await h.settled(job.id);
  const plain = await h.addTask('Plain run in the checkout', { kind: 'agent', id: cto.id }); await h.start(plain.id); await h.settled(plain.id);
  assert.deepEqual(await readFile(config), before, '.git/config is byte-identical');
  const common = join(gitDir(run.worktree).replace(/^(?!\/)/, run.worktree + '/'));
  assert.ok(!(await readFile(join(common, 'config'), 'utf8')).includes('worktreeConfig'), 'the extension is never enabled');
  assert.ok(!(await readdir(common)).includes('config.worktree'), 'no worktree config file either');
  const author = execFileSync('git', ['-C', run.worktree, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim();
  assert.equal(author, 'CTO Agent <cto@agents.dev>', 'a tool that only reads config sees the identity through GIT_CONFIG_*');
});

test('M3: a commit from the Git tab inside the agent’s task worktree carries its identity; one in your checkout carries yours', async t => {
  const h = await wave1(t);
  const cto = await h.member('CTO');
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, gitIdentity: { name: 'CTO Agent', email: 'cto@agents.dev' } });
  const job = await h.addTask('Worktree job', { kind: 'agent', id: cto.id });
  const run = await h.s.invoke('paperclip.task.start', { taskId: job.id }); await h.settled(job.id);
  const wtFolder = (await h.s.invoke('app.snapshot', undefined)).folders.find(f => f.path === run.worktree)!;
  const commit = async (folderId: string, path: string) => {
    const st = await h.s.invoke('git.status', { folderId });
    execFileSync('git', ['-C', path, 'add', '-A']);
    const fresh = await h.s.invoke('git.status', { folderId });
    return h.s.invoke('git.commit', { folderId, revision: fresh.revision ?? st.revision, message: 'from the git tab' });
  };
  await commit(wtFolder.id, run.worktree);
  assert.equal(execFileSync('git', ['-C', run.worktree, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim(), 'CTO Agent <cto@agents.dev>');
  execFileSync('sh', ['-c', `echo mine > ${join(h.repo, 'mine.txt')}`]);
  await commit(h.folder.id, h.repo);
  assert.equal(execFileSync('git', ['-C', h.repo, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim(), 'Founder <founder@example.com>');
});
