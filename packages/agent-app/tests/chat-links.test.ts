import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chatIdFromArgs,chatIdFromLink,chatLink} from '../src/main/chat-links.ts';

test('chat links round trip opaque local identifiers',()=>{
  const id='chat:abc 123';
  assert.equal(chatIdFromLink(chatLink(id)),id);
});

test('chat links reject foreign, nested and credential-bearing links',()=>{
  assert.equal(chatIdFromLink('https://example.com/chat/id'),null);
  assert.equal(chatIdFromLink('muster://chat/a/b'),null);
  assert.equal(chatIdFromLink('muster://user:secret@chat/id'),null);
  assert.equal(chatIdFromLink('muster://chat/%2Fetc'),null);
});

test('launch arguments select the first valid chat link',()=>{
  assert.equal(chatIdFromArgs(['Muster Agent','--flag','muster://chat/second']), 'second');
});
