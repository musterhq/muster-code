import assert from 'node:assert/strict';
import test from 'node:test';
import {inferMarkdownCodeLanguages} from '../src/renderer/components/codeLanguage.ts';

test('infers syntax for generic code fences near a mentioned source file', () => {
  const markdown = 'Updated `src/math.js`.\n\nBefore:\n```text\nexport function add(a, b) { return a + b; }\n```\n\nAfter:\n```text\nexport function multiply(a, b) { return a * b; }\n```';
  const rendered = inferMarkdownCodeLanguages(markdown);
  assert.equal((rendered.match(/```javascript/g) ?? []).length, 2);
  assert.match(rendered, /```javascript\nexport function add/);
});

test('keeps explicitly selected languages and unrelated text fences unchanged', () => {
  const markdown = 'Edited `src/math.js`.\n```bash\nnpm test\n```\n```text\nplain provider output\n```';
  const rendered = inferMarkdownCodeLanguages(markdown);
  assert.match(rendered, /```bash\nnpm test/);
  assert.match(rendered, /```text\nplain provider output/);
});

test('does not infer from file names inside earlier code blocks', () => {
  const markdown = '```text\nexample.py\n```\n\n```text\nplain output\n```';
  assert.equal(inferMarkdownCodeLanguages(markdown), markdown);
});
