/** Review 281 should-fix 13: the remote-agent client never saves a plain-http server address that a claim response suggests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { origin, savedServer } from '../src/cli-agent.ts';
import { UsageError } from '../src/cli.ts';

test('R281 should-fix 13: the saved server address follows the https rule, whatever the claim response says', () => {
  const joined = 'https://muster.example.com';
  assert.equal(savedServer(joined, 'https://public.example.com/'), 'https://public.example.com', 'a public https address is kept');
  assert.equal(savedServer(joined, 'http://muster.example.com'), joined, 'a downgrade to http is ignored');
  assert.equal(savedServer(joined, 'http://evil.example.com:8080'), joined);
  assert.equal(savedServer(joined, 'https://user:pw@evil.example.com'), joined, 'credentials in the address are refused');
  assert.equal(savedServer(joined, 'not a url'), joined); assert.equal(savedServer(joined, undefined), joined); assert.equal(savedServer(joined, 42), joined);
  assert.equal(savedServer('http://127.0.0.1:7860', 'http://localhost:7860'), 'http://localhost:7860', 'loopback may stay http');
  assert.throws(() => origin('http://muster.example.com'), UsageError);
});
