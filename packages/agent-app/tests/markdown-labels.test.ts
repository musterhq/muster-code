import test from 'node:test';
import assert from 'node:assert/strict';
import {leadingLabel} from '../src/renderer/markdown-labels.ts';

test('leading labels: short "Label:" openings only', () => {
  for (const [text, label] of [['Note: be careful', 'Note:'], ['Root cause: the cache', 'Root cause:'], ['Next step:', 'Next step:'], ['Do not use it: ever', 'Do not use it:'], ["What's left: a lot", "What's left:"]] as const)
    assert.equal(leadingLabel(text), label, text);
});

test('leading labels: negatives are left alone', () => {
  for (const text of ['Meet at 10:30', '10:30 sharp', 'https://example.com', 'mailto:a@b.co', 'src/app.py:12', 'Here is what I found in the logs: x', 'One two three four five: x', 'The answer, in short: yes', 'Is it done? yes: sure', 'Version 2.0: shipped', 'key:value', 'a very long label with words: x', ': empty', '1: first', '`code`: x', 'Note : spaced'])
    assert.equal(leadingLabel(text), null, text);
  assert.equal(leadingLabel('Abcdefghijklm nopqrstuvwxyz abcdef: x'), null, '32+ characters');
});
