/** Bug hunt: the check-out marker must round-trip every value it can carry. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markerFor, parseLeaseMarker } from '../src/runtime/checkout/lease.ts';

// Spec: MUS-SPEC-12-574E (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-574e)
test('a device name with --> or entities survives the marker', () => {
  for (const device of ['Mac --> office', 'a "quoted" & <b> name', 'x--&gt;y', '&amp;quot;']) {
    const marker = parseLeaseMarker(markerFor('checkout', { device, 'device-id': 'd1', by: 'me', at: '2026-01-01T00:00:00.000Z' }));
    assert.equal(marker?.device, device);
  }
});
