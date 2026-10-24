import assert from 'node:assert/strict';
import test from 'node:test';
import {formatTokenCount, formatUsd} from '../src/shared/model-catalog.ts';

// Spec: MUS-SPEC-17-557A (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-557a)
test('token counts never read as a thousand of the next unit', () => {
  assert.equal(formatTokenCount(999_999), '1M');
  assert.equal(formatTokenCount(999_500), '1M');
  assert.equal(formatTokenCount(999_499), '999K');
  assert.equal(formatTokenCount(999_950), '1M');
});
// Spec: MUS-SPEC-17-557B (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-557b)
test('very large token counts get a billions unit', () => {
  assert.equal(formatTokenCount(2_500_000_000), '2.5B');
  assert.equal(formatTokenCount(1e12), '1000B');
  assert.equal(formatTokenCount(999_999_999), '1B');
  assert.equal(formatTokenCount(999_499_999), '999M');
});
// Spec: MUS-SPEC-17-557C (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-557c)
test('a negative cost is not shown as under a cent', () => {
  assert.equal(formatUsd(-5), '—');
});
