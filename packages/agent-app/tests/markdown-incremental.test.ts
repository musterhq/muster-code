import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';
import { VFile } from 'vfile';
import remarkParse from 'remark-parse';
import { createIncrementalMarkdownParser, createIncrementalMarkdownPlugin } from '../src/renderer/markdown-incremental.ts';

function rendered(source: string, incremental: boolean, plugin = incremental ? createIncrementalMarkdownPlugin() : undefined): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: plugin ? [plugin, remarkGfm] : [remarkGfm],
    children: source,
  }));
}

function fullTree(source: string): unknown {
  const processor = unified().use(remarkParse).use(remarkGfm);
  return processor.parse(source);
}

test('one incremental parser keeps streamed trees and HTML equivalent', () => {
  const parser = createIncrementalMarkdownPlugin();
  const first = '```js\nconst n = 1;\n```\n\n| key | value |\n| --- | --- |\n| one | pending |\n\n';
  const second = `${first}| two | ready |\n`;
  const third = `${second}A paragraph after the table.\n\n[later][ref]\n\n[ref]: https://example.test/reference\n`;
  const incremental = [first, second, third].map((source) => rendered(source, true, parser));
  assert.equal(incremental[0], rendered(first, false));
  assert.equal(incremental[1], rendered(second, false));
  assert.equal(incremental[2], rendered(third, false));

  const processor = unified().use(remarkParse).use(remarkGfm);
  const parse = createIncrementalMarkdownParser((source) => processor.parse(source));
  const trees = [first, second, third].map((source) => parse(source, new VFile(source)));
  assert.deepEqual(trees[0], fullTree(first));
  assert.deepEqual(trees[1], fullTree(second));
  assert.deepEqual(trees[2], fullTree(third));
});

test('unclosed fences and replacements fall back to document-equivalent output', () => {
  const parser = createIncrementalMarkdownPlugin();
  const open = 'Intro\n\n```ts\nconst value = 1;\n';
  const closed = `${open} ` + '```\n\nAfter\n';
  const replacement = 'Intro\n\n```ts\nconst value = 2;\n```\n\nAfter\n';
  assert.equal(rendered(open, true, parser), rendered(open, false));
  assert.equal(rendered(closed, true, parser), rendered(closed, false));
  assert.equal(rendered(replacement, true, parser), rendered(replacement, false));
  const processor = unified().use(remarkParse).use(remarkGfm);
  const parse = createIncrementalMarkdownParser((source) => processor.parse(source));
  parse(open, new VFile(open));
  parse(closed, new VFile(closed));
  assert.deepEqual(parse(replacement, new VFile(replacement)), fullTree(replacement));
});

test('closed code prefixes reduce parsed source characters for long streaming tails', (t) => {
  const prefix = `~~~js\n${'console.log(1);\n'.repeat(6000)}~~~\n\n`;
  const first = `${prefix}tail 1`;
  const second = `${prefix}tail 2 with a small update`;
  let incrementalCharacters = 0;
  let fullCharacters = 0;
  const processor = unified().use(remarkParse).use(remarkGfm);
  const incremental = createIncrementalMarkdownParser((source) => {
    incrementalCharacters += source.length;
    return processor.parse(source);
  });
  incremental(first, new VFile(first));
  const secondTree = incremental(second, new VFile(second));
  processor.parse(first);
  processor.parse(second);
  fullCharacters = first.length + second.length;
  assert.equal(secondTree.type, 'root');
  assert.ok(incrementalCharacters < fullCharacters, `${incrementalCharacters} should be below ${fullCharacters}`);
  t.diagnostic(`parsed source characters: incremental=${incrementalCharacters}, full=${fullCharacters}`);
  assert.ok(rendered(second, true).includes('tail 2 with a small update'));
});
