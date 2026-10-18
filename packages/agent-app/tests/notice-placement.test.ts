import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';

const {parseHTML} = createRequire(import.meta.url)('linkedom');

test('notification placement stays left of the summary in every card layout', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const summaryCss = readFileSync(new URL('../src/renderer/components/summary-card.css', import.meta.url), 'utf8');
  const {document} = parseHTML(`<html><head><style>${css}\n${summaryCss}</style></head><body>
    <main class="center"><aside class="summary-card"></aside></main>
    <div class="notices" role="log"><div class="notice">Saved</div></div>
  </body></html>`);
  // linkedom has no layout engine: resolve the placement class through matching CSSOM rules.
  const placement = (selector: string, property: string) => {
    let value = '';
    for (const rule of document.querySelector('style').sheet.cssRules) {
      if (rule.selectorText === selector && document.querySelector(selector).matches(rule.selectorText)) {
        value = rule.style.getPropertyValue(property) || value;
      }
    }
    return value;
  };
  assert.equal(placement('.summary-card', 'anchor-name'), '--chat-summary');
  assert.equal(placement('.notices', 'position'), 'fixed');
  assert.equal(placement('.notices', 'width'), 'auto');
  // Evaluate only these length expressions against representative viewport/anchor coordinates.
  const length = (value: string, viewport: number, cardLeft?: number) => {
    const expression = value
      .replace(/anchor\(--chat-summary left, 100vw\)/g, String(cardLeft ?? viewport))
      .replace(/100vw/g, String(viewport)).replace(/px/g, '')
      .replace(/calc\(/g, '(').replace(/\b(min|max)\(/g, 'Math.$1(');
    assert.match(expression, /^[\d\s.,()+\-*/Mathminax]+$/);
    return Function(`return (${expression})`)() as number;
  };
  const placements: [number, number?][] = [[1440, 1126], [1000, 686], [760, 320], [1000, 240], [1000]];
  for (const [viewport, cardLeft] of placements) {
    const right = length(placement('.notices', 'right'), viewport, cardLeft);
    const left = length(placement('.notices', 'left'), viewport, cardLeft);
    const width = viewport - right - left;
    assert.ok(width > 0 && width <= 380);
    assert.ok(viewport - right - width >= 16, 'stack stays inside the left window edge');
    if (cardLeft !== undefined) assert.ok(viewport - right <= cardLeft - 10, 'stack clears the card, including with a right pane or folded card');
    else assert.equal(right, 16, 'no summary retains the normal right inset');
  }
});
