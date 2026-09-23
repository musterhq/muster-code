import assert from 'node:assert/strict';
import {test} from 'node:test';
import {redactSecrets} from '../src/runtime/secret-redaction.ts';
import {suggestRunSummary} from '../src/runtime/memory-context.ts';

// Realistic-looking fixtures, assembled at runtime so no literal credential sits in the repo.
const anthropic = 'sk-ant-api03-' + 'Zx9Qw2Er4Ty6Ui8Op0AsDfGhJkLzXcVbNm1234567890abcdEFGH';
const openai = 'sk-proj-' + 'AbCdEfGhIjKlMnOpQrStUvWx0123456789';
const ghp = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const gho = 'gho_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const pat = 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP';
const slack = 'xoxb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';
const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' + '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA1234567890abcdefghijABCDEFGHIJ', 'qrstuvwxyz0987654321ZYXWVUTSRQPONMLKJIHGFEDCBA', '-----END RSA PRIVATE KEY-----'].join('\n');

test('redactSecrets masks common credential shapes', () => {
  for (const secret of [anthropic, openai, ghp, gho, pat, slack, aws, jwt, pem]) {
    const out = redactSecrets(`before ${secret} after`);
    assert.ok(!out.includes(secret), `masked: ${secret.slice(0, 12)}`);
    assert.match(out, /^before .+ after$/, 'surrounding text survives');
  }
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abcDEF1234567890ghijKLMN"'), 'curl -H "Authorization: Bearer [redacted]"');
});

test('redactSecrets masks .env style assignments whose names mention KEY/TOKEN/SECRET/PASSWORD', () => {
  const env = ['GITHUB_TOKEN=ghx-some-value-123', 'export DB_PASSWORD="correct horse"', 'STRIPE_SECRET_KEY=rk_live_abcdef123456', 'OPENAI_API_KEY=abcd1234efgh', 'api_key: hunter2secret'].join('\n');
  const out = redactSecrets(env);
  for (const value of ['ghx-some-value-123', 'correct', 'rk_live_abcdef123456', 'abcd1234efgh', 'hunter2secret']) assert.ok(!out.includes(value), value);
  assert.match(out, /GITHUB_TOKEN=\[redacted\]/);
  assert.match(out, /STRIPE_SECRET_KEY=\[redacted\]/);
  assert.match(out, /api_key: \[redacted\]/);
});

test('redactSecrets leaves hashes, commit SHAs and ordinary prose alone', () => {
  const benign = [
    'Fixed in commit dea500f and 58375eb4c1a2f3e4d5b6a7c8d9e0f1a2b3c4d5e6.',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'NODE_ENV=production PORT=3000 LOG_LEVEL=debug',
    'The key idea: keep the task list short. Token budgets matter.',
    'Use the monkey-patch in tests/fixtures; see ask-anthropic docs.',
    'uuid 550e8400-e29b-41d4-a716-446655440000',
  ];
  for (const text of benign) assert.equal(redactSecrets(text), text);
});

test('suggested run notes are redacted before they are offered (MEM-08)', () => {
  const summary = suggestRunSummary([
    {kind: 'user', text: `Wire the deploy with ${ghp}`},
    {kind: 'tool', text: 'edit', data: {type: 'fileChange'}},
    {kind: 'assistant', text: `Added OPENAI_API_KEY=abcd1234efgh5678 to .env.local and configured the deploy pipeline to read it at boot.`},
  ]);
  assert.ok(summary);
  assert.ok(!summary!.includes(ghp) && !summary!.includes('abcd1234efgh5678'));
  assert.match(summary!, /OPENAI_API_KEY=\[redacted\]/);
});

test('redactSecrets leaves code that merely names a credential alone', () => {
  const code = [
    'interface Creds { password: string; token: string; apiKey: string }',
    'const token = getToken();',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'password: ${DB_PASSWORD}',
    'TOKEN=$GITHUB_TOKEN',
    'password: <your password>',
    'MONKEY=banana TOKEN_LIMIT=4096',
    'sk-this-is-a-very-long-css-class-name',
  ];
  for (const text of code) assert.equal(redactSecrets(text), text);
});

test('redactSecrets masks a whole quoted value, prefixed names and Basic auth', () => {
  assert.equal(redactSecrets('password="correct horse battery"'), 'password="[redacted]"');
  assert.equal(redactSecrets('aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'aws_secret_access_key = [redacted]');
  assert.equal(redactSecrets('secret_key_base: 0123456789abcdef'), 'secret_key_base: [redacted]');
  assert.equal(redactSecrets('Authorization: Basic ' + 'dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic [redacted]');
  for (const token of ['sk_live_' + 'abcdefghijklmnop1234', 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789', 'hf_' + 'abcdefghijklmnopqrstuvwxyz0123456789']) assert.equal(redactSecrets(token), '[redacted]');
});

test('redactSecrets masks a truncated private key instead of leaking its body', () => {
  const out = redactSecrets('cat key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n');
  assert.ok(!out.includes('b3BlbnNzaC1rZXkt'));
  assert.match(out, /^cat key:\n\[redacted\]$/);
});

test('redactSecrets counts only real replacements', () => {
  const count = {value: 0};
  redactSecrets('token: string and Bearer abcdefghijklmnopqrstu', count);
  assert.equal(count.value, 1);
});

test('redactSecrets stays linear on adversarial input', () => {
  for (const text of ['sk-'.repeat(50_000), '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(20_000), 'a-'.repeat(100_000), 'password: '.repeat(50_000), 'A_'.repeat(100_000) + 'KEY']) {
    const started = performance.now();
    redactSecrets(text);
    assert.ok(performance.now() - started < 1500, `${text.slice(0, 12)}… took ${Math.round(performance.now() - started)} ms`);
  }
});

test('suggested run notes mask a key that straddles the clip boundary', () => {
  const key = 'sk-proj-' + 'Zx9Qw2Er4Ty6Ui8Op0AsDfGhJkLz1234567890';
  const summary = suggestRunSummary([
    {kind: 'user', text: `${'x'.repeat(140)} ${key} and more`},
    {kind: 'tool', text: 'edit', data: {type: 'fileChange'}},
    {kind: 'assistant', text: 'Rotated the deploy credentials and updated the pipeline configuration to read them.'},
  ]);
  assert.ok(summary);
  assert.ok(!summary!.includes('sk-proj-Zx9Q'), summary);
});
