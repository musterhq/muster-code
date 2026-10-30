/** Maths in replies, DOM: formulas typeset through KaTeX with their labels, prices stay text, a streaming or invalid formula shows its
 *  source, copying a selection gives back the TeX (and a diagram's fence) as written, and the Settings switch turns it off. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
import {until} from './dom-wait.ts';
const require = createRequire(import.meta.url), {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, {window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver,
  requestAnimationFrame: (fn: any) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, localStorage: {getItem: () => null, setItem: () => {}}, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }});
const computed = {getPropertyValue: () => '', display: 'block', visibility: 'visible', color: 'rgb(0, 0, 0)', transitionDuration: '0s', transitionDelay: '0s', animationName: 'none'};
Object.assign(globalThis, {getComputedStyle: () => computed}); window.getComputedStyle = () => computed;
Object.assign(window, {setTimeout, clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect = function () { return {x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 300, width: 600, height: 300}; };
(window as any).muster = {subscribe: () => () => {}, invoke: async () => undefined};
setTimeout(() => { console.error('markdown-math-dom: timed out'); process.exit(4); }, 90_000);

const React = await import('react'), {createRoot} = await import('react-dom/client');
const {setRichRenderers} = await import('../src/renderer/richRenderers');
setRichRenderers({async mermaid(source: string) { return {svg: `<svg width="200" height="100"><text>${source.split('\n')[0]}</text></svg>`, width: 200, height: 100}; }});
const {MessageBody} = await import('../src/renderer/components/MessageBody');
const store = await import('../src/renderer/store');
const root = createRoot(document.getElementById('root')!);
const show = async (text: string, animate = false) => { root.render(<MessageBody text={text} animate={animate} linkFiles/>); await delay(30); };
const $ = (selector: string, scope: ParentNode = document) => scope.querySelector(selector);
const $$ = (selector: string, scope: ParentNode = document) => [...scope.querySelectorAll(selector)];
const failures: unknown[] = [];
const fail = (error: unknown) => { failures.push(error); console.error(error); };

// Copying: the suite stands in for the browser's selection (linkedom has none) with the nodes a real selection would clone.
let selection: any = null;
(window as any).getSelection = () => selection;
const select = (nodes: Node[], ancestor: Node) => {
  selection = {rangeCount: 1, isCollapsed: false, toString: () => nodes.map(node => node.textContent).join(''),
    getRangeAt: () => ({collapsed: false, commonAncestorContainer: ancestor, cloneContents() { const fragment = document.createDocumentFragment(); for (const node of nodes) fragment.appendChild(node.cloneNode(true)); return fragment; }})};
};
const copy = (target: Element) => {
  const data = new Map<string, string>();
  const event = new window.Event('copy', {bubbles: true, cancelable: true});
  Object.defineProperty(event, 'clipboardData', {value: {setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? ''}});
  target.dispatchEvent(event);
  return {data, prevented: event.defaultPrevented};
};

const reply = 'Inline $x^2$ and \\(y_1\\), then\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n\nPrices $5 and $10 stay, so does $HOME, `$x$` and [a link](https://example.com/?$select=id).';

// Spec: MUS-SPEC-21-785A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785a)
await check('a reply typesets inline and display maths, labelled, with display maths scrolling sideways', async () => {
  await show(reply);
  await until(() => $$('[data-markdown-math] .katex').length === 3, 'three typeset formulas');
  const inline = $$('[data-markdown-math="inline"]'), display = $$('[data-markdown-math="display"]');
  assert.equal(inline.length, 2, 'two inline formulas');
  assert.equal(display.length, 1, 'one display formula');
  for (const formula of inline) {
    assert.equal(formula.getAttribute('role'), 'group');
    assert.equal(formula.getAttribute('aria-label'), 'Inline equation');
    assert.ok($('.katex', formula), 'inline formula is typeset');
    assert.equal($('.katex-display', formula), null, 'inline formula is not display style');
  }
  assert.equal(display[0]!.getAttribute('aria-label'), 'Display equation');
  assert.ok($('.katex-display', display[0]!), 'display formula is display style');
  const scroller = $('.md-math-scroll', display[0]!)!;
  assert.ok(scroller, 'display formula sits in a horizontal scroller');
  assert.equal(scroller.getAttribute('tabindex'), '0', 'the scroller takes keyboard focus (and shows a focus ring)');
  assert.ok($('math annotation[encoding="application/x-tex"]', display[0]!), 'MathML with the TeX annotation is there for assistive tech');
  const prose = $$('.md-body p').at(-1)!;
  assert.match(prose.textContent!, /Prices \$5 and \$10 stay, so does \$HOME,/, 'prices and shell variables stay text');
  assert.equal($('code', prose)!.textContent, '$x$', 'a code span keeps its dollars');
  assert.equal($('[data-markdown-math]', prose), null, 'no formula in the price line');
  assert.match(prose.textContent!, /a link/);
  // trust:false: TeX cannot make links or active HTML.
  await show('Safe $\\href{javascript:alert(1)}{x}$ and $\\htmlClass{evil}{y}$.');
  await delay(50);
  assert.equal($('.md-body a[href^="javascript"]'), null, 'no javascript: link from TeX');
  assert.equal($('.md-body .evil'), null, 'no class injected from TeX');
}).catch(fail);

// Spec: MUS-SPEC-21-785F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785f)
await check('a streaming formula shows its source until it closes, and invalid TeX shows its source', async () => {
  await show('Energy \\(E = mc', true);
  assert.equal($('[data-markdown-math]'), null, 'an unfinished inline formula is not a formula yet');
  assert.match($('.md-body')!.textContent!, /E = mc/, 'its source shows');
  await show('Energy \\(E = mc^2\\) and $$\\sum_i', true);
  await until(() => $('[data-markdown-math] .katex'), 'the closed formula typesets');
  assert.equal($$('[data-markdown-math]').length, 1, 'only the closed formula is typeset');
  assert.match($('.md-body')!.textContent!, /\$\$\\sum_i/, 'the open display formula shows as written');
  await show('Energy \\(E = mc^2\\) and $$\\sum_i x_i$$ done.', true);
  await until(() => $$('[data-markdown-math] .katex').length === 2, 'both formulas typeset');
  // Invalid TeX: the source, never a broken render or a KaTeX error box.
  await show('Broken $\\frac{1}$ and fine $a$.');
  await until(() => $('[data-markdown-math] .katex'), 'the valid formula typesets');
  const broken = $$('[data-markdown-math]')[0]!;
  assert.equal($('.katex', broken), null, 'invalid TeX is not typeset');
  assert.equal($('.katex-error', broken), null, 'no KaTeX error box');
  assert.equal(broken.textContent, '$\\frac{1}$', 'invalid TeX shows its source as written');
}).catch(fail);

// Spec: MUS-SPEC-21-785G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785g)
await check('copying a selection with maths or a diagram gives back the TeX and the fenced source', async () => {
  const fence = '```mermaid\nflowchart LR\n  A-->B\n```';
  await show(`Area is $\\pi r^2$ here.\n\n$$\nE=mc^2\n$$\n\n${fence}\n\nAfter.`);
  await until(() => $$('[data-markdown-math] .katex').length === 2 && $('.rich-block[data-status=ready]'), 'formulas and the diagram render');
  const body = $('.md-body')!;
  const blocks = [...body.childNodes].filter(node => !(node as Element).classList?.contains('md-quote'));
  // Across the whole reply.
  select(blocks, body);
  let result = copy(body);
  assert.ok(result.prevented, 'the copy is handled');
  assert.equal(result.data.get('text/plain'), `Area is $\\pi r^2$ here.\n\n$$\nE=mc^2\n$$\n\n${fence}\n\nAfter.`, 'the TeX keeps its delimiters and the diagram copies as its fence');
  const html = result.data.get('text/html') ?? '';
  assert.match(html, /E=mc\^2/, 'the HTML flavour carries the TeX');
  assert.doesNotMatch(html, /katex|<svg/, 'the HTML flavour drops the typeset glyphs and the drawing');
  // Part of one formula: the whole formula.
  const glyph = $('[data-markdown-math="inline"] .katex-html')!;
  select([glyph.firstChild!], glyph);
  assert.equal(copy(body).data.get('text/plain'), '$\\pi r^2$', 'part of a formula copies the whole formula');
  // Inside the diagram: its fence.
  const stage = $('.rich-block')!;
  select([stage.firstChild!], stage);
  assert.equal(copy(body).data.get('text/plain'), fence, 'a selection inside a diagram copies its fenced source');
  // Plain prose is left to the browser.
  const after = $$('.md-body p').at(-1)!;
  select([after.firstChild!], after);
  result = copy(body);
  assert.equal(result.prevented, false, 'a selection without maths or a diagram copies as the browser does');
  assert.equal(result.data.size, 0);
  // Lists, code blocks and tables around a formula come back as Markdown; the table's own Copy as Markdown keeps the TeX too.
  const mixed = '- item with **bold** and $a^2$\n- second\n\n```ts\nconst x = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| area | $\\pi r^2$ |';
  await show(mixed);
  await until(() => $$('[data-markdown-math] .katex').length === 2, 'formulas in the list and the table typeset');
  const mixedBody = $('.md-body')!;
  select([...mixedBody.childNodes].filter(node => !(node as Element).classList?.contains('md-quote')), mixedBody);
  assert.equal(copy(mixedBody).data.get('text/plain'), mixed, 'the reply copies back as the Markdown it was written in');
  const clipboard: string[] = [];
  (window as any).muster.invoke = async (command: string, input: any) => { if (command === 'clipboard.write') clipboard.push(input.text); return undefined; };
  ($('.md-table [aria-label="Copy table"]') as HTMLElement).dispatchEvent(new window.Event('click', {bubbles: true}));
  await until(() => $('.md-table-copy-menu'), 'the table copy menu');
  ($$('.md-table-copy-menu button').find(button => button.textContent === 'Copy as Markdown') as HTMLElement).dispatchEvent(new window.Event('click', {bubbles: true}));
  await until(() => clipboard.length, 'the table copy');
  assert.match(clipboard[0]!, /\| area \| \$\\pi r\^2\$ \|/, 'Copy table keeps the formula as TeX');
  (window as any).muster.invoke = async () => undefined;
  selection = null;
}).catch(fail);

// Spec: MUS-SPEC-21-785H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785h)
await check('maths is on by default and the Chat setting turns it off', async () => {
  assert.equal(store.getState().settings['chat.mathRendering'], true, 'on by default');
  await store.setSetting('chat.mathRendering', false);
  await show('Inline $x^2$ and\n\n$$\na+b\n$$');
  await delay(50);
  assert.equal($('[data-markdown-math]'), null, 'with the setting off no formula is typeset');
  assert.match($('.md-body')!.textContent!, /Inline \$x\^2\$ and/, 'the reply shows the TeX as written');
  await store.setSetting('chat.mathRendering', true);
  await until(() => $$('[data-markdown-math] .katex').length === 2, 'turning it back on typesets the formulas');
}).catch(fail);

root.unmount();
if (failures.length) { console.error(`markdown-math-dom: ${failures.length} check(s) failed`); process.exit(1); }
console.log('markdown-math-dom: passed');
process.exit(0);
