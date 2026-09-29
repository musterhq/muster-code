import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {passwordStoreSwitch} from '../src/main/linux-launch.ts';
import {weakBackend} from '../src/runtime/memory-context.ts';
import {detectDocker, dockerSocketCandidates} from '../src/runtime/setup-detection.ts';
import {findBinary} from '../src/runtime/adapters/shared.ts';

/** A fake install dir: the launcher plus a muster-agent.bin that prints its arguments, and a fake /proc. */
function fixture(t: TestContext, proc: Record<string, string>, opts: {apparmorProfile?: boolean} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'muster-launcher-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const app = join(root, 'app'), procRoot = join(root, 'proc'), apparmor = join(root, 'apparmor.d');
  mkdirSync(app); mkdirSync(apparmor);
  copyFileSync(join(import.meta.dirname, '..', 'resources', 'linux', 'muster-agent.sh'), join(app, 'muster-agent')); chmodSync(join(app, 'muster-agent'), 0o755);
  writeFileSync(join(app, 'muster-agent.bin'), '#!/bin/sh\necho "ARGS:$*"\n'); chmodSync(join(app, 'muster-agent.bin'), 0o755);
  for (const [file, value] of Object.entries(proc)) { mkdirSync(join(procRoot, file, '..'), {recursive: true}); writeFileSync(join(procRoot, file), `${value}\n`); }
  if (opts.apparmorProfile) writeFileSync(join(apparmor, 'muster-agent'), 'profile');
  return (args: string[] = [], env: Record<string, string> = {}) => {
    const run = spawnSync(join(app, 'muster-agent'), args, {encoding: 'utf8', env: {PATH: process.env.PATH!, MUSTER_PROC_ROOT: procRoot, MUSTER_APPARMOR_DIR: apparmor, ...env}});
    return {out: run.stdout.trim(), err: run.stderr};
  };
}
const RESTRICTED = {'sys/kernel/apparmor_restrict_unprivileged_userns': '1', 'sys/user/max_user_namespaces': '63000'};

test('launcher: keeps the sandbox on where user namespaces work', {skip: process.platform === 'win32'}, t => {
  const run = fixture(t, {'sys/kernel/apparmor_restrict_unprivileged_userns': '0', 'sys/user/max_user_namespaces': '63000'});
  assert.equal(run(['--x']).out, 'ARGS:--x');
  assert.equal(run().err, '');
});

test('launcher: falls back to --no-sandbox only when namespaces are restricted (AppImage/tarball on Ubuntu 24.04)', {skip: process.platform === 'win32'}, t => {
  const run = fixture(t, RESTRICTED);
  const result = run(['--foo']);
  assert.equal(result.out, 'ARGS:--no-sandbox --foo');
  assert.match(result.err, /--no-sandbox/);
  assert.equal(run(['--no-sandbox']).out, 'ARGS:--no-sandbox', 'an explicit flag is not duplicated');
});

test('launcher: the deb AppArmor profile grants user namespaces, so the sandbox stays on', {skip: process.platform === 'win32'}, t => {
  assert.equal(fixture(t, RESTRICTED, {apparmorProfile: true})(['--x']).out, 'ARGS:--x');
});

test('launcher: kernels without user namespaces fall back; MUSTER_NO_SANDBOX overrides both ways', {skip: process.platform === 'win32'}, t => {
  assert.equal(fixture(t, {'sys/kernel/unprivileged_userns_clone': '0'})().out, 'ARGS:--no-sandbox');
  assert.equal(fixture(t, {'sys/user/max_user_namespaces': '0'})().out, 'ARGS:--no-sandbox');
  assert.equal(fixture(t, {})().out, 'ARGS:', 'unknown kernels keep the sandbox');
  assert.equal(fixture(t, RESTRICTED)([], {MUSTER_NO_SANDBOX: '0'}).out, 'ARGS:');
  assert.equal(fixture(t, {})([], {MUSTER_NO_SANDBOX: '1'}).out, 'ARGS:--no-sandbox');
});

test('password store: unknown desktops ask for libsecret; known ones and explicit flags are left alone', () => {
  assert.equal(passwordStoreSwitch({XDG_CURRENT_DESKTOP: 'sway'}, [], 'linux'), 'gnome-libsecret');
  assert.equal(passwordStoreSwitch({}, [], 'linux'), 'gnome-libsecret');
  assert.equal(passwordStoreSwitch({XDG_CURRENT_DESKTOP: 'ubuntu:GNOME'}, [], 'linux'), undefined);
  assert.equal(passwordStoreSwitch({XDG_CURRENT_DESKTOP: 'KDE'}, [], 'linux'), undefined);
  assert.equal(passwordStoreSwitch({}, ['--password-store=basic'], 'linux'), undefined);
  assert.equal(passwordStoreSwitch({}, [], 'darwin'), undefined);
});

test('safeStorage backends that are not real encryption count as unavailable', () => {
  assert.equal(weakBackend('basic_text'), true);
  assert.equal(weakBackend('unknown'), true);
  for (const good of ['gnome_libsecret', 'kwallet5', 'kwallet6', 'keychain', 'dpapi', undefined]) assert.equal(weakBackend(good), false);
});

test('docker sockets: DOCKER_HOST first, then Desktop, rootful and rootless Engine', () => {
  assert.deepEqual(dockerSocketCandidates({DOCKER_HOST: 'unix:///custom.sock'}, '/home/u', 1000), ['/custom.sock', '/home/u/.docker/run/docker.sock', '/var/run/docker.sock', '/run/docker.sock', '/run/user/1000/docker.sock']);
  assert.ok(dockerSocketCandidates({XDG_RUNTIME_DIR: '/run/user/7'}, '/h', 7).includes('/run/user/7/docker.sock'));
  assert.equal(dockerSocketCandidates({DOCKER_HOST: 'tcp://x:2375'}, '/h', undefined).includes('tcp://x:2375'), false);
});

test('docker on Linux: Engine wording, and rootless daemons are reached with --host', async () => {
  const seen: string[][] = [];
  const rootless = await detectDocker({platform: 'linux', env: {XDG_RUNTIME_DIR: '/run/user/1000'}, exists: path => path === '/usr/bin/docker' || path === '/run/user/1000/docker.sock', run: async (_f, args) => { seen.push(args); return {ok: true, stdout: '27.1.1\n', stderr: ''}; }});
  assert.equal(rootless.running, true);
  assert.deepEqual(seen[0]!.slice(0, 2), ['--host', 'unix:///run/user/1000/docker.sock']);
  const stopped = await detectDocker({platform: 'linux', env: {}, exists: path => path === '/usr/bin/docker', run: async () => ({ok: false, stdout: '', stderr: 'permission denied'})});
  assert.match(stopped.detail, /daemon is not reachable/);
  assert.doesNotMatch(stopped.detail, /Desktop/);
  const missing = await detectDocker({platform: 'linux', env: {}, exists: () => false, run: async () => ({ok: false, stdout: '', stderr: ''})});
  assert.match(missing.detail, /Docker Engine/);
});

test('CLI discovery finds an npm global prefix, snap and volta installs', {skip: process.platform === 'win32'}, t => {
  const home = mkdtempSync(join(tmpdir(), 'muster-home-')); t.after(() => rmSync(home, {recursive: true, force: true}));
  const prefixBin = join(home, 'npm-prefix', 'bin'), volta = join(home, '.volta', 'bin');
  for (const dir of [prefixBin, volta]) { mkdirSync(dir, {recursive: true}); }
  writeFileSync(join(prefixBin, 'codex'), '#!/bin/sh\n'); chmodSync(join(prefixBin, 'codex'), 0o755);
  writeFileSync(join(volta, 'claude'), '#!/bin/sh\n'); chmodSync(join(volta, 'claude'), 0o755);
  assert.equal(findBinary('codex', {PATH: '', npm_config_prefix: join(home, 'npm-prefix')}, home), join(prefixBin, 'codex'));
  assert.equal(findBinary('claude', {PATH: ''}, home), join(volta, 'claude'));
});
