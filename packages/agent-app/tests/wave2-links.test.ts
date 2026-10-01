/** Wave 2: G34 external objects (pull requests linked to tasks, read through gh against a local mock), G4 outputs depth. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2 } from './wave2-harness.ts';

const pr = (n: number, over: Record<string, unknown> = {}) => ({ number: n, node_id: 'N', title: `PR ${n}`, html_url: `https://github.com/acme/widgets/pull/${n}`, state: 'open', draft: false, user: { login: 'dev' }, head: { ref: 'f', sha: `sha${n}` }, base: { ref: 'main' }, ...over });
const runs = (conclusions: (string | null)[]) => ({ check_runs: conclusions.map((c, i) => ({ id: i + 1, name: `check-${i}`, status: c ? 'completed' : 'in_progress', conclusion: c })) });

test('G34: a pasted pull request link is recorded, its state and checks read through the GitHub layer, and the task list can filter on failing', async t => {
  const h = await wave2(t);
  const task = await h.addTask('Ship the fix', { kind: 'user', id: 'local' });
  const gh = await h.github(req => {
    if (req.path === 'repos/acme/widgets/pulls/12') return { body: pr(12) };
    if (req.path.startsWith('repos/acme/widgets/commits/sha12/check-runs')) return { body: runs(['success', 'failure', 'success']) };
    if (req.path === 'repos/acme/widgets/pulls/13') return { body: pr(13, { state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z' }) };
    return undefined;
  });
  const link = await h.s.invoke('work.links.add', { projectId: h.project.id, taskId: task.id, url: 'https://github.com/acme/widgets/pull/12' });
  assert.deepEqual([link.repo, link.number, link.title, link.state, link.checks, link.source], ['acme/widgets', 12, 'PR 12', 'open', 'failing', 'manual']);
  assert.match(link.checksSummary, /2 passed · 1 failed/);
  // Only reads: every request to the mock was a GET.
  assert.ok(gh.requests.length >= 2 && gh.requests.every(r => r.method === 'GET'));
  assert.deepEqual((await h.s.invoke('work.overlay', {})).prs[task.id], { total: 1, open: 1, merged: 0, failing: 1, pending: 0 });
  // The same link twice is one link.
  await h.s.invoke('work.links.add', { projectId: h.project.id, taskId: task.id, url: 'https://github.com/acme/widgets/pull/12' });
  assert.equal((await h.s.invoke('work.links.list', { projectId: h.project.id, taskId: task.id })).links.length, 1);
  await assert.rejects(h.s.invoke('work.links.add', { projectId: h.project.id, taskId: task.id, url: 'https://example.com/pull/1' }), /Paste a GitHub pull request link/);
  // A merged PR no longer counts as failing.
  const merged = await h.s.invoke('work.links.add', { projectId: h.project.id, taskId: task.id, url: 'https://github.com/acme/widgets/pull/13' });
  assert.equal(merged.state, 'merged');
  assert.equal((await h.s.invoke('work.overlay', {})).prs[task.id]!.merged, 1);
  // Refresh re-reads one link: the checks turn green.
  gh.requests.length = 0;
  let green = false;
  await h.github(req => { if (req.path === 'repos/acme/widgets/pulls/12') return { body: pr(12) }; if (req.path.startsWith('repos/acme/widgets/commits/sha12/check-runs')) return { body: runs(green ? ['success', 'success'] : ['success', 'failure']) }; return undefined; });
  green = true;
  const refreshed = await h.s.invoke('work.links.refresh', { projectId: h.project.id, id: link.id });
  assert.equal(refreshed.links[0]!.checks, 'passing');
  assert.equal((await h.s.invoke('work.overlay', {})).prs[task.id]!.failing, 0);
  // Outputs list the pull requests too.
  const outputs = await h.s.invoke('work.outputs.state', { projectId: h.project.id });
  assert.ok(outputs.pullRequests.some(p => p.detail.includes('acme/widgets#12') && p.taskId === task.id));
  await h.s.invoke('work.links.remove', { projectId: h.project.id, id: link.id });
  assert.equal((await h.s.invoke('work.links.list', { projectId: h.project.id, taskId: task.id })).links.length, 1);
});

test('G34: a GitHub failure is kept on the link in plain words, and a pull request URL in an agent report is linked automatically', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  await h.github(req => req.path === 'repos/acme/widgets/pulls/7' ? { status: 404, body: { message: 'Not Found' } } : undefined);
  h.sayWhen(/Open the PR/, 'Opened https://github.com/acme/widgets/pull/7 for review.');
  const task = await h.addTask('Open the PR', { kind: 'agent', id: cto.id }, { acceptance: 'Open the PR' });
  await h.start(task.id); await h.settled(task.id);
  const links = await h.until(async () => { const l = (await h.s.invoke('work.links.list', { projectId: h.project.id, taskId: task.id })).links; return l.length ? l : null; }, 'the detected link');
  assert.equal(links[0]!.source, 'detected'); assert.equal(links[0]!.number, 7);
  assert.match(links[0]!.error ?? '', /Not found on GitHub/);
  assert.equal(links[0]!.state, 'unknown');
});

test('G34: scanning a thread finds pull request links in comments', async t => {
  const h = await wave2(t);
  const task = await h.addTask('Review', { kind: 'user', id: 'local' }, { acceptance: 'Details in https://github.com/acme/widgets/pull/21' });
  await h.github(req => req.path === 'repos/acme/widgets/pulls/21' ? { body: pr(21) } : req.path.includes('check-runs') ? { body: runs(['success']) } : undefined);
  const scan = await h.s.invoke('work.links.scan', { projectId: h.project.id, taskId: task.id });
  assert.equal(scan.found, 1); assert.equal(scan.links[0]!.number, 21); assert.equal(scan.links[0]!.checks, 'passing');
});

test('G4: output status moves through draft, ready, approved and merged; changes requested needs a note and wakes the owner; seen clears the arrival cue', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const task = await h.addTask('Write the doc', { kind: 'agent', id: cto.id });
  const p = h.project.id, id = `file:${p}:docs/plan.md`;
  assert.deepEqual((await h.s.invoke('work.outputs.state', { projectId: p })).states, {});
  const ready = await h.s.invoke('work.outputs.status', { projectId: p, outputId: id, status: 'ready_for_review' });
  assert.equal(ready.status, 'ready_for_review');
  await assert.rejects(h.s.invoke('work.outputs.status', { projectId: p, outputId: id, status: 'changes_requested' }), /Say what should change/);
  await h.s.invoke('work.outputs.status', { projectId: p, outputId: id, status: 'changes_requested', note: 'Add a rollback section.', taskId: task.id, title: 'plan.md' });
  const mail = await h.s.invoke('mailbox.list', { projectId: p, limit: 20 });
  assert.ok(mail.messages.some(m => /Changes requested on plan\.md: Add a rollback section\./.test(m.body)));
  const state = (await h.s.invoke('work.outputs.state', { projectId: p })).states[id]!;
  assert.deepEqual([state.status, state.note, state.by], ['changes_requested', 'Add a rollback section.', 'You']);
  await h.s.invoke('work.outputs.status', { projectId: p, outputId: id, status: 'approved' });
  await h.s.invoke('work.outputs.status', { projectId: p, outputId: id, status: 'merged' });
  assert.equal((await h.s.invoke('work.outputs.state', { projectId: p })).states[id]!.status, 'merged');
  assert.equal((await h.s.invoke('work.outputs.state', { projectId: p })).seenAt, null);
  const seen = await h.s.invoke('work.outputs.seen', { projectId: p });
  assert.equal((await h.s.invoke('work.outputs.state', { projectId: p })).seenAt, seen.seenAt);
  await assert.rejects(h.s.invoke('work.outputs.status', { projectId: p, outputId: id, status: 'nope' as never }), /Choose a status/);
});
