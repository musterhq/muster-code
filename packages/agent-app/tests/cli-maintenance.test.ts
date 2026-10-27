import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compareVersions, createCliMaintenance, extractVersion} from '../src/runtime/cli-maintenance.ts';

async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'muster-cli-')); t.after(() => rm(path, {recursive: true, force: true})); return path; }

/** A fake npm: "installs" a script whose --version prints the requested version. No network, no real CLI. */
function harness(root: string, home: string, options: {published?: string; failInstall?: boolean} = {}) {
  let running = 0, published = options.published ?? '0.50.0';
  const env: NodeJS.ProcessEnv = {};
  const installs: string[] = [], activated: string[] = [], changes: string[] = [];
  const cli = createCliMaintenance({
    root, env, home,
    activeSessions: () => running,
    latestVersion: async () => published,
    install: async (pkg, version, prefix) => {
      installs.push(`${pkg}@${version}`);
      if (options.failInstall) throw new Error('npm ERR! network');
      const bin = join(prefix, 'node_modules', '.bin');
      await mkdir(bin, {recursive: true});
      await writeFile(join(bin, pkg === '@openai/codex' ? 'codex' : pkg === 'opencode-ai' ? 'opencode' : 'claude'), `#!/bin/sh\necho "cli ${version}"\n`);
    },
    version: async path => { if (!existsSync(path)) return null; const match = /cli (\S+)/.exec(readFileSync(path, 'utf8')); return match ? `codex-cli ${match[1]}` : null; },
    onActivate: tool => activated.push(tool),
    onChange: status => changes.push(`${status.tool}:${status.managed.current}`),
  });
  return {cli, env, installs, activated, changes, setRunning: (n: number) => { running = n; }, publish: (v: string) => { published = v; }};
}

test('PRO-11: versions compare numerically and are read from --version lines', () => {
  assert.equal(extractVersion('codex-cli 0.46.0'), '0.46.0');
  assert.equal(extractVersion('1.2.3-beta.1 (Claude Code)'), '1.2.3-beta.1');
  assert.equal(extractVersion('no version'), null);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('PRO-11: detects an update, defers it while a chat runs and applies it once runs settle', async t => {
  const root = await directory(t), home = await directory(t);
  await mkdir(join(home, '.local/bin'), {recursive: true});
  const own = join(home, '.local/bin/codex');
  await writeFile(own, '#!/bin/sh\necho "cli 0.40.0"\n'); await chmod(own, 0o755);
  const h = harness(root, home);
  let status = await h.cli.status('codex');
  assert.equal(status.installed.path, own, 'the user’s own install is detected');
  assert.equal(status.installed.managed, false);
  assert.equal(status.updateAvailable, false, 'nothing is claimed before a check');
  status = await h.cli.check('codex');
  assert.equal(status.latest, '0.50.0');
  assert.equal(status.updateAvailable, true);

  h.setRunning(2);
  const deferred = await h.cli.update('codex');
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(deferred.status.pending?.version, '0.50.0');
  assert.deepEqual(h.installs, [], 'nothing is installed while chats run');
  await h.cli.idle();
  assert.deepEqual(h.installs, [], 'still running: still deferred');

  h.setRunning(0);
  await h.cli.idle();
  assert.deepEqual(h.installs, ['@openai/codex@0.50.0']);
  status = await h.cli.status('codex');
  assert.equal(status.pending, null);
  assert.equal(status.installed.managed, true);
  assert.equal(status.installed.version, '0.50.0');
  assert.equal(h.env.MUSTER_CODEX_COMMAND, h.cli.binary('codex', '0.50.0'), 'runs now use the managed binary');
  assert.ok(existsSync(own), 'the user’s own install is untouched');
  assert.equal(status.rollbackTarget, 'your own install');
});

test('PRO-11: rollback returns to the previous managed version, then to the user’s own install; refused while running', async t => {
  const root = await directory(t), home = await directory(t);
  const h = harness(root, home);
  await h.cli.update('codex', '0.50.0');
  h.publish('0.51.0');
  const second = await h.cli.update('codex');
  assert.equal(second.outcome, 'updated');
  assert.deepEqual(second.status.managed, {current: '0.51.0', previous: '0.50.0', versions: ['0.51.0', '0.50.0']});
  h.setRunning(1);
  await assert.rejects(h.cli.rollback('codex'), /Wait for running chats/);
  h.setRunning(0);
  let status = await h.cli.rollback('codex');
  assert.equal(status.managed.current, '0.50.0');
  assert.equal(h.env.MUSTER_CODEX_COMMAND, h.cli.binary('codex', '0.50.0'));
  // A third version drops the oldest copy but keeps the one it replaces.
  h.publish('0.52.0');
  await h.cli.update('codex');
  assert.equal(existsSync(h.cli.binary('codex', '0.51.0')), false, 'only one previous version is kept');
  assert.equal(existsSync(h.cli.binary('codex', '0.50.0')), true);
  status = await h.cli.rollback('codex');
  assert.equal(status.managed.current, '0.50.0');
  await rm(h.cli.binary('codex', '0.52.0'));
  status = await h.cli.rollback('codex');
  assert.equal(status.managed.current, null, 'with no previous copy on disk, rollback leaves the managed install');
  assert.equal(h.env.MUSTER_CODEX_COMMAND, undefined, 'and runs go back to the user’s own CLI');
  await assert.rejects(h.cli.rollback('codex'), /not a Muster-managed install/);
});

test('PRO-11: a failed install changes nothing and reports why; state survives a restart', async t => {
  const root = await directory(t), home = await directory(t);
  const failing = harness(root, home, {failInstall: true});
  const result = await failing.cli.update('claude', '2.0.0');
  assert.equal(result.outcome, 'failed');
  assert.match(result.status.lastError ?? '', /Update to 2.0.0 failed; nothing changed. npm ERR! network/);
  assert.equal(result.status.managed.current, null);
  assert.equal(existsSync(join(root, 'claude', '2.0.0')), false, 'the partial install is removed');
  const ok = harness(root, home);
  await ok.cli.update('opencode', '1.0.0');
  const restarted = harness(root, home);
  assert.equal(restarted.env.MUSTER_OPENCODE_COMMAND, restarted.cli.binary('opencode', '1.0.0'), 'the managed version is re-activated at startup');
  assert.ok(restarted.activated.includes('opencode'));
  await assert.rejects(restarted.cli.update('codex', 'latest-ish'), /No published version/);
});

const codexTriple = (): string | null => ({'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl'} as Record<string, string>)[`${process.platform}-${process.arch}`] ?? null;

/** A local npm registry serving @openai/codex: `latest` and one platform package whose tarball holds the native binary. */
async function codexRegistry(t: TestContext, version: string, options: {badIntegrity?: boolean} = {}) {
  const {createServer} = await import('node:http');
  const {createHash} = await import('node:crypto');
  const {execFileSync} = await import('node:child_process');
  const work = await directory(t), triple = codexTriple()!, platform = `${process.platform}-${process.arch}`;
  const vendor = join(work, 'package', 'vendor', triple);
  await mkdir(join(vendor, 'bin'), {recursive: true});
  await writeFile(join(vendor, 'bin', 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`); await chmod(join(vendor, 'bin', 'codex'), 0o755);
  await writeFile(join(vendor, 'codex-package.json'), JSON.stringify({layoutVersion: 1, version, target: triple, entrypoint: 'bin/codex'}));
  await writeFile(join(work, 'package', 'package.json'), JSON.stringify({name: '@openai/codex', version: `${version}-${platform}`}));
  execFileSync('tar', ['-czf', join(work, 'p.tgz'), '-C', work, 'package']);
  const tarball = readFileSync(join(work, 'p.tgz'));
  const integrity = `sha512-${createHash('sha512').update(options.badIntegrity ? Buffer.from('other') : tarball).digest('base64')}`;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? ''); requests.push(url);
    const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    if (url === '/@openai/codex/latest') return void response.end(JSON.stringify({version}));
    if (url === `/@openai/codex/${version}-${platform}`) return void response.end(JSON.stringify({version: `${version}-${platform}`, dist: {tarball: `${base}/p.tgz`, integrity}}));
    if (url === '/p.tgz') return void response.end(tarball);
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return {registry: `http://127.0.0.1:${(server.address() as {port: number}).port}`, requests};
}

// Spec: MUS-SPEC-03-721H (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-721h)
test('MUS-SPEC-03-721H: on a machine with no Codex, npm or Node, one click installs a Codex that runs', {skip: process.platform === 'win32' ? 'the stand-in binary is a shell script' : !codexTriple() && 'no Codex build for this platform'}, async t => {
  const root = await directory(t), home = await directory(t);
  const {registry, requests} = await codexRegistry(t, '0.70.0');
  const env: NodeJS.ProcessEnv = {PATH: '', npm_config_registry: registry, MUSTER_APP_ROOTS: await directory(t)};
  const cli = createCliMaintenance({root, env, home, activeSessions: () => 0});
  const before = await cli.status('codex');
  assert.equal(before.installed.path, null, 'nothing to borrow: no Codex on PATH and no other app');
  const result = await cli.update('codex');
  assert.equal(result.outcome, 'updated', result.status.lastError ?? '');
  assert.equal(result.status.installed.version, '0.70.0', 'the installed Codex runs and reports its version');
  assert.equal(result.status.installed.managed, true);
  assert.equal(env.MUSTER_CODEX_COMMAND, result.status.installed.path, 'chats now run this Codex');
  assert.match(readFileSync(env.MUSTER_CODEX_COMMAND!, 'utf8'), /codex-cli 0\.70\.0/, 'the command is the native binary itself, so no Node is needed to start it');
  assert.ok(existsSync(join(env.MUSTER_CODEX_COMMAND!, '..', '..', 'codex-package.json')), 'the binary keeps its package layout beside it');
  assert.ok(requests.includes('/@openai/codex/latest') && requests.includes('/p.tgz'));
});

// Spec: MUS-SPEC-03-721I (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-721i)
test('MUS-SPEC-03-721I: a download that fails its checksum installs nothing', {skip: process.platform === 'win32' ? 'the stand-in binary is a shell script' : !codexTriple() && 'no Codex build for this platform'}, async t => {
  const root = await directory(t), home = await directory(t);
  const {registry} = await codexRegistry(t, '0.70.0', {badIntegrity: true});
  const env: NodeJS.ProcessEnv = {PATH: '', npm_config_registry: registry, MUSTER_APP_ROOTS: await directory(t)};
  const cli = createCliMaintenance({root, env, home, activeSessions: () => 0});
  const result = await cli.update('codex');
  assert.equal(result.outcome, 'failed');
  assert.match(result.status.lastError ?? '', /Update to 0\.70\.0 failed; nothing changed\..*checksum/i);
  assert.equal(result.status.installed.path, null);
  assert.equal(env.MUSTER_CODEX_COMMAND, undefined);
  assert.equal(existsSync(join(root, 'codex', '0.70.0')), false, 'the partial download is removed');
});
