/** Bug hunt: the secret redactor for server text must stay linear on long input. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../src/runtime/checkout/sanitize.ts';

// Spec: MUS-SPEC-19-575A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-575a)
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

// Spec: MUS-SPEC-19-575B (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-575b)
test('credentials in a URL are still redacted', () => {
  assert.equal(redactSecrets('clone https://user:pw123@example.com/x.git now'), 'clone https://[redacted]@example.com/x.git now');
  assert.equal(redactSecrets('push https://user:p@ssw0rd@github.com/o/r.git'), 'push https://[redacted]@github.com/o/r.git');
  assert.equal(redactSecrets('see https://example.com/page?email=a:b@c.d'), 'see https://example.com/page?email=a:b@c.d');
});

// Spec: MUS-SPEC-19-575C (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-575c)
test('a long run of secret words stays linear', () => {
  for (const input of ['KEY'.repeat(20_000), 'TOKEN.'.repeat(10_000), `"${'KEY'.repeat(20_000)}`, 'KEY='.repeat(15_000)]) {
    const started = Date.now();
    redactSecrets(input);
    assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
  }
});

test('a long dotted or prefixed secret name still has its value redacted', () => {
  const name = 'spring.datasource.hikari.data-source-properties.connection-pool.password';
  assert.equal(redactSecrets(`${name}=hunter2`), `${name}=[redacted]`);
  const json = `{"${'X'.repeat(70)}_API_KEY": "supersecret"}`;
  assert.equal(redactSecrets(json), json.replace('supersecret', '[redacted]'));
  assert.equal(redactSecrets('a=GITHUB_TOKEN=x1 b'), 'a=GITHUB_TOKEN=[redacted] b');
});
