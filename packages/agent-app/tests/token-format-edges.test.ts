import assert from 'node:assert/strict';
import test from 'node:test';
import {formatTokenCount, formatUsd} from '../src/shared/model-catalog.ts';

test('token counts never read as a thousand of the next unit', () => {
  assert.equal(formatTokenCount(999_999), '1M');
  assert.equal(formatTokenCount(999_500), '1M');
  assert.equal(formatTokenCount(999_499), '999K');
  assert.equal(formatTokenCount(999_950), '1M');
});
test('very large token counts get a billions unit', () => {
  assert.equal(formatTokenCount(2_500_000_000), '2.5B');
  assert.equal(formatTokenCount(1e12), '1000B');
});
test('a negative cost is not shown as under a cent', () => {
  assert.equal(formatUsd(-5), '—');
});
