import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const rule = (css: string, selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

test('a narrow diff header keeps the file name and wraps its compare/actions group instead of crushing them', () => {
  const css = readFileSync(new URL('../src/renderer/components/diff-view.css', import.meta.url), 'utf8');
  assert.match(rule(css, '.diff-view .diff-head'), /flex-wrap:\s*wrap/);
  // A zero flex-basis let the path shrink to nothing before anything else gave way.
  assert.match(rule(css, '.diff-view .diff-head .file-path'), /flex:\s*1 1 1[0-9]{2}px/);
  const actions = rule(css, '.diff-head-actions');
  assert.match(actions, /margin-left:\s*auto/);
  assert.match(actions, /flex-wrap:\s*wrap/);
  assert.match(css, /@container \(max-width: 4\d\dpx\) \{ \.diff-head \.review-baseline-prefix \{ display:none; \} \}/);
  const view = readFileSync(new URL('../src/renderer/components/DiffView.tsx', import.meta.url), 'utf8');
  const group = /<div className="diff-head-actions">([\s\S]*?)<\/div>\n\s*<\/header>/.exec(view)?.[1] ?? '';
  assert.ok(group.includes('{baselineControl}') && group.includes('Open current file'), 'the compare picker and file actions wrap together');
});
