import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../src/renderer/${path}`, import.meta.url), 'utf8');

test('F25: the chat header reserves the measured width of the floating controls; title and folder ellipsize', () => {
  const controls = read('components/WorkControls.tsx'), css = read('components/work-controls.css'), styles = read('styles.css');
  assert.match(controls, /--work-controls-width/, 'WorkControls publishes its real width');
  assert.match(controls, /ResizeObserver/, 'and keeps it current as controls come and go');
  assert.match(css, /\.center\[data-work-controls='measured'\] \.chat-head\.chat-head \{ padding-right:calc\(var\(--work-controls-width/);
  assert.match(styles, /\.chat-head-title \{[^}]*text-overflow: ellipsis/);
  assert.match(styles, /\.chat-head-folder \{[^}]*min-width:0[^}]*text-overflow:ellipsis/);
});

test('F18: a sent @file chip reuses the composer chip look (tint + ring), not a link underline', () => {
  const chat = read('components/ChatView.tsx'), css = read('components/message-body.css');
  assert.match(chat, /className="token-chip is-file mention-chip"/);
  assert.match(chat, /onClick=\{\(\)=>void openFile\(span\.folderId,span\.path\)\}/, 'clicking opens the file in the side pane');
  const rule = css.match(/\.mention-chip \{[^}]*\}/)?.[0] ?? '';
  assert.doesNotMatch(rule, /underline/);
  assert.match(rule, /border: 0/); assert.match(rule, /font: inherit/);
});
