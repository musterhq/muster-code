import test from 'node:test';
import assert from 'node:assert/strict';
import {countPatchLines, netChangeCounts} from '../src/renderer/turnChangeTotals.ts';

const edit1 = '@@ -1 +1,2 @@\n-export const total = 1;\n+export const total = 2;\n+export const ready = true;\n';
const edit2 = '@@ -1,2 +1,2 @@\n-export const total = 2;\n+export const total = 3;\n export const ready = true;\n';
const edit3 = '@@ -1,2 +1 @@\n export const total = 3;\n-export const ready = true;\n';

test('a single patch counts its own body lines', () => {
  assert.deepEqual(countPatchLines(edit1), {adds: 2, dels: 1});
  assert.deepEqual(netChangeCounts([{diff: edit1}]), {adds: 2, dels: 1});
  assert.deepEqual(netChangeCounts([]), {adds: 0, dels: 0});
});

test('several edits to one file net out instead of summing churn', () => {
  assert.deepEqual(netChangeCounts([{diff: edit1}, {diff: edit2}]), {adds: 2, dels: 1}, 'rewriting a line the turn already added counts it once');
  assert.deepEqual(netChangeCounts([{diff: edit1}, {diff: edit2}, {diff: edit3}]), {adds: 1, dels: 1}, 'removing a line the turn added cancels it');
  assert.deepEqual(netChangeCounts([{diff: '@@ -1 +1 @@\n-a\n+b\n'}, {diff: '@@ -1 +1 @@\n-b\n+a\n'}]), {adds: 0, dels: 0}, 'a reverted edit is no change');
});

test('full texts win over patch composition', () => {
  const before = 'export const total = 1;\n', after = 'export const total = 3;\n';
  assert.deepEqual(netChangeCounts([{diff: edit1, before}, {diff: edit2}, {diff: edit3, after}]), {adds: 1, dels: 1});
  assert.deepEqual(netChangeCounts([{diff: edit1, before, after: before}]), {adds: 0, dels: 0}, 'identical texts mean nothing changed even when a patch was reported');
});
