/** Bug hunt: the secret redactor for server text must stay linear on long input. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../src/runtime/checkout/sanitize.ts';

test('redacting a long run of name-like characters is not quadratic', () => {
  const started = Date.now();
  redactSecrets('a-'.repeat(30_000));
  assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms for 60k characters`);
});

test('secret assignments are still redacted', () => {
  assert.equal(redactSecrets('GITHUB_TOKEN=abcdef123456'), 'GITHUB_TOKEN=[redacted]');
  assert.equal(redactSecrets('{"api_key": "abc123"}'), '{"api_key": "[redacted]"}');
  assert.equal(redactSecrets('my.service-password: hunter2'), 'my.service-password: [redacted]');
});

test('credentials in a URL are still redacted', () => {
  assert.equal(redactSecrets('clone https://user:pw123@example.com/x.git now'), 'clone https://[redacted]@example.com/x.git now');
});
