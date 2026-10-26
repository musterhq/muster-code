/** #672: the key/value redaction rules have no cap on the length of the name before the secret word, and stay linear. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../src/runtime/secret-redaction.ts';

// Spec: MUS-SPEC-19-674A (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-674a)
test('a secret whose key name is longer than 70 characters is redacted', () => {
  const dotted = 'spring.datasource.hikari.data-source-properties.connection-pool.extra.settings.password';
  assert.ok(dotted.length > 70);
  assert.equal(redactSecrets(`${dotted}=hunter2secret`), `${dotted}=[redacted]`);
  const prefixed = `${'service-'.repeat(12)}api_key`;
  assert.equal(redactSecrets(`${prefixed}: abcdef123456`), `${prefixed}: [redacted]`);
  const json = `{"${'x'.repeat(70)}_token": "abcdef123456"}`;
  assert.equal(redactSecrets(json), json.replace('abcdef123456', '[redacted]'));
  const env = `${'ABCDEFGHIJ_'.repeat(8)}API_KEY=abcdef123456`;
  assert.equal(redactSecrets(env), `${'ABCDEFGHIJ_'.repeat(8)}API_KEY=[redacted]`);
});

test('a 200KB adversarial input finishes in under 50 ms', () => {
  const inputs = [
    'a_'.repeat(100_000), 'password'.repeat(25_000), 'password='.repeat(22_000), 'PASSWORD_'.repeat(22_000), 'api_key '.repeat(25_000),
    `password:${' '.repeat(200_000)}`, `token="${'a'.repeat(200_000)}`, 'KEY='.repeat(50_000), 'secret_key_value_'.repeat(12_000),
  ];
  for (const input of inputs) {
    redactSecrets(input.slice(0, 1000)); // warm up
    const started = performance.now();
    redactSecrets(input);
    const took = performance.now() - started;
    assert.ok(took < 50, `${input.slice(0, 16)}: ${took.toFixed(1)} ms for ${input.length} characters`);
  }
});

test('existing key/value behaviour is unchanged', () => {
  assert.equal(redactSecrets('GITHUB_TOKEN=ghx-some-value-123'), 'GITHUB_TOKEN=[redacted]');
  assert.equal(redactSecrets('export DB_PASSWORD="correct horse"'), 'export DB_PASSWORD="[redacted]"');
  assert.equal(redactSecrets('aws_secret_access_key = abcdef123456'), 'aws_secret_access_key = [redacted]');
  assert.equal(redactSecrets('{"db-password": "hunter2secret"}'), '{"db-password": "[redacted]"}');
  assert.equal(redactSecrets('OPENAI_APIKEY=abcd1234efgh'), 'OPENAI_APIKEY=[redacted]');
  assert.equal(redactSecrets('password: string'), 'password: string');
  assert.equal(redactSecrets('token = getToken()'), 'token = getToken()');
  assert.equal(redactSecrets('password=${DB_PASSWORD}'), 'password=${DB_PASSWORD}');
  assert.equal(redactSecrets('mypassword=abcdef123456'), 'mypassword=abcdef123456', 'a secret word in the middle of a word is not a name');
  assert.equal(redactSecrets('password_hash=abcdef123456'), 'password_hash=abcdef123456');
});
