/** Wave 3: G19 full search and identifier jump, C34 palette data, the shared query parser. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave3 } from './wave3-harness.ts';
import { parseSearch, snippetAround, termRanges } from '../src/shared/search-query.ts';

test('G19: the parser reads scopes, aliases and identifiers, and leaves unknown field words as text', () => {
  assert.deepEqual(parseSearch('login bug'), { scope: 'all', text: 'login bug', terms: ['login', 'bug'], identifier: null });
  assert.equal(parseSearch('in:docs login').scope, 'documents');
  assert.equal(parseSearch('in:docs login').text, 'login');
  assert.equal(parseSearch('comments:redirect').scope, 'comments');
  assert.equal(parseSearch('comments:redirect').text, 'redirect');
  assert.equal(parseSearch('in:nothing x').scope, 'all');
  assert.equal(parseSearch('in:nothing x').text, 'in:nothing x');
  assert.equal(parseSearch('status:todo x').text, 'status:todo x');
  assert.deepEqual(parseSearch('oss-12').identifier, { prefix: 'OSS', number: 12, key: 'OSS-12' });
  assert.equal(parseSearch('RAG-5 login').identifier, null);
  assert.equal(parseSearch('x-1y').identifier, null);
  assert.equal(parseSearch('anything', 'agents').scope, 'agents');
  assert.deepEqual(termRanges('Fix the login login', ['login']), [[8, 13], [14, 19]]);
  const s = snippetAround('a'.repeat(200) + ' needle ' + 'b'.repeat(200), ['needle']);
  assert.ok(s.snippet.startsWith('…') && s.snippet.endsWith('…'));
  assert.equal(s.snippet.slice(s.ranges[0]![0], s.ranges[0]![1]), 'needle');
});

test('G19/C34: search finds tasks, agents, projects, documents, comments and decisions, and a key jumps straight to its task', async t => {
  const h = await wave3(t);
  const cto = await h.member('CTO');
  const a = await h.addTask('Fix the login redirect', { kind: 'agent', id: cto.id }, { acceptance: 'Users land on the dashboard' });
  const b = await h.addTask('Write the release notes', { kind: 'user', id: 'local' });
  await h.s.invoke('work.docs.save', { projectId: h.project.id, taskId: a.id, key: 'plan', text: '# Plan\nReplace the session cookie before the redirect.' });
  await h.s.invoke('project.decisions.add', { projectId: h.project.id, title: 'Use SQLite', rationale: 'One file, no server to run', scope: '', relatedTaskIds: [] });
  h.sayWhen(/Fix the login redirect/, 'I traced the redirect loop to a stale cookie.');
  await h.start(a.id); await h.settled(a.id);

  // The identifier jump: key first, exact flag, found true.
  const jump = await h.s.invoke('search.workspace', { query: 'OSS-1' });
  assert.deepEqual(jump.identifier, { key: 'OSS-1', found: true });
  assert.equal(jump.rows[0]!.kind, 'tasks'); assert.equal(jump.rows[0]!.exact, true); assert.equal(jump.rows[0]!.taskId, a.id);
  const lower = await h.s.invoke('search.workspace', { query: 'oss-2' });
  assert.equal(lower.rows[0]!.taskId, b.id);
  const missing = await h.s.invoke('search.workspace', { query: 'OSS-99' });
  assert.deepEqual(missing.identifier, { key: 'OSS-99', found: false }); assert.equal(missing.rows.length, 0);

  // Words across scopes, with counts per scope.
  const all = await h.s.invoke('search.workspace', { query: 'redirect' });
  const kinds = new Set(all.rows.map(r => r.kind));
  for (const k of ['tasks', 'documents', 'comments']) assert.ok(kinds.has(k as never), `${k} in ${[...kinds]}`);
  assert.ok(all.counts.tasks >= 1 && all.counts.documents === 1 && all.counts.comments >= 1);
  const doc = all.rows.find(r => r.kind === 'documents')!;
  assert.equal(doc.taskId, a.id); assert.match(doc.snippet, /session cookie before the redirect/); assert.ok(doc.snippetRanges.length >= 1);
  const comment = all.rows.find(r => r.kind === 'comments')!;
  assert.equal(comment.taskId, a.id); assert.match(comment.snippet, /stale cookie/); assert.equal(comment.key, 'OSS-1');

  // Scope operators.
  const docs = await h.s.invoke('search.workspace', { query: 'in:docs cookie' });
  assert.deepEqual([...new Set(docs.rows.map(r => r.kind))], ['documents']);
  const tasksOnly = await h.s.invoke('search.workspace', { query: 'redirect', scope: 'tasks' });
  assert.ok(tasksOnly.rows.every(r => r.kind === 'tasks'));
  const agents = await h.s.invoke('search.workspace', { query: 'cto', scope: 'agents' });
  assert.equal(agents.rows[0]!.agentId, `member:${cto.id}`);
  const projects = await h.s.invoke('search.workspace', { query: 'ossmanager', scope: 'projects' });
  assert.equal(projects.rows[0]!.projectId, h.project.id);
  const decisions = await h.s.invoke('search.workspace', { query: 'sqlite', scope: 'decisions' });
  assert.equal(decisions.rows[0]!.title, 'Use SQLite');
  assert.match((await h.s.invoke('search.workspace', { query: 'server', scope: 'decisions' })).rows[0]!.snippet, /no server/);

  // Case, empty query, limit.
  assert.equal((await h.s.invoke('search.workspace', { query: 'RELEASE NOTES', scope: 'tasks' })).rows[0]!.taskId, b.id);
  assert.equal((await h.s.invoke('search.workspace', { query: '   ' })).rows.length, 0);
  assert.equal((await h.s.invoke('search.workspace', { query: 'o', scope: 'tasks', limit: 1 })).rows.length, 1);
  // Search reads only: no run started by searching.
  assert.equal(h.calls.length, 1);
});

test('G19: documents search escapes SQL wildcards and finds only the latest revision', async t => {
  const h = await wave3(t);
  const a = await h.addTask('Docs task', { kind: 'user', id: 'local' });
  await h.s.invoke('work.docs.save', { projectId: h.project.id, taskId: a.id, key: 'notes', text: 'discount is 100% off' });
  await h.s.invoke('work.docs.save', { projectId: h.project.id, taskId: a.id, key: 'notes', text: 'discount is final', baseRev: 1 });
  assert.equal((await h.s.invoke('search.workspace', { query: '100%', scope: 'documents' })).rows.length, 0);
  assert.equal((await h.s.invoke('search.workspace', { query: 'final', scope: 'documents' })).rows.length, 1);
  const wild = await h.s.invoke('search.workspace', { query: '%', scope: 'documents' });
  assert.equal(wild.rows.length, 0);
  await h.s.invoke('work.docs.save', { projectId: h.project.id, taskId: a.id, key: 'plan', text: 'a_b is not a%b', baseRev: undefined });
  assert.equal((await h.s.invoke('search.workspace', { query: 'a_b', scope: 'documents' })).rows.length, 1);
  assert.equal((await h.s.invoke('search.workspace', { query: 'a%b', scope: 'documents' })).rows.length, 1);
});
