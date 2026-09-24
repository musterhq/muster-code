import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('the model rail\'s selected bar sits inside its button, so the scrolling rail never scrolls sideways', () => {
  const css = readFileSync(new URL('../src/renderer/components/composer.css', import.meta.url), 'utf8');
  const rail = /\.composer-model-rail \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rail, /overflow-x:\s*hidden/);
  const bar = /\.composer-model-rail button\[aria-selected='true'\]::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(bar, 'the indicator rule exists');
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const value = new RegExp(`(?:^|[;\\s])${side}:\\s*(-?\\d+)px`).exec(bar)?.[1];
    if (value !== undefined) assert.ok(Number(value) >= 0, `${side}: ${value}px would overflow the button`);
  }
});
