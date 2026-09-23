import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvidersDomain } from '../src/runtime/domains/providers.ts';
import { accountHash, invalidateProviderInstances } from '../src/runtime/provider-instances.ts';
import { accountProviderId, activeAccountId, type ProviderAccountRow } from '../src/shared/domains/providers-protocol.ts';

test('PRO-X2: accounts list/add/remove without exposing paths or identities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-accounts-domain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), home = join(root, 'home'), work = join(root, 'work'), empty = join(root, 'empty');
  await mkdir(dataDir); await mkdir(join(home, '.codex'), { recursive: true }); await mkdir(work); await mkdir(empty);
  await writeFile(join(work, 'auth.json'), JSON.stringify({ tokens: { account_id: 'B', access_token: 'T', id_token: `x.${Buffer.from(JSON.stringify({ email: 'work@example.com' })).toString('base64url')}.y` } }));
  const context = { dataDir, emit() {}, db() { throw new Error('no db'); }, hooks: undefined, invoke: async () => [] } as never;
  const domain = createProvidersDomain(context, { shellEnv: false, secrets: { close() {} } as never, cli: {} as never, env: { CODEX_HOME: join(home, '.codex') }, home, directory: join(root, 'runtime') });
  t.after(() => { void domain.dispose?.(); invalidateProviderInstances(); });
  const call = (name: string, input: Record<string, unknown> = {}) => domain.handlers[name]!(input) as { accounts: ProviderAccountRow[] };

  const initial = call('providers.accounts.list');
  assert.deepEqual(initial.accounts.map(a => [a.id, a.removable]), [['default', false]]);
  assert.deepEqual(initial.accounts[0]!.providerIds.sort(), ['hybrow', 'openai-direct']);

  assert.throws(() => call('providers.accounts.add', { codexHome: 'relative/path' }), /full path/);
  assert.throws(() => call('providers.accounts.add', { codexHome: join(root, 'missing') }), /does not exist/);
  assert.throws(() => call('providers.accounts.add', { codexHome: empty }), /No Codex sign-in/);
  assert.throws(() => call('providers.accounts.add', { codexHome: join(home, '.codex') }), /already the default/);

  const added = call('providers.accounts.add', { codexHome: work, label: '  Work  ' });
  const hash = accountHash(work);
  assert.equal(added.accounts.length, 2);
  assert.deepEqual(added.accounts[1], { id: hash, label: 'Work', providerIds: [`openai-direct_${hash}`], ready: false, removable: true });
  const serialized = JSON.stringify(added);
  for (const leak of [work, 'work@', 'w***']) assert.ok(!serialized.includes(leak), `row leaks ${leak}`);
  assert.match(await readFile(join(dataDir, 'provider-accounts.json'), 'utf8'), /"label": "Work"/);

  // Tilde paths expand against home; relabelling the same folder keeps one row.
  await mkdir(join(home, '.codex-two')); await writeFile(join(home, '.codex-two', 'openai-direct.config.toml'), '');
  assert.equal(call('providers.accounts.add', { codexHome: '~/.codex-two' }).accounts.at(-1)!.label, 'Account 3');

  assert.throws(() => call('providers.accounts.remove', { id: 'default' }), /added account/);
  assert.throws(() => call('providers.accounts.remove', { id: '0123456789' }), /no longer listed/);
  const removed = call('providers.accounts.remove', { id: hash });
  assert.deepEqual(removed.accounts.map(a => a.id), ['default', accountHash(join(home, '.codex-two'))]);
});

test('PRO-X2: switching keeps the provider family and the active indicator follows the default model', () => {
  const rows: ProviderAccountRow[] = [
    { id: 'default', label: 'Default sign-in', providerIds: ['hybrow', 'openai-direct'], ready: true, removable: false },
    { id: 'abcdef0123', label: 'Work', providerIds: ['openai-direct_abcdef0123'], ready: true, removable: true },
  ];
  assert.equal(activeAccountId(rows, 'hybrow'), 'default');
  assert.equal(activeAccountId(rows, 'openai-direct_abcdef0123'), 'abcdef0123');
  assert.equal(activeAccountId(rows, 'custom_x'), 'default');
  assert.equal(activeAccountId(rows, undefined), 'default');
  assert.equal(accountProviderId(rows[1]!, 'openai-direct'), 'openai-direct_abcdef0123');
  assert.equal(accountProviderId(rows[1]!, 'hybrow'), 'openai-direct_abcdef0123', 'no gateway profile → direct route');
  assert.equal(accountProviderId(rows[0]!, 'openai-direct_abcdef0123'), 'openai-direct');
  assert.equal(accountProviderId(rows[0]!, 'custom_x'), 'openai-direct');
  assert.equal(accountProviderId({ ...rows[1]!, providerIds: [] }, 'hybrow'), undefined);
});
