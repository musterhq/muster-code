/** Search highlights must cover the matched text even when lower-casing changes a string's length (U+0130 → "i̇"). */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSnippet,ChatSearchIndex} from '../src/runtime/chat-search.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

// Spec: MUS-SPEC-01-569B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-569b)
test('a snippet after a dotted capital I highlights the matched word itself',()=>{
  const {snippet,ranges}=buildSnippet('İİİİ İstanbul deploy notes',['deploy']);
  assert.equal(ranges.length,1);
  assert.equal(snippet.slice(ranges[0]![0],ranges[0]![1]),'deploy');
});

// Spec: MUS-SPEC-01-569C (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-569c)
test('a long message: the window is centred on the match, not shifted by earlier dotted capitals',()=>{
  const text='İ'.repeat(200)+' '+'filler '.repeat(20)+'needle here';
  const {snippet,ranges}=buildSnippet(text,['needle']);
  assert.equal(ranges.length,1);
  assert.equal(snippet.slice(ranges[0]![0],ranges[0]![1]),'needle');
});

// Spec: MUS-SPEC-01-569A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-569a)
test('the index returns a correct highlight for such a message',()=>{
  const item={id:'i1',chatId:'c1',kind:'assistant',text:'İzmir İzmir release checklist',createdAt:'2026-01-01T00:00:00Z'} as TimelineItem;
  const index=new ChatSearchIndex({chats:()=>[{id:'c1',updatedAt:'2026-01-01',archived:false}],revision:()=>1,items:()=>[item]});
  const [hit]=index.search('checklist');
  assert.ok(hit);
  assert.equal(hit.snippet.slice(hit.ranges[0]![0],hit.ranges[0]![1]),'checklist');
});
