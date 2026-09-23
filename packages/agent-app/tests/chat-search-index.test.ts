import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ChatSearchIndex, buildSnippet, searchTerms, type SearchableChat} from '../src/runtime/chat-search.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

function item(chatId: string, id: string, kind: TimelineItem['kind'], text: string): TimelineItem {
  return {id, chatId, kind, text, createdAt: '2026-09-01T00:00:00.000Z'};
}

function source(chats: SearchableChat[], timelines: Record<string, TimelineItem[]>) {
  const revisions: Record<string, number> = {};
  const reads: string[] = [];
  return {
    reads, revisions,
    chats: () => chats,
    revision: (chatId: string) => revisions[chatId] ?? 0,
    items: (chatId: string) => { reads.push(chatId); return timelines[chatId] ?? []; },
  };
}

test('NAV-11 index: every term must appear in one message; tools and reasoning are not indexed', () => {
  const src = source([{id: 'a', updatedAt: '2026-09-02', archived: false}, {id: 'b', updatedAt: '2026-09-03', archived: false}], {
    a: [item('a', 'a1', 'user', 'Move the proxy to Hono'), item('a', 'a2', 'tool', 'hono proxy tool output')],
    b: [item('b', 'b1', 'user', 'Hono is nice'), item('b', 'b2', 'assistant', 'The proxy lives elsewhere'), item('b', 'b3', 'reasoning', 'hono proxy')],
  });
  const index = new ChatSearchIndex(src);
  const hits = index.search('hono proxy');
  assert.deepEqual(hits.map(hit => hit.chatId), ['a'], 'b has both words, but never in the same message');
  assert.equal(hits[0].itemId, 'a1');
  assert.equal(hits[0].matches, 1);
  assert.deepEqual(index.search('   '), [], 'blank query finds nothing');
});

test('NAV-11 index: phrase matches outrank scattered terms, then recency; archived chats are skipped', () => {
  const src = source([
    {id: 'old', updatedAt: '2026-01-01', archived: false},
    {id: 'new', updatedAt: '2026-09-01', archived: false},
    {id: 'phrase', updatedAt: '2025-01-01', archived: false},
    {id: 'gone', updatedAt: '2026-09-09', archived: true},
  ], {
    old: [item('old', 'o1', 'user', 'database then later a migration')],
    new: [item('new', 'n1', 'user', 'migration of the database')],
    phrase: [item('phrase', 'p1', 'assistant', 'We need a database migration today')],
    gone: [item('gone', 'g1', 'user', 'database migration')],
  });
  const ids = new ChatSearchIndex(src).search('database migration').map(hit => hit.chatId);
  assert.deepEqual(ids, ['phrase', 'new', 'old']);
});

test('NAV-11 index: paging with offset/limit, and unchanged chats are never re-read', () => {
  const chats = Array.from({length: 7}, (_, n) => ({id: `c${n}`, updatedAt: `2026-09-0${n + 1}`, archived: false}));
  const timelines = Object.fromEntries(chats.map(chat => [chat.id, [item(chat.id, `${chat.id}-1`, 'user', `deploy the ${chat.id} service`)]]));
  const src = source(chats, timelines);
  const index = new ChatSearchIndex(src);
  const first = index.search('deploy', {limit: 3});
  const second = index.search('deploy', {offset: 3, limit: 3});
  const third = index.search('deploy', {offset: 6, limit: 3});
  assert.deepEqual([first.length, second.length, third.length], [3, 3, 1]);
  assert.deepEqual(first.map(hit => hit.chatId), ['c6', 'c5', 'c4'], 'newest first among equal scores');
  assert.equal(new Set([...first, ...second, ...third].map(hit => hit.chatId)).size, 7, 'pages never overlap');
  assert.equal(src.reads.length, 7, 'each chat read once across three queries');
  src.revisions.c2 = 5;
  timelines.c2.push(item('c2', 'c2-2', 'assistant', 'rollback plan'));
  assert.deepEqual(index.search('rollback').map(hit => hit.chatId), ['c2'], 'a moved revision re-reads that chat');
  assert.equal(src.reads.length, 8);
});

test('NAV-11 snippet: a one-line window around the first hit, with merged highlight ranges', () => {
  const long = `${'alpha '.repeat(30)}the Hono\nproxy config ${'omega '.repeat(30)}`;
  const {snippet, ranges} = buildSnippet(long, searchTerms('proxy hono'));
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), 'clipped on both sides');
  assert.ok(!snippet.includes('\n'), 'flattened to one line');
  const marked = ranges.map(([start, end]) => snippet.slice(start, end).toLowerCase());
  assert.deepEqual(marked, ['hono', 'proxy']);
  const short = buildSnippet('Hono', ['hono']);
  assert.deepEqual(short, {snippet: 'Hono', ranges: [[0, 4]]});
});
