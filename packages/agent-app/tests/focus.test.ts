import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isChord } from '../src/renderer/focus.ts';

const base = { key: 'n', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

test('matches clean Cmd+N and Ctrl+N, case-insensitive', () => {
  assert.ok(isChord({ ...base, metaKey: true }, 'n'));
  assert.ok(isChord({ ...base, ctrlKey: true }, 'n'));
  assert.ok(isChord({ ...base, key: 'N', metaKey: true }, 'n'));
  assert.ok(isChord({ ...base, key: 'k', metaKey: true }, 'k'));
});

test('never swallows plain typing or wrong key', () => {
  assert.ok(!isChord(base, 'n'));
  assert.ok(!isChord({ ...base, key: 'k', metaKey: true }, 'n'));
});

test('rejects extra or combined modifiers', () => {
  assert.ok(!isChord({ ...base, metaKey: true, shiftKey: true }, 'n'));
  assert.ok(!isChord({ ...base, metaKey: true, altKey: true }, 'n'));
  assert.ok(!isChord({ ...base, metaKey: true, ctrlKey: true }, 'n'));
});

test('rejects IME composition, key repeat, and handled events', () => {
  assert.ok(!isChord({ ...base, metaKey: true, isComposing: true }, 'n'));
  assert.ok(!isChord({ ...base, metaKey: true, repeat: true }, 'n'));
  assert.ok(!isChord({ ...base, metaKey: true, defaultPrevented: true }, 'n'));
});
