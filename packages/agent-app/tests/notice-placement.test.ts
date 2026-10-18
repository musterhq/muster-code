import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

// No layout engine runs here, so the placement expressions are evaluated with CSS anchor() semantics:
// in `left`, anchor(--x side) is that card edge measured from the window's left edge; in `right`, from
// its right edge. A missing card (hidden or another screen) resolves every anchor() to its fallback.
// The same layouts were checked in Chromium, where the measured stack edges match these numbers.
const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const summaryCss = readFileSync(new URL('../src/renderer/components/summary-card.css', import.meta.url), 'utf8');

const block = (source: string, start: number) => source.slice(source.indexOf('{', start) + 1, source.indexOf('}', source.indexOf('{', start) + 1));
const declarations = (body: string) => new Map([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));

function evaluate(value: string, vars: Map<string, string>, viewport: number, property: 'left' | 'right', card?: {left: number; right: number}): number {
  let expression = value;
  for (let depth = 0; /var\(/.test(expression) && depth < 5; depth++) expression = expression.replace(/var\((--[\w-]+)\)/g, (_, name: string) => `(${vars.get(name)!})`);
  expression = expression.replace(/anchor\(--chat-summary (left|right), ([^()]+)\)/g, (_, side: 'left' | 'right', fallback: string) =>
    card ? String(property === 'left' ? card[side] : viewport - card[side]) : `(${fallback})`);
  expression = expression.replace(/(\d+(?:\.\d+)?)vw/g, (_, n: string) => String(Number(n) / 100 * viewport)).replace(/px/g, '')
    .replace(/calc\(/g, '(').replace(/\b(min|max|sign)\(/g, 'Math.$1(').replace(/\bclamp\(/g, 'clamp(');
  assert.match(expression, /^[\d\s.,()+\-*/a-zA-Z]+$/);
  assert.doesNotMatch(expression.replace(/Math\.(min|max|sign)|clamp/g, ''), /[a-zA-Z]/, `unresolved CSS in ${expression}`);
  return Function('clamp', `return (${expression})`)((lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v))) as number;
}

test('notification toasts keep their corner and move left of the summary card only when it reaches in', () => {
  assert.match(summaryCss, /\.summary-card \{[^}]*anchor-name: --chat-summary;/, 'the summary card is the anchor');
  const base = declarations(block(css, css.indexOf('\n.notices {')));
  // Without anchor positioning (or sign()) the corner placement below is what renders.
  assert.equal(base.get('position'), 'fixed');
  assert.equal(base.get('right'), '16px');
  assert.equal(base.get('width'), 'min(380px, calc(100vw - 32px))');
  const supports = css.indexOf('@supports (anchor-name: --a) and (width: calc(1px * sign(1px)))');
  assert.ok(supports > 0, 'anchor placement is gated on support');
  const anchored = declarations(block(css, css.indexOf('.notices {', supports)));
  assert.equal(anchored.get('width'), 'auto');

  const place = (viewport: number, card?: {left: number; right: number}) => {
    const left = evaluate(anchored.get('left')!, anchored, viewport, 'left', card);
    const right = viewport - evaluate(anchored.get('right')!, anchored, viewport, 'right', card);
    return {left, right, width: right - left};
  };
  // No card: the usual corner, 16px in and 380px wide (narrower windows keep 16px on both sides).
  assert.deepEqual(place(1000), {left: 604, right: 984, width: 380});
  assert.deepEqual(place(380), {left: 16, right: 364, width: 348});
  // Card in the top-right corner (no right pane): the stack ends 10px left of it.
  assert.deepEqual(place(1440, {left: 1126, right: 1426}), {left: 736, right: 1116, width: 380});
  // Folded pill: follows the pill's left edge.
  assert.deepEqual(place(1000, {left: 862, right: 986}), {left: 472, right: 852, width: 380});
  // A narrow right pane leaves the card under the corner: still moves.
  assert.deepEqual(place(1440, {left: 826, right: 1126}), {left: 436, right: 816, width: 380});
  // A small window: the stack narrows but stays 16px inside the left edge.
  assert.deepEqual(place(600, {left: 286, right: 586}), {left: 16, right: 276, width: 260});
  // A wide right pane pushes the card clear of the corner: the stack stays put, off the transcript.
  assert.deepEqual(place(1440, {left: 606, right: 906}), {left: 1044, right: 1424, width: 380});
  // The boundary: a card ending exactly where the stack starts does not move it.
  assert.deepEqual(place(1440, {left: 744, right: 1044}), {left: 1044, right: 1424, width: 380});
  assert.deepEqual(place(1440, {left: 745, right: 1045}), {left: 355, right: 735, width: 380});
});
