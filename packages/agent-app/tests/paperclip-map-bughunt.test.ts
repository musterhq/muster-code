/** Bug hunt: server-supplied enum strings must not index into Object.prototype. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapAgent, mapApproval, mapAttention, mapRun } from '../src/runtime/paperclip-map.ts';

test('a server status or kind named like an Object.prototype member falls back to the default', () => {
  for (const word of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(mapAgent({ id: 'a', status: word }).status, 'idle', word);
    assert.equal(mapRun({ id: 'r', status: word }).status, 'failed', word);
    const item = mapAttention({ id: 'i', sourceKind: word });
    assert.equal(item.kind, 'other', word);
    assert.equal(item.why, 'Needs your attention.', word);
    assert.equal(typeof mapApproval({ id: 'p', type: word, payload: {} }, new Map()).title, 'string', word);
  }
});
