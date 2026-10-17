/** #393: the Inbox keeps agent questions and approvals on tasks the person is accountable for, reads the whole attention feed, ranks
 *  critical items first, finds mentions the 120-character snippet cut off, clears a mention once the task is opened, and polls its badge calmly. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { scopeInbox } from '../src/shared/org-work.ts';
import { buildInbox, mapAttention, mapIssue, mapMentions, mentionCandidates, SNIPPET_LIMIT } from '../src/runtime/paperclip-map.ts';
import { PaperclipBackend } from '../src/runtime/server/paperclip-backend.ts';
import { BADGE_POLL_MS, shouldPollBadge, startBadgePoll } from '../src/renderer/badgePoll.ts';

type Json = Record<string, unknown>;
const fixture = JSON.parse(await readFile(new URL('./fixtures/paperclip-rag/company.json', import.meta.url), 'utf8')) as { companies: Json[]; issues: Json[] };
const company = String(fixture.companies[0]!.id);
const me = { id: 'local-board', name: 'Dhairya' };
/** What `?view=compact` returns: the same issue without `responsibleUserId`. */
const compact = (issue: Json): Json => { const { responsibleUserId: _drop, ...rest } = issue; return rest; };
const agentIssue = fixture.issues.find(i => i.assigneeAgentId && i.responsibleUserId === me.id)!;

test('a compact issue row has no owner, so the old filter dropped the person’s agent questions; the attention feed’s own scoping now keeps them', () => {
  const task = mapIssue(compact(agentIssue), new Map(), new Set(), me.id);
  assert.equal(task.responsibleUserId, null, 'the compact shape cannot say who is accountable');
  const raw = { id: 'a1', sourceKind: 'issue_thread_interaction', severity: 'high', subject: { kind: 'issue', id: agentIssue.id, identifier: 'RAG-15', title: 'Pick one' }, activityAt: '2026-10-05T00:00:00Z' };
  const fromServer = mapAttention(raw);
  assert.equal(fromServer.kind, 'question');
  assert.deepEqual(scopeInbox([{ ...fromServer, scoped: undefined }], [task], me), [], 'without the server’s scoping (the old rule) the question is lost');
  assert.deepEqual(scopeInbox([fromServer], [task], me).map(i => i.id), ['a1'], 'a server-scoped question on an agent-held task reaches the Inbox');
  assert.deepEqual(scopeInbox([mapAttention({ ...raw, sourceKind: 'approval', subject: { kind: 'issue', id: agentIssue.id } })], [task], me).length, 1);
});

test('server-scoped items still drop a task known to be someone else’s, and problems keep the old rule', () => {
  const bobs = mapIssue({ ...compact(agentIssue), assigneeAgentId: null, assigneeUserId: 'u-bob' }, new Map(), new Set(), me.id);
  const owned = mapIssue(agentIssue, new Map(), new Set(), me.id);
  const strangers = { ...owned, responsibleUserId: 'u-bob' };
  const q = (taskId: string) => mapAttention({ id: `q-${taskId}`, sourceKind: 'issue_thread_interaction', subject: { kind: 'issue', id: taskId } });
  assert.deepEqual(scopeInbox([q(bobs.id)], [bobs], me), [], 'a human assignee who is not me');
  assert.deepEqual(scopeInbox([q(strangers.id)], [strangers], me), [], 'accountable owner is another person');
  assert.equal(scopeInbox([q(owned.id)], [owned], me).length, 1);
  const failed = mapAttention({ id: 'f', sourceKind: 'failed_run', subject: { kind: 'issue', id: bobs.id } });
  assert.deepEqual(scopeInbox([failed], [bobs], me), [], 'a failed run on another person’s task stays out');
});

test('critical is critical, and sorts above high', () => {
  assert.equal(mapAttention({ id: 'c', sourceKind: 'approval', severity: 'critical', subject: { kind: 'approval', title: 'x' } }).severity, 'critical');
  const at = '2026-10-05T00:00:00Z';
  const items = ['medium', 'high', 'critical', 'low'].map(s => mapAttention({ id: s, sourceKind: 'approval', severity: s, subject: { kind: 'approval', title: s }, activityAt: at }));
  assert.deepEqual(buildInbox(items, [], [], new Map()).map(i => i.severity), ['critical', 'high', 'medium', 'low']);
});

const row = (over: Json, details: Json = {}): Json => ({ id: `r${Math.random()}`, action: 'issue.comment_added', actorId: 'u-bob', entityId: 't9', createdAt: '2026-10-05T10:00:00Z', details: { commentId: 'c1', identifier: 'RAG-5', issueTitle: 'Pool', ...details }, ...over });
const chip = `[@Dhairya](user://${me.id})`;
test('a mention past the 120-character snippet is found from the full comment', () => {
  const body = `${'x'.repeat(SNIPPET_LIMIT + 20)} ${chip}`;
  const rows = [row({}, { bodySnippet: body.slice(0, SNIPPET_LIMIT) })];
  assert.deepEqual(mapMentions(rows, me.id, new Map()), [], 'the cut snippet alone shows no chip');
  assert.equal(mentionCandidates(rows, me.id).length, 1, 'but it is a candidate whose full comment is read');
  assert.deepEqual(mapMentions(rows, me.id, new Map(), undefined, new Map([['c1', body]])).map(i => i.id), ['mention:c1']);
  assert.equal(mentionCandidates([row({}, { bodySnippet: 'short' })], me.id).length, 0, 'a short snippet is whole');
});

test('opening the task clears its mention (the server logs issue.read_marked for the person)', () => {
  const mention = row({}, { bodySnippet: `hi ${chip}` });
  const opened = (userId: string, at: string) => ({ id: 'rd', action: 'issue.read_marked', actorId: userId, entityId: 't9', createdAt: at, details: { userId } });
  assert.equal(mapMentions([mention], me.id, new Map()).length, 1);
  assert.equal(mapMentions([mention, opened(me.id, '2026-10-05T11:00:00Z')], me.id, new Map()).length, 0, 'read after the mention');
  assert.equal(mapMentions([mention, opened(me.id, '2026-10-05T09:00:00Z')], me.id, new Map()).length, 1, 'read before the mention: still new');
  assert.equal(mapMentions([mention, opened('u-bob', '2026-10-05T11:00:00Z')], me.id, new Map()).length, 1, 'someone else opening it does not clear mine');
});

/** A fake Paperclip: records every path asked, answers the few reads the Inbox needs. */
function fakeServer() {
  const asked: string[] = [], posts: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\/api/, '') + new URL(input).search;
    if (init?.method === 'POST') posts.push(path); else asked.push(path);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/cli-auth/me')) return json({ userId: me.id, user: { id: me.id, name: me.name } });
    if (path.includes('/issues?')) return json(path.includes('offset=') ? [] : fixture.issues.map(compact));
    if (path.startsWith(`/issues/${agentIssue.id}`) && !path.includes('/comments')) return json(agentIssue);
    if (path.includes('/attention')) return json({ items: [{ id: 'q1', sourceKind: 'issue_thread_interaction', severity: 'critical', subject: { kind: 'issue', id: agentIssue.id, identifier: 'RAG-15', title: 'Pick' }, activityAt: '2026-10-05T00:00:00Z' }] });
    if (path.includes('/activity')) return json([row({}, { bodySnippet: 'y'.repeat(SNIPPET_LIMIT) })]);
    if (path.includes('/comments/c1')) return json({ id: 'c1', body: `${'y'.repeat(SNIPPET_LIMIT)} ${chip}` });
    if (path.includes('/user-directory')) return json({ users: [] });
    if (init?.method === 'POST') return json({});
    return json([]);
  };
  return { fetch, asked, posts };
}
test('reading a company asks for the whole attention feed, fills the owner from the full issue and finds the cut mention', async () => {
  const server = fakeServer();
  const backend = new PaperclipBackend({ baseUrl: 'http://paperclip.test', token: 'k' }, { fetch: server.fetch, cache: false });
  const part = await backend.read({ id: company, name: 'RAG', prefix: 'RAG' });
  assert.ok(server.asked.some(p => p.includes('/attention?all=true')), 'all=true, so the feed is not capped at 50');
  assert.ok(server.asked.includes(`/issues/${agentIssue.id}`), 'the full issue is read for the task the attention item points at');
  assert.equal(part.tasks.find(t => t.id === agentIssue.id)!.responsibleUserId, me.id);
  const kept = scopeInbox(part.inbox, part.tasks, me);
  assert.ok(kept.some(i => i.id === 'q1' && i.severity === 'critical'), 'the agent’s question reaches the Inbox');
  assert.ok(part.inbox.some(i => i.id === 'mention:c1'), 'the mention found in the full comment');
});

test('the Inbox badge poll runs once a minute, only for a linked server in an active window, and not right after another read', () => {
  const idle = { connected: true, windowActive: false, sinceLastReadMs: 10 * BADGE_POLL_MS };
  assert.equal(shouldPollBadge(idle), false, 'hidden or unfocused: no work');
  assert.equal(shouldPollBadge({ ...idle, windowActive: true, connected: false }), false, 'no server linked');
  assert.equal(shouldPollBadge({ ...idle, windowActive: true, sinceLastReadMs: 5_000 }), false, 'an event just refreshed it');
  assert.equal(shouldPollBadge({ ...idle, windowActive: true }), true);
  let loads = 0, tick = () => {}, interval = 0;
  const stop = startBadgePoll({ connected: () => true, lastReadAt: () => 0, load: () => { loads++; }, active: () => true, every: (run, ms) => { tick = run; interval = ms; return () => {}; } });
  tick(); assert.equal(interval, 60_000); assert.equal(loads, 1); stop();
});
