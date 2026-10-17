/** Every Paperclip thread-interaction kind (#395): what each card shows, how it ends, how it is answered; plus the client's paging and rate-limit rules.
 *  Paperclip is faked; nothing here talks to a real server. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapInteraction } from '../src/runtime/paperclip-map.ts';
import { PaperclipClient, retryAfterMs } from '../src/runtime/paperclip-client.ts';
import { PaperclipBackend } from '../src/runtime/server/paperclip-backend.ts';
import { costEventFor } from '../src/runtime/checkout/costs.ts';

const now = '2026-10-12T08:00:00.000Z';
const agents = new Map([['a-1', { name: 'CTO' } as never]]);
const card = (i: Record<string, unknown>) => mapInteraction({ id: 'int-1', status: 'pending', createdAt: now, createdByAgentId: 'a-1', ...i } as never, agents) as any;

test('suggested tasks are listed and accepted with the keys you ticked', () => {
  const c = card({ kind: 'suggest_tasks', payload: { version: 1, reason: 'Split the migration', tasks: [{ clientKey: 'k1', title: 'Write the schema', priority: 'high' }, { clientKey: 'k2', title: 'Backfill', description: 'Run once', parentClientKey: 'k1' }, { clientKey: 'k1', title: 'dup' }] } });
  assert.equal(c.interactionId, 'int-1', 'answerable');
  assert.deepEqual(c.ask.tasks.map((t: any) => [t.key, t.title]), [['k1', 'Write the schema'], ['k2', 'Backfill']], 'each task is listed once');
  assert.deepEqual(c.ask.selected, ['k1', 'k2']);
  assert.notEqual(c.prompt, 'An agent needs your decision.', 'the reason or title is shown, not the generic line');
  assert.match(c.prompt, /Split the migration/);
});

test('a checklist lists its options, starts from the defaults and reports the chosen labels afterwards', () => {
  const payload = { version: 1, prompt: 'Which files may I delete?', minSelected: 1, maxSelected: 2, defaultSelectedOptionIds: ['a', 'zzz'], options: [{ id: 'a', label: 'Old logs' }, { id: 'b', label: 'Caches', description: 'Safe' }] };
  const c = card({ kind: 'request_checkbox_confirmation', payload });
  assert.deepEqual([c.ask.kind, c.ask.options.map((o: any) => o.id), c.ask.selected, c.ask.min, c.ask.max], ['checkbox', ['a', 'b'], ['a'], 1, 2]);
  const done = card({ kind: 'request_checkbox_confirmation', status: 'accepted', payload, result: { version: 1, outcome: 'accepted', selectedOptionIds: ['b'] } });
  assert.equal(done.resolution, 'Approved: Caches.');
  assert.equal(done.ask, undefined, 'history has no controls');
});

test('item verdicts list the items and the verdicts the request allows; the result is counted', () => {
  const payload = { version: 1, prompt: 'Review these', allowBulkApprove: true, verdicts: ['approve', 'reject'], requireReasonOn: ['reject'], items: [{ id: 'i1', label: 'Draft A', previewMarkdown: '# A' }, { id: 'i2', label: 'Draft B' }] };
  const c = card({ kind: 'request_item_verdicts', payload });
  assert.deepEqual([c.ask.kind, c.ask.items.map((i: any) => i.id), c.ask.verdicts, c.ask.requireReasonOn, c.ask.allowBulkApprove], ['verdicts', ['i1', 'i2'], ['approve', 'reject'], ['reject'], true]);
  const done = card({ kind: 'request_item_verdicts', status: 'answered', payload, result: { version: 1, outcome: 'resolved', complete: true, items: [{ id: 'i1', verdict: 'approve' }, { id: 'i2', verdict: 'reject' }] } });
  assert.equal(done.resolution, '1 approved, 1 declined.');
});

test('a connection request names the app and the waiting agent; with no payload text it falls back to the title, then the summary', () => {
  const c = card({ kind: 'connection_intent', payload: { version: 1, serviceName: 'Mail', requestingAgentName: 'CTO', phase: 'requested' } });
  assert.deepEqual([c.ask.kind, c.ask.service, c.ask.agent], ['connection', 'Mail', 'CTO']);
  assert.match(c.prompt, /connect Mail/i);
  assert.equal(card({ kind: 'suggest_tasks', title: 'From the title', summary: 'S', payload: { tasks: [] } }).prompt, 'From the title');
  assert.equal(card({ kind: 'suggest_tasks', summary: 'From the summary', payload: { tasks: [] } }).prompt, 'From the summary');
});

test('a tool-call confirmation shows the tool, its risk, a preview and an arguments summary; the result shows how it ended', () => {
  const toolAction = { version: 1, toolName: 'mail.delete', toolDisplayName: 'Delete mail', appDisplayName: 'Mail', risk: 'destructive', previewMarkdown: 'Deletes **3** messages', argumentsSummaryJson: '{"ids":[1,2,3]}', expiresAt: '2026-10-13T00:00:00.000Z' };
  const c = card({ kind: 'request_confirmation', payload: { version: 1, prompt: 'Run it?', toolAction } });
  assert.deepEqual([c.tool.name, c.tool.app, c.tool.risk, c.tool.preview, c.tool.args], ['Delete mail', 'Mail', 'destructive', 'Deletes **3** messages', '{"ids":[1,2,3]}']);
  assert.equal(c.tool.result, null);
  const ran = card({ kind: 'request_confirmation', status: 'accepted', payload: { version: 1, prompt: 'Run it?', toolAction }, result: { version: 1, outcome: 'accepted', toolAction: { version: 1, status: 'executed', resultSummary: '3 deleted', updatedAt: now } } });
  assert.equal(ran.tool.result.status, 'executed');
  assert.match(ran.resolution, /Ran\. 3 deleted/);
  const failed = card({ kind: 'request_confirmation', status: 'accepted', payload: { version: 1, prompt: 'Run it?', toolAction }, result: { version: 1, outcome: 'accepted', toolAction: { version: 1, status: 'failed', errorMessage: 'Rate limited', updatedAt: now } } });
  assert.match(failed.resolution, /Did not run\. Rate limited/);
});

test('a secret proposal is described (never its value); stale, superseded, failed and a resume failure are worded plainly', () => {
  const s = card({ kind: 'request_confirmation', payload: { version: 1, prompt: 'Allow?', secretProposal: { version: 1, proposalId: 'p', sourceSecretLabel: 'Deploy key', configPath: 'env.DEPLOY', targetAgentId: 'a', targetAgentName: 'Ops', justification: 'Needs to ship' } } });
  assert.deepEqual([s.secret.label, s.secret.target, s.secret.why], ['Deploy key', 'Ops', 'Needs to ship']);
  const stale = card({ kind: 'request_confirmation', status: 'rejected', payload: { prompt: 'x' }, result: { outcome: 'stale_target' } });
  assert.match(stale.resolution, /No longer applies/);
  assert.doesNotMatch(stale.resolution, /stale_target/);
  const replaced = card({ kind: 'request_confirmation', status: 'cancelled', payload: { prompt: 'x' }, result: { outcome: 'superseded_by_newer_request' } });
  assert.equal(replaced.status, 'cancelled');
  assert.equal(replaced.resolution, 'Replaced by a newer request.');
  const failed = card({ kind: 'request_confirmation', status: 'failed', payload: { prompt: 'x' }, result: {} });
  assert.equal(failed.status, 'failed', 'failed is not shown as answered');
  assert.match(failed.resolution, /did not go through/);
  const resume = card({ kind: 'request_confirmation', status: 'accepted', payload: { prompt: 'x' }, result: { outcome: 'accepted', resumeFailure: { status: 'needs_attention', errorCode: 'x', attempt: 3, maxAttempts: 3 } } });
  assert.match(resume.notice, /could not pick the work back up after 3 tries/);
  const retrying = card({ kind: 'request_confirmation', status: 'accepted', payload: { prompt: 'x' }, result: { outcome: 'accepted', resumeFailure: { status: 'retrying', errorCode: null, attempt: 1, maxAttempts: 3 } } });
  assert.match(retrying.notice, /try 1 of 3/);
});

test('workspace_sync_pending switches Approve off with a reason; a question without required stays required, required:false is optional', () => {
  const c = card({ kind: 'request_confirmation', acceptanceBlocker: 'workspace_sync_pending', payload: { prompt: 'Go?' } });
  assert.match(c.blocker, /still being prepared/);
  assert.equal(card({ kind: 'request_confirmation', payload: { prompt: 'Go?' } }).blocker, undefined);
  const q = card({ kind: 'ask_user_questions', payload: { questions: [{ id: 'a', prompt: 'A', options: [{ id: 'x', label: 'X' }] }, { id: 'b', prompt: 'B', required: false, options: [{ id: 'y', label: 'Y' }] }] } });
  assert.deepEqual(q.questions.map((x: any) => x.required), [true, false]);
  assert.equal(card({ kind: 'request_confirmation', payload: { prompt: 'Go?', rejectRequiresReason: true, rejectReasonLabel: 'Why not?' } }).rejectRequiresReason, true);
});

// --- the backend answers each kind ---------------------------------------------------------------------------------------------------------
function fake(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => { const url = new URL(input); calls.push({ method: init.method ?? 'GET', url: url.pathname + url.search, body: init.body ? JSON.parse(String(init.body)) : undefined }); return handler(url, init); };
  return { calls, fetch };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('each kind is answered on its own endpoint, with the field names the server reads', async () => {
  const f = fake(() => json({}));
  const backend = new PaperclipBackend({ baseUrl: 'https://pc.example.com' }, { fetch: f.fetch as never });
  await backend.respond('RAG-1', 'i1', { accept: true });
  await backend.respond('RAG-1', 'i2', { accept: true, selectedClientKeys: ['k1', 'k2'] });
  await backend.respond('RAG-1', 'i3', { accept: true, selectedOptionIds: ['a'] });
  await backend.respond('RAG-1', 'i4', { accept: true, verdicts: [{ id: 'x', verdict: 'reject', reason: 'No' }, { id: 'y', verdict: 'approve' }] });
  await backend.respond('RAG-1', 'i5', { accept: false, connection: true, reason: 'Not now' });
  await backend.respond('RAG-1', 'i6', { accept: false, reason: 'Keep it' });
  assert.deepEqual(f.calls.map(c => `${c.method} ${c.url} ${JSON.stringify(c.body)}`), [
    'POST /api/issues/RAG-1/interactions/i1/accept {}',
    'POST /api/issues/RAG-1/interactions/i2/accept {"selectedClientKeys":["k1","k2"]}',
    'POST /api/issues/RAG-1/interactions/i3/accept {"selectedOptionIds":["a"]}',
    'POST /api/issues/RAG-1/interactions/i4/verdicts {"verdicts":[{"id":"x","verdict":"reject","reason":"No"},{"id":"y","verdict":"approve"}]}',
    'POST /api/connection-intents/i5/decline {"reason":"Not now"}',
    'POST /api/issues/RAG-1/interactions/i6/reject {"reason":"Keep it"}',
  ]);
});

test('a comment draft sends its clientRequestId, and a retry sends the same one', async () => {
  const f = fake(() => json({ id: 'c1', body: 'hi', createdAt: now }));
  const backend = new PaperclipBackend({ baseUrl: 'https://pc.example.com' }, { fetch: f.fetch as never });
  const id = '3f1f1d4e-7a2b-4c1d-9a55-0d4f5a5b6c7d';
  await backend.comment('RAG-1', 'hi', new Map(), id);
  await backend.comment('RAG-1', 'hi', new Map(), id);
  assert.deepEqual(f.calls.map(c => c.body.clientRequestId), [id, id]);
});

test('a cost event carries an idempotency key built from its run', () => {
  const receipt = { runId: 'run-9', at: now, model: 'm', provider: 'p', tokens: { input: 1, cached: 0, output: 2 } } as never;
  const a = costEventFor({ engine: 'org-definition', receipt, costUsd: 0.1, agentId: 'a', issueId: 't', projectId: null, userId: 'u', provider: undefined });
  const b = costEventFor({ engine: 'org-definition', receipt, costUsd: 0.1, agentId: 'a', issueId: 't', projectId: null, userId: 'u', provider: undefined });
  assert.equal(a.idempotencyKey, 'muster-local:run-9');
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

// --- paging and rate limits -----------------------------------------------------------------------------------------------------------------
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('issues are paged by afterId (the last id of the page), never by offset', async () => {
  const rows = Array.from({ length: 1500 }, (_, n) => ({ id: uuid(n + 1) }));
  const f = fake(url => {
    const after = url.searchParams.get('afterId'), limit = Number(url.searchParams.get('limit'));
    return json(rows.filter(r => !after || r.id > after).slice(0, limit));
  });
  const client = new PaperclipClient({ baseUrl: 'https://pc.example.com' }, f.fetch as never, { cache: false });
  const seen: string[] = [];
  for await (const page of client.issuePages('co', 'view=compact', false)) seen.push(...page.map(r => String(r.id)));
  assert.equal(seen.length, 1500);
  assert.deepEqual(seen, rows.map(r => r.id), 'no row skipped or repeated');
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0]!.url, /sortField=id&sortDir=asc&limit=1000$/);
  assert.match(f.calls[1]!.url, new RegExp(`afterId=${uuid(1000)}$`));
  assert.ok(f.calls.every(c => !/offset=/.test(c.url)), 'no offset is ever sent');
});

test('a server that rejects the cursor is paged by offset from there on', async () => {
  const rows = Array.from({ length: 3 }, (_, n) => ({ id: uuid(n + 1) }));
  const f = fake(url => {
    if (url.searchParams.has('afterId')) return json({ error: 'afterId not supported' }, 422);
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit'));
    return json(rows.slice(offset, offset + limit));
  });
  const client = new PaperclipClient({ baseUrl: 'https://pc.example.com' }, f.fetch as never, { cache: false });
  const seen: string[] = [];
  for await (const page of client.pages<{ id: string }>('/x?limit=2', 2, p => `/x?limit=2&afterId=${p[p.length - 1]!.id}`, (_p, soFar) => `/x?limit=2&offset=${soFar}`)) seen.push(...page.map(r => r.id));
  assert.deepEqual(seen, rows.map(r => r.id));
});

test('a 429 is retried once after Retry-After, and a second 429 is reported', async () => {
  let n = 0;
  const waits: number[] = [];
  const f = fake(() => ++n === 1 ? json({ error: 'slow down' }, 429, { 'retry-after': '3' }) : json([{ id: 'a' }]));
  const client = new PaperclipClient({ baseUrl: 'https://pc.example.com' }, f.fetch as never, { cache: false, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(await client.get('/companies/co/issues'), [{ id: 'a' }]);
  assert.deepEqual(waits, [3000]);
  assert.equal(f.calls.length, 2);
  const always = fake(() => json({ error: 'slow down' }, 429));
  const stuck = new PaperclipClient({ baseUrl: 'https://pc.example.com' }, always.fetch as never, { cache: false, sleep: async () => undefined });
  await assert.rejects(() => stuck.get('/x'), /429/);
  assert.equal(always.calls.length, 2, 'asked once more, not forever');
});

test('Retry-After: seconds, a date, nothing, and a long wait are all read safely', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(null), 1000);
  assert.equal(retryAfterMs('soon'), 1000);
  assert.equal(retryAfterMs('9999'), 30_000);
  assert.equal(retryAfterMs(new Date(5000).toUTCString(), 2000), 3000);
});
