import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {check} from './dom-check.ts';
const require = createRequire(import.meta.url), {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node});
window.muster = {invoke: async () => undefined, subscribe: () => () => {}};
const React = await import('react'), {createRoot} = await import('react-dom/client'), {flushSync} = await import('react-dom');
const {MessageBody} = await import('../src/renderer/components/MessageBody');
const root = createRoot(document.getElementById('root')!);
const text = 'First line\nSecond **bold** line\nThird `inline` line\n\nSeparate paragraph\n\n- List line\n  continued line\n\n> Quote line\n> continued quote\n\nExplicit  \nbreak\n\n```text\ncode first\ncode second\n```\n\n    indented first\n    indented second\n\n| Name | Value |\n| --- | --- |\n| first | `one` |\n| second | two |';
for (const animate of [false, true]) {
  flushSync(() => root.render(<MessageBody text={text} animate={animate} linkFiles/>));
  const body = document.querySelector('.md-body')!;
  const prose = body.querySelector('p')!;
  // Spec: MUS-SPEC-01-599A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-599a)
  await check('a single newline in assistant prose, lists and quotes shows as a line break', async () => {
    assert.equal(prose.querySelectorAll('br').length, 2, 'single newlines become DOM line breaks');
    assert.equal(prose.querySelector('strong')!.textContent, 'bold', 'inline formatting is preserved');
    assert.equal(body.querySelectorAll('p')[1]!.textContent, 'Separate paragraph', 'blank lines still separate paragraphs');
    assert.equal(body.querySelector('li')!.querySelectorAll('br').length, 1, 'list continuations retain their line breaks');
    assert.equal(body.querySelector('blockquote')!.querySelectorAll('br').length, 1, 'quoted prose retains its line breaks');
    assert.equal(Array.from(body.querySelectorAll('p')).find(p => p.textContent === 'Explicit\nbreak')!.querySelectorAll('br').length, 1, 'explicit breaks are not doubled');
    const blocks = body.querySelectorAll('pre');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.textContent, 'code first\ncode second');
    assert.equal(blocks[1]!.textContent, 'indented first\nindented second');
    assert.equal(body.querySelectorAll('code br, pre br, table br').length, 0, 'code and tables get no prose breaks');
    assert.equal(body.querySelectorAll('tbody tr').length, 2, 'table rows remain structured');
  });
}
// A Markdown document keeps CommonMark soft breaks: a hard-wrapped file reads as flowing paragraphs.
flushSync(() => root.render(<MessageBody text={'Wrapped at eighty\ncolumns in a README'} asDocument/>));
await check('a Markdown document keeps soft line breaks as spaces', async () => {
  assert.equal(document.querySelectorAll('.md-body br').length, 0, 'documents keep soft breaks as spaces');
});
// Streaming text that arrives on a new line still fades in.
const {setTimeout: delay} = await import('node:timers/promises');
const stream = async (value: string) => { root.render(<MessageBody text={value} animate linkFiles/>); await delay(15); };
await stream('Line one');
await stream('Line one\nLine two arrives');
await stream('Line one\nLine two arrives\nLine three');
// Spec: MUS-SPEC-01-599B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-599b)
await check('streamed text that arrives on a new line still fades in with its line break', async () => {
  assert.deepEqual(Array.from(document.querySelectorAll('.md-fade')).map(e => e.textContent), ['Line two arrives', 'Line three'], 'new lines fade in');
  assert.equal(document.querySelectorAll('.md-body br').length, 2);
});
root.unmount();
console.log('markdown-breaks-dom: passed');
