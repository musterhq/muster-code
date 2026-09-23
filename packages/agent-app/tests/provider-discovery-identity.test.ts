import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {discoverLocalProviders} from '../src/runtime/provider-discovery.ts';

const jwt = (claims: object) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

test('ChatGPT sign-in shows a masked, revealable account like Claude Code, never the token', async t => {
  const home = await mkdtemp(join(tmpdir(), 'muster-disc-')); t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, '.codex'));
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({tokens: {access_token: 'SECRET-ACCESS', id_token: jwt({'https://api.openai.com/profile': {email: 'grawish06@gmail.com'}})}}));
  const codex = (await discoverLocalProviders({home, env: {}})).find(p => p.id === 'codex')!;
  assert.equal(codex.identityMasked, 'g***@gmail.com');
  assert.equal(codex.identity, 'grawish06@gmail.com');
  assert.ok(!JSON.stringify(codex).includes('SECRET-ACCESS'), 'tokens never leave discovery');
});

test('a malformed id_token falls back to the generic label', async t => {
  const home = await mkdtemp(join(tmpdir(), 'muster-disc-')); t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, '.codex'));
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({tokens: {access_token: 'x', id_token: 'not-a-jwt'}}));
  const codex = (await discoverLocalProviders({home, env: {}})).find(p => p.id === 'codex')!;
  assert.equal(codex.identityMasked, 'ChatGPT account on file');
  assert.equal(codex.identity, undefined);
});
