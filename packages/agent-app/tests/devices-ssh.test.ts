/** Devices on remote hosts over SSH (#812), against a LOCAL throwaway sshd (as in wave4-envs) and a fake helper that a
 *  fake npm installs. Nothing touches real keys, real hosts or the npm registry; the remote folder is a temp dir. */
import assert from 'node:assert/strict';
import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {scanHostKey, trustHostKey} from '../src/runtime/envs/ssh.ts';
import type {SshHost} from '../src/shared/domains/envs-protocol.ts';
import {SCRCPY_SERVER} from '../src/main/devices/helper.ts';
import {SshDeviceHost, explainRemote, hostChecks} from '../src/main/devices/ssh-host.ts';
import {remoteEnvironment, programCommand} from '../src/main/devices/ssh-script.ts';
import {DeviceHosts, joinDeviceId, splitDeviceId, sshDeviceHostId, type DeviceHost} from '../src/main/devices/hosts.ts';
import {DeviceManager} from '../src/main/devices/manager.ts';
import {helperPaths} from '../src/main/devices/helper.ts';
import type {DeviceHostSummary} from '../src/shared/device-protocol.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(here, '..', 'resources', 'device-helper');
const SSHD = '/usr/sbin/sshd', haveSsh = process.platform !== 'win32' && fs.existsSync(SSHD) && fs.existsSync('/usr/bin/ssh') && fs.existsSync('/usr/bin/ssh-keyscan');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as {port: number}).port; s.close(() => r(p)); }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(50); }
  throw new Error(`timed out waiting for ${what}`);
}

/** A throwaway sshd on a loopback port: its own host key, one generated client key, no password. */
async function sshd(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-812-sshd-')), port = await freePort();
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'throwaway', '-f', path.join(dir, 'client_key')]); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'host', '-f', path.join(dir, 'host_key')]);
  fs.copyFileSync(path.join(dir, 'client_key.pub'), path.join(dir, 'authorized_keys')); for (const f of ['authorized_keys', 'client_key', 'host_key']) fs.chmodSync(path.join(dir, f), 0o600);
  fs.writeFileSync(path.join(dir, 'sshd_config'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host_key\nAuthorizedKeysFile ${dir}/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes no\nPidFile ${dir}/sshd.pid\nLogLevel ERROR\nAllowTcpForwarding yes\n`);
  const child: ChildProcess = spawn(SSHD, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], {stdio: 'ignore'}); t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, {recursive: true, force: true}); });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await wait(100); try { await new Promise<void>((res, rej) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(); }); s.on('error', rej); }); up = true; } catch { /* not yet */ } }
  return up ? {dir, port, key: path.join(dir, 'client_key'), user: os.userInfo().username} : null;
}

/** The fake helper: prints the hub's banner with a token, answers /readyz, wants the bearer token for anything else. */
const FAKE_HUB = String.raw`
import http from 'node:http'; import fs from 'node:fs'; import crypto from 'node:crypto';
const log = process.env.FAKE_LOG || new URL('../../../../../../fake-hub-pids.txt', import.meta.url).pathname;
const token = crypto.randomBytes(18).toString('hex');
fs.appendFileSync(log, process.pid + ' ' + process.argv.slice(2).join(' ') + '\n');
const server = http.createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
  res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({ok: true, url: req.url}));
});
server.listen(0, '127.0.0.1', () => { console.log('Local:   http://localhost:' + server.address().port + '/?token=' + token); });
process.on('SIGTERM', () => process.exit(0));
`;
/** Fake npm: `ci` lays out the package the keeper expects (version from a side file) and keeps the lockfile it got. */
const FAKE_NPM = String.raw`
const fs = require('node:fs'), path = require('node:path');
const here = __dirname;
if (process.argv.includes('--version')) { console.log('10.9.0'); process.exit(0); }
if (!process.argv.includes('ci') || !process.argv.includes('--ignore-scripts')) { console.error('npm ERR! expected ci --ignore-scripts'); process.exit(1); }
const pkg = path.join(process.cwd(), 'node_modules', 'expo-device-hub');
fs.mkdirSync(path.join(pkg, 'dist', 'server'), {recursive: true});
fs.mkdirSync(path.join(pkg, 'vendor', 'serve-sim', 'dist'), {recursive: true});
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name: 'expo-device-hub', version: fs.readFileSync(path.join(here, 'version.txt'), 'utf8').trim()}));
fs.copyFileSync(path.join(here, 'fake-hub.mjs'), path.join(pkg, 'dist', 'server', 'cli.mjs'));
fs.writeFileSync(path.join(pkg, 'vendor', 'serve-sim', 'dist', 'serve-sim.js'), 'require("node:fs").appendFileSync(' + JSON.stringify(path.join(here, 'serve-sim-kills.txt')) + ', process.argv.slice(2).join(" ") + " " + (process.env.TMPDIR || "") + "\\n");');
fs.copyFileSync(path.join(process.cwd(), 'package-lock.json'), path.join(here, 'received-lock.json'));
`;

async function fixture(t: import('node:test').TestContext, options: {version?: string; node?: string; trusted?: boolean} = {}) {
  const s = await sshd(t);
  if (!s) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-812-work-'));
  t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const dataDir = path.join(work, 'data'), root = path.join(work, 'remote-root'), tools = path.join(work, 'fake-tools');
  fs.mkdirSync(dataDir); fs.mkdirSync(tools);
  // A fake Android SDK on the "host": adb and emulator scripts that list nothing.
  const sdk = path.join(work, 'sdk');
  for (const [dir, name] of [['platform-tools', 'adb'], ['emulator', 'emulator']]) { fs.mkdirSync(path.join(sdk, dir!), {recursive: true}); fs.writeFileSync(path.join(sdk, dir!, name!), '#!/bin/sh\nexit 0\n', {mode: 0o755}); }
  fs.writeFileSync(path.join(tools, 'fake-hub.mjs'), FAKE_HUB.replace("process.env.FAKE_LOG || new URL('../../../../../../fake-hub-pids.txt', import.meta.url).pathname", JSON.stringify(path.join(tools, 'hub-pids.txt'))));
  fs.writeFileSync(path.join(tools, 'fake-npm.cjs'), FAKE_NPM);
  fs.writeFileSync(path.join(tools, 'version.txt'), options.version ?? '0.15.3');
  const scrcpyBytes = Buffer.from('fake scrcpy-server for tests');
  const files = http.createServer((_req, res) => { res.writeHead(200); res.end(scrcpyBytes); });
  await new Promise<void>(r => files.listen(0, '127.0.0.1', () => r()));
  t.after(() => files.close());
  const record: SshHost = {id: 'host-1', name: 'build-box', host: '127.0.0.1', port: s.port, user: s.user, keyPath: s.key, remoteDir: '~', trusted: null, lastTest: null};
  if (options.trusted !== false) {
    const scan = await scanHostKey(record);
    trustHostKey(dataDir, record, scan.line);
    record.trusted = {type: scan.type, fingerprint: scan.fingerprint, at: new Date().toISOString()};
  }
  const states: string[] = [];
  const host = new SshDeviceHost(record, {dataDir, userData: work, manifestDir: MANIFEST, fetch,
    script: {root, extraPath: [path.dirname(process.execPath)], env: {ANDROID_HOME: sdk}, npm: [process.execPath, path.join(tools, 'fake-npm.cjs')], ...(options.node ? {node: options.node} : {}),
      scrcpy: {url: `http://127.0.0.1:${(files.address() as net.AddressInfo).port}/scrcpy`, sha256: createHash('sha256').update(scrcpyBytes).digest('hex'), path: SCRCPY_SERVER.path}},
    timing: {healthMs: 200, healthTimeoutMs: 1000, backoffMs: 100, backoffMaxMs: 400, readyMs: 8000},
    changed: h => states.push(h.summary().state)});
  t.after(() => host.stop());
  const keeperRecord = () => { const hosts = path.join(root, 'hosts'); const owner = fs.existsSync(hosts) ? fs.readdirSync(hosts)[0] : undefined; try { return owner ? JSON.parse(fs.readFileSync(path.join(hosts, owner, 'keeper.json'), 'utf8')) as {keeperPid: number; hubPid: number} : null; } catch { return null; } };
  const hubPids = () => fs.existsSync(path.join(tools, 'hub-pids.txt')) ? fs.readFileSync(path.join(tools, 'hub-pids.txt'), 'utf8').trim().split('\n').map(line => Number(line.split(' ')[0])) : [];
  return {s, work, root, tools, host, record, states, keeperRecord, hubPids, scrcpyBytes, dataDir};
}

// Spec: MUS-SPEC-21-812A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812a)
test('SSH host: probe, install the pinned lockfile with scripts off and a checked scrcpy, start with a token, tunnel and health-check it', {skip: !haveSsh}, async t => {
  const f = await fixture(t); if (!f) return t.skip('a throwaway sshd could not start here');
  const summary = await f.host.connect();
  assert.equal(summary.state, 'ready');
  assert.deepEqual(f.states.filter((s, i, all) => s !== all[i - 1]).slice(0, 4), ['connecting', 'installing', 'starting', 'ready']);
  assert.equal(summary.helperVersion, '0.15.3');
  assert.equal(summary.id, sshDeviceHostId('host-1'));
  assert.match(summary.address!, /@127\.0\.0\.1:\d+$/);
  // Installed in the Muster folder from the app's own lockfile, the checked scrcpy beside it, no staging left.
  const install = path.join(f.root, 'tools', 'expo-device-hub', '0.15.3');
  assert.equal(fs.readFileSync(path.join(install, '.install-complete'), 'utf8').trim(), '0.15.3');
  assert.equal(fs.readFileSync(path.join(f.tools, 'received-lock.json'), 'utf8'), fs.readFileSync(path.join(MANIFEST, 'package-lock.json'), 'utf8'));
  assert.deepEqual(fs.readFileSync(path.join(install, ...SCRCPY_SERVER.path)), f.scrcpyBytes);
  assert.deepEqual(fs.readdirSync(path.dirname(install)).filter(name => name.startsWith('.staging-')), []);
  // The hub runs loopback-only with --require-token; Muster talks to it through its own forwarded port.
  const args = fs.readFileSync(path.join(f.tools, 'hub-pids.txt'), 'utf8');
  assert.match(args, /--host 127\.0\.0\.1 --port 0 --require-token/);
  const endpoint = await f.host.hub();
  assert.match(endpoint.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(Number(new URL(endpoint.origin).port), f.host.remote.hubPort);
  assert.equal((await fetch(`${endpoint.origin}/api/devices`)).status, 401, 'the forwarded hub still wants the token');
  assert.equal((await fetch(`${endpoint.origin}/api/devices`, {headers: {authorization: `Bearer ${endpoint.token}`}})).status, 200);
  assert.ok(!fs.readdirSync(f.root, {recursive: true}).some(name => { const file = path.join(f.root, String(name)); return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes(endpoint.token); }), 'the token is never written on the host');
  // Programs on the host run through the same prelude (argv quoted, metacharacters kept).
  assert.equal((await f.host.probe().run('/bin/echo', ['a b', '$HOME;`x`'])).trim(), 'a b $HOME;`x`');
  // A second connect while ready reuses everything.
  const pids = f.hubPids().length;
  await f.host.connect();
  assert.equal(f.hubPids().length, pids);
});

// Spec: MUS-SPEC-21-812B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812b)
test('SSH host: a dropped tunnel reconnects on a new port with the same helper; a helper that dies is started again', {skip: !haveSsh}, async t => {
  const f = await fixture(t); if (!f) return t.skip('a throwaway sshd could not start here');
  await f.host.connect();
  const first = await f.host.hub(), hubPid = f.host.remote.hubPort;
  process.kill(f.host.remote.tunnelPid!, 'SIGKILL');
  await until(() => f.states.includes('reconnecting'), 'reconnecting');
  const second = await f.host.hub();
  assert.equal(f.host.summary().state, 'ready');
  assert.equal(second.token, first.token, 'only the tunnel was rebuilt');
  assert.equal(f.host.remote.hubPort, hubPid);
  assert.equal((await fetch(`${second.origin}/x`, {headers: {authorization: `Bearer ${second.token}`}})).status, 200);
  // The helper itself dies on the host: the keeper reports it, and the next start brings a fresh one.
  const before = f.hubPids();
  process.kill(before.at(-1)!, 'SIGKILL');
  await until(() => f.hubPids().length > before.length && f.host.summary().state === 'ready', 'a fresh helper');
  const third = await f.host.hub();
  assert.notEqual(third.token, first.token);
  assert.equal((await fetch(`${third.origin}/x`, {headers: {authorization: `Bearer ${third.token}`}})).status, 200);
});

// Spec: MUS-SPEC-21-812C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812c)
test('SSH host: disconnecting, and Muster vanishing, leave no process on the host and no ssh here', {skip: !haveSsh}, async t => {
  const f = await fixture(t); if (!f) return t.skip('a throwaway sshd could not start here');
  await f.host.connect();
  const rec = f.keeperRecord()!; assert.ok(rec && alive(rec.keeperPid) && alive(rec.hubPid));
  const {keeperPid: localKeeper, tunnelPid} = f.host.remote;
  await f.host.stop();
  assert.equal(f.host.summary().state, 'off');
  await until(() => !alive(rec.keeperPid) && !alive(rec.hubPid), 'remote processes to stop', 8000);
  assert.ok(!alive(localKeeper!) && !alive(tunnelPid!), 'both ssh processes are gone');
  assert.equal(f.keeperRecord(), null, 'the keeper record is removed');
  if (process.platform === 'darwin') assert.match(fs.readFileSync(path.join(f.tools, 'serve-sim-kills.txt'), 'utf8'), /--kill .*hosts\/[a-f0-9]{24}\/tmp/, 'serve-sim helpers stopped under Muster\'s own TMPDIR');
  await assert.rejects(f.host.hub(), /not connected/);
  // Crash: the local ssh for the keeper is killed outright (as when Muster is killed). The host still cleans up.
  await f.host.connect();
  const again = f.keeperRecord()!;
  process.kill(f.host.remote.keeperPid!, 'SIGKILL');
  await until(() => !alive(again.hubPid) && !alive(again.keeperPid), 'the orphaned helper to stop', 10_000);
});

// Spec: MUS-SPEC-21-812D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812d)
test('SSH host errors: no Node on the host, a helper of another version, an untrusted host key; each said plainly', {skip: !haveSsh}, async t => {
  const noNode = await fixture(t, {node: 'muster-no-such-node'}); if (!noNode) return t.skip('a throwaway sshd could not start here');
  await assert.rejects(noNode.host.connect(), /Node\.js was not found on build-box\. Install Node\.js 20 or later there/);
  assert.equal(noNode.host.summary().state, 'failed');
  assert.match(noNode.host.summary().detail!, /Node\.js was not found/);
  const mismatch = await fixture(t, {version: '0.15.2'}); if (!mismatch) return;
  await assert.rejects(mismatch.host.connect(), /The device helper on build-box is 0\.15\.2, and Muster needs 0\.15\.3\. Disconnect and connect again/);
  assert.equal(mismatch.host.summary().state, 'failed');
  assert.equal(mismatch.hubPids().length, 0, 'a mismatched helper is never started');
  const untrusted = await fixture(t, {trusted: false}); if (!untrusted) return;
  await assert.rejects(untrusted.host.connect(), /Trust build-box's host key first/);
});

// Spec: MUS-SPEC-21-812D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812d)
test('host checks: iOS needs a Mac (a Linux host shows Android only); remote error lines become plain English', () => {
  const linux = hostChecks('lab-linux', {os: 'linux', ios: {available: false, code: 'NOT_A_MAC'}, android: {available: true, sdk: '/home/me/Android/Sdk', has: {sdk: true, adb: true, emulator: true}, detail: 'Android SDK at ~/Android/Sdk'}});
  assert.equal(linux.ios.available, false);
  assert.match(linux.ios.reason!, /iOS Simulators need a Mac with Xcode, and lab-linux runs Linux\. Only its Android Emulators are shown/);
  assert.equal(linux.android.available, true);
  assert.match(explainRemote('mac', 'MUSTER_ERROR NO_NODE Node.js is missing', 127).message, /Node\.js was not found on mac/);
  assert.match(explainRemote('mac', '', 127).message, /Node\.js was not found on mac/);
  assert.match(explainRemote('mac', 'MUSTER_ERROR INTEGRITY A downloaded package did not match', 1).message, /On mac: A downloaded package did not match.*Nothing was installed/);
  assert.match(explainRemote('mac', 'Permission denied (publickey).', 255).message, /refused the key/);
  // The prelude finds the SDK and version-managed Node; program argv is quoted for the remote shell.
  assert.match(remoteEnvironment(), /ANDROID_HOME="\$HOME\/Library\/Android\/sdk"/);
  assert.match(remoteEnvironment(), /\.nvm\/versions\/node/);
  const quoted = programCommand({}, '/bin/echo', ["it's", '; rm -rf /', '$(x)']);
  assert.equal(execFileSync('/bin/sh', ['-c', quoted], {encoding: 'utf8'}).trim(), "it's ; rm -rf / $(x)", 'argv survives both shells untouched');
});

// --- Manager: remote devices beside local ones, through the same paths ---------------------------------------------

function fakeHost(id: string, label: string, overrides: Partial<DeviceHost> = {}): DeviceHost & {runs: string[][]; stopped: number} {
  const runs: string[][] = [];
  const host = {
    id, kind: 'ssh' as const, label, ready: true, runs, stopped: 0,
    summary: (): DeviceHostSummary => ({id, kind: 'ssh', label, state: 'ready', ios: {available: true}, android: {available: true}}),
    connect: async () => host.summary(),
    probe: () => ({
      env: {ANDROID_HOME: '/remote/sdk'}, home: '/Users/remote', platform: 'darwin' as NodeJS.Platform, exists: () => true,
      run: async (file: string, args: string[]) => {
        runs.push([file, ...args]);
        if (args.join(' ') === 'simctl list devices --json') return JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{udid: 'AAAAAAAA-1111', name: 'iPhone 17', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'iPhone-17'}, {udid: 'BBBBBBBB-2222', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true}]}});
        if (file.endsWith('/adb') && args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice\n';
        if (file.endsWith('/adb') && args.includes('avd')) return 'Pixel_9\nOK';
        if (file.endsWith('/adb') && args.includes('sys.boot_completed')) return '1';
        if (file.endsWith('/adb') && args.includes('ro.build.version.release')) return '16';
        return '';
      },
    }),
    runBuffer: async () => Buffer.alloc(0),
    screenshot: async () => png(),
    hub: async () => ({origin: 'http://127.0.0.1:6001', token: 'remote-token', pid: 0}),
    stop: async () => { host.stopped++; },
    ...overrides,
  };
  return host;
}
function png() { const b = Buffer.alloc(24); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(100, 16); b.writeUInt32BE(200, 20); return b; }

// Spec: MUS-SPEC-21-812E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812e)
test('manager: a connected host\'s simulators and emulators are listed beside local ones with the host\'s name; commands run on that host', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-812-mgr-'));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({enabled: true, agentControl: false}));
  const installed = helperPaths(path.join(dir, 'tools'));
  fs.mkdirSync(path.dirname(installed.entry), {recursive: true}); fs.writeFileSync(installed.entry, ''); fs.writeFileSync(installed.sentinel, '0.15.3\n');
  const local: string[][] = [];
  const remote = fakeHost(sshDeviceHostId('rec-1'), 'build-mac');
  const records: SshHost[] = [{id: 'rec-1', name: 'build-mac', host: 'mac.local', port: 22, user: 'me', keyPath: '/k', remoteDir: '~', trusted: null, lastTest: null}, {id: 'rec-2', name: 'unused', host: 'x', port: 2222, user: 'me', keyPath: '/k', remoteDir: '~', trusted: null, lastTest: null}];
  const fetched: string[] = [];
  const hosts = new DeviceHosts({userData: dir, sshHosts: async () => records, create: () => remote, changed: () => {}});
  const manager = new DeviceManager({
    userData: dir, manifestDir: dir, env: {ANDROID_HOME: path.join(dir, 'sdk')}, home: dir, platform: 'darwin', exists: () => true, locate: name => `/bin/${name}`,
    run: async (file, args) => { local.push([file, ...args]); if (args[0] === '-p') return '/Applications/Xcode.app/Contents/Developer'; if (args.join(' ') === 'simctl list devices --json') return JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{udid: 'BBBBBBBB-2222', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true}]}}); return ''; },
    runBuffer: async () => Buffer.alloc(0),
    fetch: (async (url: string) => { fetched.push(String(url)); return new Response('{"ok":true}'); }) as typeof fetch,
    socket: () => { throw new Error('no sockets'); }, emit: () => {}, frame: () => {}, hosts,
  });
  await hosts.connect('rec-1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'device-hosts.json'), 'utf8')), {version: 1, ssh: ['rec-1']});
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'device-hosts.json')).mode & 0o777, 0o600);
  const list = await manager.devices(true);
  const ids = list.devices.map(d => d.id);
  const hid = remote.id;
  assert.ok(ids.includes('BBBBBBBB-2222'), 'local devices stay as they were');
  assert.ok(ids.includes(`${hid}:BBBBBBBB-2222`), 'the same UDID on the host is a different device');
  assert.ok(ids.includes(`${hid}:emulator-5554`));
  const onHost = list.devices.find(d => d.id === `${hid}:AAAAAAAA-1111`)!;
  assert.equal(onHost.hostId, hid); assert.equal(onHost.hostLabel, 'build-mac'); assert.equal(onHost.name, 'iPhone 17');
  assert.equal(list.devices.find(d => d.id === 'BBBBBBBB-2222')!.hostId, undefined);
  assert.equal(list.devices.find(d => d.id === `${hid}:emulator-5554`)!.name, 'Pixel_9');
  assert.ok(remote.runs.some(r => r[0] === '/remote/sdk/platform-tools/adb'), 'the host\'s own SDK paths');
  // Boot and shut down a remote simulator: the host runs simctl with its own UDID; nothing runs here.
  const localBefore = local.length;
  await manager.boot(`${hid}:BBBBBBBB-2222`);
  assert.ok(remote.runs.some(r => r.join(' ') === '/usr/bin/xcrun simctl boot BBBBBBBB-2222'));
  assert.ok(!local.slice(localBefore).some(r => r.includes('boot')));
  const shot = await manager.screenshot(`${hid}:AAAAAAAA-1111`);
  assert.equal(shot.width, 100);
  await manager.button(`${hid}:emulator-5554`, 'power').catch(error => assert.match(String(error), /Open the device first/));
  // Setup lists every SSH host, used or not.
  const setup = await manager.setup();
  assert.deepEqual(setup.hosts!.map(h => [h.label, h.state]), [['build-mac', 'ready'], ['unused', 'off']]);
  assert.equal(setup.hosts![1]!.address, 'me@x:2222');
  // Disconnecting removes its devices; dispose stops every host.
  await assert.rejects(manager.open(`${sshDeviceHostId('nope')}:AAAAAAAA-1111`), /not connected|no longer available/);
  await hosts.disconnect('rec-1');
  assert.equal(remote.stopped, 1);
  assert.ok(!(await manager.devices(true)).devices.some(d => d.hostId));
  await hosts.connect('rec-1');
  await manager.dispose();
  assert.equal(remote.stopped, 2);
  void fetched;
  fs.rmSync(dir, {recursive: true, force: true});
});

// Spec: MUS-SPEC-21-812E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812e)
test('device ids: a host prefix round-trips and never captures a local id; a failing host is reported by name and the rest still list', async () => {
  const hid = sshDeviceHostId('abc');
  assert.match(hid, /^ssh-[a-f0-9]{12}$/);
  assert.deepEqual(splitDeviceId(joinDeviceId(hid, 'avd:Pixel_9')), {hostId: hid, raw: 'avd:Pixel_9'});
  for (const local of ['AAAAAAAA-1111-2222', 'emulator-5554', 'avd:Pixel_9']) assert.deepEqual(splitDeviceId(local), {hostId: null, raw: local});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-812-ids-'));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({enabled: true}));
  const installed = helperPaths(path.join(dir, 'tools'));
  fs.mkdirSync(path.dirname(installed.entry), {recursive: true}); fs.writeFileSync(installed.entry, ''); fs.writeFileSync(installed.sentinel, '0.15.3\n');
  const good = fakeHost(sshDeviceHostId('g'), 'good');
  const bad = fakeHost(sshDeviceHostId('b'), 'flaky', {probe: () => ({...good.probe(), run: async () => { throw new Error('connection reset'); }})});
  const records = ['g', 'b'].map(id => ({id, name: id, host: 'h', port: 22, user: 'u', keyPath: '/k', remoteDir: '~', trusted: null, lastTest: null}));
  const hosts = new DeviceHosts({userData: dir, sshHosts: async () => records, create: record => record.id === 'g' ? good : bad, changed: () => {}});
  const manager = new DeviceManager({userData: dir, manifestDir: dir, env: {}, home: dir, platform: 'linux', exists: () => false, locate: () => undefined, run: async () => '', runBuffer: async () => Buffer.alloc(0),
    fetch: (async () => new Response('{}')) as typeof fetch, socket: () => { throw new Error('x'); }, emit: () => {}, frame: () => {}, hosts});
  await hosts.connect('g'); await hosts.connect('b');
  const list = await manager.devices(true);
  assert.ok(list.devices.some(d => d.hostLabel === 'good'), 'the healthy host still lists');
  assert.ok(list.errors.some(e => /^flaky: iOS: connection reset/.test(e)), list.errors.join(' | '));
  await manager.dispose();
  fs.rmSync(dir, {recursive: true, force: true});
});
