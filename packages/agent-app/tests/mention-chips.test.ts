import assert from 'node:assert/strict';
import {test} from 'node:test';
import {findMentionSpans} from '../src/renderer/mentionChips.ts';
import {resolveToolPath} from '../src/renderer/components/toolPresentation.ts';

const folders = [{id: 'f1', path: '/repo'}];
const resolve = (raw: string) => resolveToolPath(raw, folders, 'f1');

test('F18: an @file mention embedded as plain text recovers as a clickable span', () => {
  const text = 'Use Hono and steer with @apps/api/src/recurrence.ts to fix the recurrence bug.';
  const spans = findMentionSpans(text, resolve);
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(text.slice(span.start, span.end), '@apps/api/src/recurrence.ts');
  assert.deepEqual({folderId: span.folderId, path: span.path}, {folderId: 'f1', path: 'apps/api/src/recurrence.ts'});
});

test('trailing sentence punctuation is trimmed off an unquoted mention', () => {
  const text = 'See @apps/api/src/recurrence.ts.';
  const [span] = findMentionSpans(text, resolve);
  assert.equal(text.slice(span.start, span.end), '@apps/api/src/recurrence.ts');
  assert.equal(text.slice(span.end), '.');
});

test('a quoted mention (path with spaces) recovers with its quotes as part of the chip', () => {
  const text = 'Open @"apps/My Notes/todo list.md" please.';
  const [span] = findMentionSpans(text, resolve);
  assert.equal(text.slice(span.start, span.end), '@"apps/My Notes/todo list.md"');
  assert.equal(span.path, 'apps/My Notes/todo list.md');
});

test('casual @mentions that are not paths never become broken chips', () => {
  assert.deepEqual(findMentionSpans('hey @here can everyone check this out', resolve), []);
  assert.deepEqual(findMentionSpans('ping @channel about the release', resolve), []);
});

test('a chat mention stays plain text (not a file)', () => {
  assert.deepEqual(findMentionSpans('continuing from @chat:"Earlier chat"', resolve), []);
});

test('a mention outside every attached folder is left as text', () => {
  assert.deepEqual(findMentionSpans('see @/elsewhere/secret.ts for details', resolve), []);
});

test('multiple mentions in one message all recover, in order', () => {
  const text = '@package.json and @apps/api/package.json both need a bump';
  const spans = findMentionSpans(text, resolve);
  assert.equal(spans.length, 2);
  assert.equal(text.slice(spans[0].start, spans[0].end), '@package.json');
  assert.equal(text.slice(spans[1].start, spans[1].end), '@apps/api/package.json');
});
