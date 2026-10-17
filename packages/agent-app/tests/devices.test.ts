/** Devices (#363): discovery parsers, wire formats, flow control, the helper install and lifetime, the manager's
 *  consent and lifecycle rules, the live link, and the agent tools' safety checks. No simulator or helper is needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {androidFormFactor, androidSdkRoot, checkAndroid, checkIos, checkNode, parseAdbDevices, parseAdbPackages, parseAvdList, parseSimctlApps, parseSimctlDevices, listAndroid, type ProbeDeps} from '../src/main/devices/discovery.ts';
import {FrameGate, hasIdr, iosPacket, IOS_TAG, MjpegParser, semuInfo, SEMU_MAGIC} from '../src/main/devices/frames.ts';
import {hidForChar, hidUsageForCode, androidKeycode} from '../src/main/devices/keys.ts';
import {deviceButton, deviceId, parseDeviceInput, DEVICE_COMMANDS} from '../src/shared/device-protocol.ts';
import {helperInstalled, helperPaths, hubArgs, hubEnv, installHelper, npmError, parseHubBanner} from '../src/main/devices/helper.ts';
import {DeviceManager} from '../src/main/devices/manager.ts';
import {DeviceLink, rawPoint, H264_BACKLOG} from '../src/main/devices/link.ts';
import {DeviceToolHost, runDeviceTool, type DeviceToolTarget} from '../src/main/devices/agent-tools.ts';
import {computerRunOptions} from '../src/runtime/domains/computer.ts';
import {adapterBrowser} from '../src/runtime/provider.ts';
import {DEVICE_MCP, DEVICE_NOTE} from '../src/shared/device-protocol.ts';
import {isCommandName} from '../src/main/commands.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muster-devices-'));
const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, n, n, 0xff, 0xd9]);
const part = (data: Buffer, length = true) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\n${length ? `Content-Length: ${data.length}\r\n` : ''}\r\n`), data, Buffer.from('\r\n')]);

test('simctl list: iPhones and iPads, newest runtime first, states mapped, others left out', () => {
  const json = JSON.stringify({devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [{udid: 'AAAAAAAA-1111', name: 'iPhone 16', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16'}],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      {udid: 'BBBBBBBB-2222', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'},
      {udid: 'CCCCCCCC-3333', name: 'iPad Pro 13-inch (M5)', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5'},
      {udid: 'DDDDDDDD-4444', name: 'Old', state: 'Shutdown', isAvailable: false, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-11'}],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{udid: 'EEEEEEEE-5555', name: 'Apple Watch', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch'}],
  }});
  const devices = parseSimctlDevices(json);
  assert.deepEqual(devices.map(d => [d.name, d.osVersion, d.state, d.formFactor]), [['iPhone 17 Pro', 'iOS 26.0', 'booted', 'phone'], ['iPad Pro 13-inch (M5)', 'iOS 26.0', 'shutdown', 'tablet'], ['iPhone 16', 'iOS 18.2', 'shutdown', 'phone']]);
  assert.deepEqual(parseSimctlDevices('not json'), []);
});

test('adb and AVD listings, SDK location and form factors', async () => {
  assert.deepEqual(parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nR58M123\tdevice\nemulator-5556\toffline\n'), [{serial: 'emulator-5554', state: 'device'}, {serial: 'emulator-5556', state: 'offline'}]);
  assert.deepEqual(parseAvdList('Pixel_9_API_36\nINFO    | something\nPixel_Fold\n'), ['Pixel_9_API_36', 'Pixel_Fold']);
  assert.equal(androidFormFactor('Pixel_Fold_API_35'), 'foldable');assert.equal(androidFormFactor('Pixel_Tablet'), 'tablet');assert.equal(androidFormFactor('Pixel_9'), 'phone');
  assert.equal(androidSdkRoot({ANDROID_HOME: '/sdk'}, '/home/u', 'linux'), '/sdk');
  assert.equal(androidSdkRoot({}, '/Users/u', 'darwin'), '/Users/u/Library/Android/sdk');
  assert.equal(androidSdkRoot({LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'}, 'C:\\Users\\u', 'win32'), path.join('C:\\Users\\u\\AppData\\Local', 'Android', 'Sdk'));
  // A running emulator is listed once, under its AVD name, and not again as a stopped AVD.
  const calls: string[][] = [];
  const deps: ProbeDeps = {env: {ANDROID_HOME: '/sdk'}, home: '/h', platform: 'linux', exists: () => true, run: async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice\n';
    if (args[0] === '-list-avds') return 'Pixel_9\nPixel_Fold\n';
    if (args.includes('avd')) return 'Pixel_9\nOK\n';
    if (args.includes('ro.build.version.release')) return '16\n';
    if (args.includes('sys.boot_completed')) return '1\n';
    return '';
  }};
  const list = await listAndroid(deps);
  assert.deepEqual(list.map(d => [d.id, d.name, d.state, d.osVersion]), [['emulator-5554', 'Pixel_9', 'booted', 'Android 16'], ['avd:Pixel_Fold', 'Pixel_Fold', 'shutdown', 'Android']]);
  assert.ok(calls.every(call => call[0].startsWith('/sdk')), 'adb and emulator come from the SDK');
});

test('platform checks explain what is missing with fix steps', async () => {
  const base = {env: {}, home: '/h', exists: () => false} as const;
  const linux = await checkIos({...base, platform: 'linux', run: async () => ''});
  assert.equal(linux.available, false);assert.match(linux.reason!, /Mac with Xcode/);
  const clt = await checkIos({...base, platform: 'darwin', run: async () => '/Library/Developer/CommandLineTools\n'});
  assert.equal(clt.available, false);assert.match(clt.reason!, /Command Line Tools/);assert.ok(clt.fix!.some(step => /xcode-select -s/.test(step)));
  const none = await checkIos({...base, platform: 'darwin', run: async () => { throw new Error('no'); }});
  assert.match(none.reason!, /Xcode is not installed/);
  const xcode = await checkIos({...base, platform: 'darwin', run: async (_f, args) => args[0] === '-p' ? '/Applications/Xcode.app/Contents/Developer' : args[0] === 'xcodebuild' ? 'Xcode 26.1\nBuild version 17B' : ''});
  assert.deepEqual(xcode, {available: true, detail: 'Xcode 26.1'});
  const sdk = await checkAndroid({...base, platform: 'darwin', run: async () => ''});
  assert.match(sdk.reason!, /Android SDK not found/);assert.match(sdk.detail!, /Library\/Android\/sdk/);
  const emu = await checkAndroid({...base, platform: 'linux', env: {ANDROID_HOME: '/sdk'}, exists: file => file === '/sdk', run: async () => ''});
  assert.match(emu.reason!, /Emulator is not installed/);
  assert.match((await checkNode({...base, platform: 'darwin', run: async () => 'v24.1.0'}, undefined, '/npm')).reason!, /Node.js was not found/);
  assert.match((await checkNode({...base, platform: 'darwin', run: async () => 'v18.0.0'}, '/node', '/npm')).reason!, /too old/);
  assert.equal((await checkNode({...base, platform: 'darwin', run: async () => 'v24.1.0\n'}, '/node', '/npm')).available, true);
});

test('MJPEG parser: whole frames however the body is split, with or without Content-Length, garbage skipped', () => {
  const body = Buffer.concat([part(jpeg(1)), part(jpeg(2)), part(jpeg(3), false)]);
  for (const size of [1, 3, 7, 64, body.length]) {
    const parser = new MjpegParser(), frames: Buffer[] = [];
    for (let i = 0; i < body.length; i += size) frames.push(...parser.push(body.subarray(i, i + size)));
    assert.deepEqual(frames.map(f => f[2]), [1, 2, 3], `chunk ${size}`);
  }
  const parser = new MjpegParser();
  assert.deepEqual(parser.push(Buffer.concat([Buffer.from('--frame\r\nContent-Length: 99999999999\r\n\r\n'), part(jpeg(9))])).map(f => f[2]), [9], 'an absurd length is skipped, the next part still parses');
  const huge = new MjpegParser(); huge.push(Buffer.alloc(70 * 1024, 0x41));
  assert.ok(huge.buffered < 70 * 1024, 'header-less garbage does not accumulate');
});

test('latest-frame-wins gate and H.264 helpers', () => {
  const gate = new FrameGate(2);
  assert.ok(gate.offer(jpeg(1), true));assert.ok(gate.offer(jpeg(2), true));
  assert.equal(gate.offer(jpeg(3), true), null);assert.equal(gate.offer(jpeg(4), true), null);
  assert.equal(gate.ack()![2], 4, 'the newest held frame goes next, older held ones are dropped');
  assert.equal(gate.ack(), null);
  const header = Buffer.alloc(16); header.writeUInt32BE(SEMU_MAGIC, 0); header[4] = 1; header[5] = 1; header.writeBigUInt64BE(1234n, 8);
  assert.deepEqual(semuInfo(Buffer.concat([header, Buffer.from([0, 0, 0, 1, 0x65])])), {key: true, payloadOffset: 16, pts: 1234});
  assert.equal(semuInfo(Buffer.from([0, 0, 1, 0x41, 1])).key, false);
  assert.ok(hasIdr(Buffer.from([0, 0, 0, 1, 0x67, 9, 0, 0, 1, 0x65])));
  assert.deepEqual([...iosPacket(IOS_TAG.touch, {a: 1})], [3, ...Buffer.from('{"a":1}')]);
});

test('keyboard tables and input validation', () => {
  assert.equal(hidUsageForCode('KeyA'), 4);assert.equal(hidUsageForCode('Digit0'), 0x27);assert.equal(hidUsageForCode('Enter'), 0x28);assert.equal(hidUsageForCode('F13'), null);
  assert.deepEqual(hidForChar('A'), {usage: 4, shift: true});assert.deepEqual(hidForChar('!'), {usage: 0x1e, shift: true});assert.deepEqual(hidForChar(' '), {usage: 0x2c, shift: false});assert.equal(hidForChar('é'), null);
  assert.equal(androidKeycode('Enter'), 66);assert.equal(androidKeycode('x'), null);
  assert.deepEqual(parseDeviceInput({kind: 'touch', phase: 'move', x: 2, y: -1}), {kind: 'touch', phase: 'move', x: 1, y: 0});
  assert.equal(parseDeviceInput({kind: 'touch', phase: 'tap', x: 0, y: 0}), null);
  assert.equal(parseDeviceInput({kind: 'text', text: ''}), null);assert.equal(parseDeviceInput({kind: 'text', text: 'x'.repeat(4001)}), null);
  assert.equal(parseDeviceInput({kind: 'shell', command: 'rm'}), null);
  assert.equal(deviceId('BBBBBBBB-2222'), 'BBBBBBBB-2222');assert.equal(deviceId('emulator-5554'), 'emulator-5554');assert.equal(deviceId('avd:Pixel_9'), 'avd:Pixel_9');
  for (const bad of ['-s', '../x', 'a b', '', 'x;rm', 42]) assert.throws(() => deviceId(bad), /Invalid device id/);
  assert.throws(() => deviceButton('reboot'), /Unknown device button/);
  for (const name of Object.keys(DEVICE_COMMANDS)) assert.ok(isCommandName(name), name);
  assert.deepEqual(rawPoint({width: 100, height: 200, orientation: 'landscape_left'}, 0.25, 0.5), {x: 0.5, y: 0.75});
});

test('helper: banner parsing, loopback-only args with a token, isolated TMPDIR, env scrubbed', () => {
  assert.deepEqual(parseHubBanner('Expo Device Hub ready\n\n  Local:   http://localhost:51234/?token=abcDEF0123456789abcdef_-\n'), {port: 51234, token: 'abcDEF0123456789abcdef_-'});
  assert.equal(parseHubBanner('Local: http://localhost:3400/'), null, 'no token, no hub');
  const args = hubArgs('/x/cli.mjs');
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');assert.ok(args.includes('--require-token'));assert.ok(!args.includes('0.0.0.0'));
  const dir = tmp();
  const env = hubEnv({PATH: '/bin', HOME: '/h', TMPDIR: '/t', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', EXPO_DEVICE_HUB_SESSION_TOKEN: 'x', OPENAI_API_KEY: 'sk-1', GITHUB_TOKEN: 'ghp'}, dir, '/sdk', 'darwin');
  assert.equal(env.PATH, '/sdk/platform-tools:/sdk/emulator:/bin', 'the SDK tools come first');
  assert.equal(hubEnv({PATH: '/bin', TMPDIR: '/t'}, dir, '/sdk', 'linux').TMPDIR, '/t', 'Linux keeps TMPDIR: the emulator publishes its gRPC discovery there');assert.equal(env.HOME, '/h');
  assert.equal(env.TMPDIR, path.join(dir, 'tmp'));assert.equal(env.ANDROID_HOME, '/sdk');
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'EXPO_DEVICE_HUB_SESSION_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(env[key], undefined, key);
  assert.match(npmError('npm error code ENOTFOUND registry.npmjs.org')!, /internet connection/);
  assert.match(npmError('npm error code EINTEGRITY sha512')!, /checksum/);
  fs.rmSync(dir, {recursive: true, force: true});
});

function fakeChild(code: number, onStart?: (cwd: string) => void) {
  return (command: string, args: string[], options: {cwd?: string}) => {
    const child = new EventEmitter() as EventEmitter & {stdout: PassThrough; stderr: PassThrough; kill(): void; pid: number};
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; child.pid = 42;
    setImmediate(() => { onStart?.(options.cwd ?? ''); if (code) child.stderr.write('npm error code ENOSPC\n'); child.emit('exit', code); });
    (child as unknown as {command: string; args: string[]}).command = command; (child as unknown as {args: string[]}).args = args;
    return child as never;
  };
}

test('helper install: npm ci of the shipped lockfile with scripts off, atomic, sentinel last; failures leave nothing', async () => {
  const dir = tmp(), manifest = path.join(dir, 'manifest');
  fs.mkdirSync(manifest);fs.writeFileSync(path.join(manifest, 'package.json'), '{}');fs.writeFileSync(path.join(manifest, 'package-lock.json'), '{}');
  const paths = helperPaths(path.join(dir, 'tools'));
  const seen: string[][] = [];
  await assert.rejects(installHelper({paths, manifestDir: manifest, npm: {command: '/npm', args: []}, env: {}, spawn: fakeChild(1), fetchScrcpy: async () => Buffer.from('x')}), /disk space/);
  assert.equal(helperInstalled(paths), false);assert.ok(!fs.existsSync(paths.installDir));
  assert.deepEqual(fs.readdirSync(path.dirname(paths.installDir)).filter(n => n.startsWith('.staging')), [], 'staging removed');
  await installHelper({paths, manifestDir: manifest, npm: {command: '/node', args: ['/npm-cli.js']}, env: {}, fetchScrcpy: async () => Buffer.from('scrcpy'), spawn: (command, args, options) => {
    seen.push([command, ...args]);
    return fakeChild(0, cwd => { const entry = path.join(cwd, 'node_modules', 'expo-device-hub', 'dist', 'server'); fs.mkdirSync(entry, {recursive: true}); fs.writeFileSync(path.join(entry, 'cli.mjs'), ''); assert.ok(fs.existsSync(path.join(cwd, 'package-lock.json'))); })(command, args, options);
  }});
  assert.deepEqual(seen[0]!.slice(0, 3), ['/node', '/npm-cli.js', 'ci']);assert.ok(seen[0]!.includes('--ignore-scripts'));
  assert.equal(helperInstalled(paths), true);
  assert.equal(fs.readFileSync(path.join(paths.installDir, 'node_modules', 'expo-device-hub', 'vendor', 'serve-emu', 'vendor', 'scrcpy-server-v4.0'), 'utf8'), 'scrcpy', 'the verified streamer is where serve-emu looks, so it never downloads one itself');
  const {fetchScrcpyServer} = await import('../src/main/devices/helper.ts');
  await assert.rejects(fetchScrcpyServer((async () => new Response('tampered')) as typeof fetch), /checksum/);
  fs.rmSync(dir, {recursive: true, force: true});
});

// --- Manager ------------------------------------------------------------------------------------------------------

function managerFixture(overrides: Partial<ConstructorParameters<typeof DeviceManager>[0]> = {}) {
  const dir = tmp();
  const events: {type: string; [k: string]: unknown}[] = [];
  const runs: string[][] = [];
  const access: boolean[] = [];
  const manager = new DeviceManager({
    userData: dir, manifestDir: dir, env: {ANDROID_HOME: path.join(dir, 'sdk')}, home: dir, platform: 'darwin',
    exists: () => true, locate: name => `/bin/${name}`,
    run: async (file, args) => {
      runs.push([file, ...args]);
      if (args[0] === '-p') return '/Applications/Xcode.app/Contents/Developer';
      if (args[0] === 'xcodebuild') return 'Xcode 26.1';
      if (args[0] === '--version') return 'v24.0.0';
      if (args.join(' ') === 'simctl list devices --json') return JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{udid: 'BBBBBBBB-2222', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'iPhone-17-Pro'}]}});
      if (args[0] === 'simctl' && args[1] === 'boot') throw new Error('Unable to boot device: No space left on device');
      return '';
    },
    runBuffer: async () => Buffer.alloc(0), fetch: (async () => new Response('{}')) as typeof fetch, socket: () => { throw new Error('no sockets'); },
    emit: event => events.push(event as never), frame: () => {}, agentAccessChanged: enabled => access.push(enabled),
    ...overrides,
  });
  return {manager, dir, events, runs, access};
}

test('manager: off by default; agent access is a separate opt-in that never outlives devices; settings persist 0600', async () => {
  const {manager, dir, access} = managerFixture();
  const setup = await manager.setup();
  assert.equal(setup.enabled, false);assert.equal(setup.agentControl, false);assert.equal(setup.helper.state, 'absent');assert.equal(setup.helper.version, '0.15.3');
  assert.equal(setup.ios.available, true);
  await assert.rejects(manager.configure({agentControl: true}), /Turn devices on first/);
  await assert.rejects(manager.open('BBBBBBBB-2222'), /Devices are off/);
  await manager.configure({enabled: true});
  await assert.rejects(manager.open('BBBBBBBB-2222'), /helper is not installed/);
  await manager.configure({agentControl: true});
  assert.equal(manager.agentAccess, false, 'no tools until the helper is installed');
  const file = path.join(dir, 'devices.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {enabled: true, agentControl: true});
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await manager.configure({enabled: false});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {enabled: false, agentControl: false}, 'turning devices off also turns agent access off');
  assert.deepEqual(access, []);
  await assert.rejects(manager.configure({enabled: 'yes'}), /Choose whether devices are on/);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('manager: discovery lists devices; a failed boot says why in plain English and resets the state', async () => {
  const {manager, dir, events} = managerFixture();
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({enabled: true, agentControl: false}));
  const installed = helperPaths(path.join(dir, 'tools'));
  fs.mkdirSync(path.dirname(installed.entry), {recursive: true});fs.writeFileSync(installed.entry, '');fs.writeFileSync(installed.sentinel, '0.15.3\n');
  const {manager: ready} = managerFixture({userData: dir});
  const list = await ready.devices(true);
  assert.equal(list.devices.length, 1);assert.equal(list.devices[0]!.name, 'iPhone 17 Pro');
  await assert.rejects(ready.boot('BBBBBBBB-2222'), /disk is full/);
  assert.equal((await ready.devices()).devices[0]!.state, 'shutdown');
  await assert.rejects(ready.boot('../../etc'), /Invalid device id/);
  void manager; void events;
  fs.rmSync(dir, {recursive: true, force: true});
});

// --- Link ---------------------------------------------------------------------------------------------------------

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = ''; readyState = 0; sent: unknown[] = [];
  onopen: ((e: unknown) => void) | null = null; onmessage: ((e: {data: unknown}) => void) | null = null; onclose: ((e: {code: number; reason: string}) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) { FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(data: unknown) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({code: 1000, reason: ''}); }
}
const hub = async () => ({origin: 'http://127.0.0.1:5555', token: 'tok', pid: 1});

test('iOS link: attaches the helper with the bearer token, streams MJPEG only while viewed, flow-controlled', async () => {
  FakeSocket.all = [];
  const requests: {url: string; auth: string | null}[] = [];
  let push!: (chunk: Uint8Array) => void, end!: () => void;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    requests.push({url, auth: new Headers(init.headers).get('authorization')});
    if (url.endsWith('/grid/api/start')) return new Response('{"ok":true}');
    const body = new ReadableStream<Uint8Array>({start(controller) { push = chunk => controller.enqueue(chunk); end = () => controller.close(); init.signal?.addEventListener('abort', () => { try { controller.error(new Error('aborted')); } catch {} }); }});
    return new Response(body);
  }) as typeof fetch;
  const frames: Buffer[] = [], states: string[] = [];
  const link = new DeviceLink('ios', 'BBBBBBBB-2222', {hub, fetch: fetchFn, socket: (url, headers) => new FakeSocket(url, headers) as never, setTimeout, clearTimeout},
    {frame: f => frames.push(f.data), state: s => states.push(s), screen: () => {}, input: () => {}});
  await link.start();
  assert.match(requests[0]!.url, /\/vendor\/serve-sim\/grid\/api\/start$/);assert.equal(requests[0]!.auth, 'Bearer tok');
  const input = FakeSocket.all[0]!;
  assert.match(input.url, /^ws:\/\/127\.0\.0\.1:5555\/vendor\/serve-sim\/helper\/ws\?device=BBBBBBBB-2222$/);assert.equal(input.headers.authorization, 'Bearer tok');
  assert.ok(!input.url.includes('tok'), 'the token never travels in a URL');
  link.setViewing(true);await new Promise(r => setTimeout(r, 10));
  assert.ok(requests.some(r => r.url.endsWith('/helper/BBBBBBBB-2222/stream.mjpeg') && r.auth === 'Bearer tok'));
  push(Buffer.concat([part(jpeg(1)), part(jpeg(2)), part(jpeg(3)), part(jpeg(4))]));await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(frames.map(f => f[2]), [1, 2], 'two in flight, the rest held');
  assert.equal(states.at(-1), 'live');
  link.ack();assert.deepEqual(frames.map(f => f[2]), [1, 2, 4], 'the newest held frame replaces older ones');
  // Input: admitted only after the helper says so; touches carry normalized points.
  input.open();
  assert.equal(link.input({kind: 'touch', phase: 'begin', x: 0.5, y: 0.5}), false, 'not admitted yet');
  input.onmessage!({data: new Uint8Array([IOS_TAG.inputAdmitted]).buffer});
  assert.equal(link.input({kind: 'touch', phase: 'begin', x: 0.5, y: 0.25}), true);
  assert.deepEqual(JSON.parse(Buffer.from(input.sent.at(-1) as Uint8Array).subarray(1).toString()), {type: 'begin', x: 0.5, y: 0.25});
  assert.equal(link.input({kind: 'text', text: 'Hi!'}), true);assert.equal(link.input({kind: 'text', text: 'ü'}), false);
  assert.equal(link.button('home'), true);assert.equal(link.button('back'), false);
  link.setViewing(false);
  void end;
  link.close();
  assert.equal(input.readyState, 3);
});

test('Android link: H.264 forwarded in order, a backlog skips to the next keyframe and asks for one', async () => {
  FakeSocket.all = [];
  const frames: {key: boolean; reset?: boolean}[] = [];
  const link = new DeviceLink('android', 'emulator-5554', {hub, fetch: (async () => new Response('{}')) as typeof fetch, socket: (url, headers) => new FakeSocket(url, headers) as never, setTimeout, clearTimeout},
    {frame: f => frames.push({key: f.key, ...(f.reset ? {reset: true} : {})}), state: () => {}, screen: () => {}, input: () => {}});
  await link.start();
  assert.match(FakeSocket.all[0]!.url, /serve-emu\/ws\?device=emulator-5554&video=0$/, 'input-only socket while nothing is viewed');
  link.setViewing(true);await new Promise(r => setTimeout(r, 5));
  const video = FakeSocket.all[1]!;
  assert.match(video.url, /frame-meta=1/);
  const unit = (key: boolean) => { const h = Buffer.alloc(17); h.writeUInt32BE(SEMU_MAGIC, 0); h[4] = 1; h[5] = key ? 1 : 0; return new Uint8Array(h).buffer; };
  video.onmessage!({data: unit(true)});
  for (let i = 0; i < H264_BACKLOG + 5; i++) video.onmessage!({data: unit(false)});
  assert.equal(frames.length, H264_BACKLOG, 'stops forwarding once the renderer is a backlog behind');
  assert.deepEqual(JSON.parse(video.sent.at(-1) as string), {type: 'reset-video', ack: false});
  video.onmessage!({data: unit(false)});assert.equal(frames.length, H264_BACKLOG, 'deltas are dropped until a keyframe');
  video.onmessage!({data: unit(true)});assert.equal(frames.at(-1)!.key, true);
  video.onmessage!({data: '{"type":"video-session"}'});assert.equal(frames.at(-1)!.reset, true);
  assert.equal(FakeSocket.all[0]!.readyState, 3, 'the input-only socket gave way: serve-emu keeps one connection per device');
  video.open();
  assert.equal(link.input({kind: 'touch', phase: 'end', x: 0.1, y: 0.2}), true, 'input rides the video socket');
  assert.deepEqual(JSON.parse(video.sent.at(-1) as string), {type: 'touch', action: 'up', x: 0.1, y: 0.2});
  assert.equal(link.button('appSwitcher'), true);assert.deepEqual(JSON.parse(video.sent.at(-1) as string), {type: 'recents'});
  link.setViewing(false);await new Promise(r => setTimeout(r, 5));
  assert.equal(video.readyState, 3);assert.match(FakeSocket.all.at(-1)!.url, /video=0$/, 'not viewed: back to an input-only socket');
  link.close();
});

// --- Agent tools --------------------------------------------------------------------------------------------------

function toolTarget(overrides: Partial<DeviceToolTarget> = {}): DeviceToolTarget & {taps: number[][]; calls: string[][]} {
  const taps: number[][] = [], calls: string[][] = [];
  return {taps, calls, apps: async () => [{id: 'com.example.taskboard', name: 'Taskboard', user: true}, {id: 'com.android.settings', name: 'com.android.settings', user: false}],
    launchApp: async (id, app) => { calls.push(['launch', id, app]); }, button: async (id, button) => { calls.push(['button', id, button]); }, agentAccess: () => true, chat: async () => ({mode: 'agent', permissionMode: 'workspace'}),
    list: async () => [{id: 'emulator-5554', name: 'Pixel_9', platform: 'android', osVersion: 'Android 16', state: 'booted'}],
    session: () => ({deviceId: 'emulator-5554', name: 'Pixel 9', platform: 'android', formFactor: 'phone', chatId: 'c1', openedBy: 'agent', control: 'agent', state: 'live', inputReady: true, openedAt: 0}),
    open: async () => ({deviceId: 'emulator-5554', name: 'Pixel 9', platform: 'android', formFactor: 'phone', chatId: 'c1', openedBy: 'agent', control: 'agent', state: 'live', inputReady: true, openedAt: 0}),
    close: async () => {}, waitForInput: async () => true,
    screenshot: async () => { const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1080, 16); png.writeUInt32BE(2400, 20); return {png, width: 1080, height: 2400}; },
    tap: async (_id, x, y) => { taps.push([x, y]); return true; }, type: () => true, ...overrides};
}
const textOf = (result: {content: {type: string; text?: string}[]}) => result.content.filter(part => part.type === 'text').map(part => part.text).join(' ');

test('agent tools: consent re-checked per call, read-only chats look only, user control stops input, taps scaled from the screenshot', async () => {
  const off = await runDeviceTool(toolTarget({agentAccess: () => false}), 'c1', 'device_list', {});
  assert.equal(off.isError, true);assert.match(textOf(off), /not allowed agents to use devices/);
  assert.match(textOf(await runDeviceTool(toolTarget(), 'c1', 'device_list', {})), /emulator-5554 · Pixel_9 · Android 16 · booted · live session open/);
  const readOnly = toolTarget({chat: async () => ({mode: 'agent', permissionMode: 'read-only'})});
  assert.match(textOf(await runDeviceTool(readOnly, 'c1', 'device_tap', {device: 'emulator-5554', x: 1, y: 1})), /read-only/);
  assert.equal((await runDeviceTool(readOnly, 'c1', 'device_screenshot', {device: 'emulator-5554'})).isError, undefined, 'screenshots stay allowed');
  const target = toolTarget();
  const shot = await runDeviceTool(target, 'c1', 'device_screenshot', {device: 'emulator-5554'});
  assert.equal(shot.content[0]!.type, 'image', 'the screenshot is an image part (it shows in the transcript)');
  await runDeviceTool(target, 'c1', 'device_tap', {device: 'emulator-5554', x: 540, y: 600});
  assert.deepEqual(target.taps, [[0.5, 0.25]]);
  assert.match(textOf(await runDeviceTool(target, 'c1', 'device_tap', {device: 'emulator-5554', x: 5000, y: 1})), /inside the 1080×2400/);
  const userHasIt = toolTarget({session: () => ({...(toolTarget().session('x')!), control: 'user'})});
  assert.match(textOf(await runDeviceTool(userHasIt, 'c1', 'device_type', {device: 'emulator-5554', text: 'hi'})), /taken control/);
  const foreign = toolTarget({session: () => ({...(toolTarget().session('x')!), chatId: 'other'})});
  assert.match(textOf(await runDeviceTool(foreign, 'c1', 'device_open', {device: 'emulator-5554'})), /Another chat/);
  assert.match(textOf(await runDeviceTool(foreign, 'c1', 'device_close', {device: 'emulator-5554'})), /leave it open/);
  assert.match(textOf(await runDeviceTool(toolTarget({session: () => undefined}), 'c1', 'device_tap', {device: 'emulator-5554', x: 1, y: 1})), /device_open/);
  assert.match(textOf(await runDeviceTool(target, 'c1', 'device_open', {device: '-rf'})), /device id/);
});

test('agent tools: list apps, launch one, press buttons; each needs this chat\'s open session and stops under user control', async () => {
  const target = toolTarget();
  assert.match(textOf(await runDeviceTool(target, 'c1', 'device_apps', {device: 'emulator-5554'})), /com\.example\.taskboard · Taskboard\ncom\.android\.settings · com\.android\.settings · system/);
  assert.match(textOf(await runDeviceTool(target, 'c1', 'device_launch_app', {device: 'emulator-5554', app: 'com.example.taskboard'})), /Launched com\.example\.taskboard/);
  assert.match(textOf(await runDeviceTool(target, 'c1', 'device_button', {device: 'emulator-5554', button: 'app_switcher'})), /Pressed app_switcher/);
  assert.deepEqual(target.calls, [['launch', 'emulator-5554', 'com.example.taskboard'], ['button', 'emulator-5554', 'appSwitcher']]);
  for (const app of ['-n evil', '../x', '', 'a b']) assert.equal((await runDeviceTool(target, 'c1', 'device_launch_app', {device: 'emulator-5554', app})).isError, true, `refuses ${JSON.stringify(app)}`);
  assert.equal((await runDeviceTool(target, 'c1', 'device_button', {device: 'emulator-5554', button: 'power'})).isError, true, 'only home, back and app switcher');
  const ios = toolTarget({session: () => ({...(toolTarget().session('x')!), platform: 'ios'})});
  assert.match(textOf(await runDeviceTool(ios, 'c1', 'device_button', {device: 'emulator-5554', button: 'back'})), /no Back button/);
  const userHasIt = toolTarget({session: () => ({...(toolTarget().session('x')!), control: 'user'})});
  assert.match(textOf(await runDeviceTool(userHasIt, 'c1', 'device_launch_app', {device: 'emulator-5554', app: 'com.example.taskboard'})), /taken control/);
  assert.deepEqual(userHasIt.calls, []);
  const readOnly = toolTarget({chat: async () => ({mode: 'agent', permissionMode: 'read-only'})});
  assert.match(textOf(await runDeviceTool(readOnly, 'c1', 'device_launch_app', {device: 'emulator-5554', app: 'com.example.taskboard'})), /read-only/);
  assert.equal((await runDeviceTool(readOnly, 'c1', 'device_apps', {device: 'emulator-5554'})).isError, undefined, 'listing apps is read-only');
  assert.match(textOf(await runDeviceTool(toolTarget({session: () => undefined}), 'c1', 'device_button', {device: 'emulator-5554', button: 'home'})), /device_open/);
  const failing = toolTarget({launchApp: async () => { throw new Error('com.x is not installed on Pixel 9. Use device_apps to see what is.'); }});
  const failed = await runDeviceTool(failing, 'c1', 'device_launch_app', {device: 'emulator-5554', app: 'com.x'});
  assert.equal(failed.isError, true);assert.match(textOf(failed), /not installed/);
});

test('installed apps: simctl listapps and pm list parsed, user apps first; launch runs fixed argv only', async () => {
  const listapps = `{
    "com.apple.Preferences" =     {
        ApplicationType = System;
        CFBundleDisplayName = Settings;
        CFBundleIdentifier = "com.apple.Preferences";
    };
    "dev.muster.taskboard" =     {
        ApplicationType = User;
        CFBundleDisplayName = "Task Board";
        CFBundleIdentifier = "dev.muster.taskboard";
        CFBundleName = taskboard;
    };
    "com.apple.mobilesafari" =     {
        ApplicationType = System;
        CFBundleName = Safari;
        CFBundleIdentifier = "com.apple.mobilesafari";
    };
}`;
  assert.deepEqual(parseSimctlApps(listapps), [{id: 'dev.muster.taskboard', name: 'Task Board', user: true}, {id: 'com.apple.mobilesafari', name: 'Safari', user: false}, {id: 'com.apple.Preferences', name: 'Settings', user: false}]);
  assert.deepEqual(parseSimctlApps('garbage'), []);
  assert.deepEqual(parseAdbPackages('package:com.example.app\r\npackage:-x\nnoise\npackage:org.foo\n', true).map(app => app.id), ['com.example.app', 'org.foo']);

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({enabled: true}));
  const installed = helperPaths(path.join(dir, 'tools'));
  fs.mkdirSync(path.dirname(installed.entry), {recursive: true});fs.writeFileSync(installed.entry, '');fs.writeFileSync(installed.sentinel, '0.15.3\n');
  const runs: string[][] = [];
  let slowTried = false;
  const {manager} = managerFixture({userData: dir, run: async (file, args) => {
    runs.push([path.basename(file), ...args]);
    if (args[0] === '-p') return '/Applications/Xcode.app/Contents/Developer';
    if (args.join(' ') === 'simctl list devices --json') return JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{udid: 'BBBBBBBB-2222', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'iPhone-17-Pro'}]}});
    if (args[0] === 'simctl' && args[1] === 'listapps') return listapps;
    if (args[0] === 'simctl' && args[1] === 'launch' && args[3] === 'com.missing') throw new Error('An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4)');
    if (args[0] === 'simctl' && args[1] === 'launch' && args[3] === 'com.slow' && !slowTried) { slowTried = true; throw new Error('Command failed: /usr/bin/xcrun simctl launch BBBBBBBB-2222 com.slow'); }
    if (args.includes('monkey')) return args.includes('com.none') ? '** No activities found to run, monkey aborted.' : 'Events injected: 1';
    return '';
  }});
  assert.deepEqual((await manager.apps('BBBBBBBB-2222')).map(app => app.id), ['dev.muster.taskboard', 'com.apple.mobilesafari', 'com.apple.Preferences']);
  await assert.rejects(manager.launchApp('BBBBBBBB-2222', 'dev.muster.taskboard'), /Open the device first/);
  const live = (platform: 'ios' | 'android', id: string) => (manager as unknown as {live: Map<string, unknown>}).live.set(id, {viewers: new Set(), link: {close() {}}, session: {deviceId: id, name: 'Device', platform, formFactor: 'phone', openedBy: 'agent', chatId: 'c1', control: 'agent', state: 'live', inputReady: true, openedAt: 0}});
  live('ios', 'BBBBBBBB-2222');
  await manager.launchApp('BBBBBBBB-2222', 'dev.muster.taskboard', 'agent');
  assert.deepEqual(runs.at(-1), ['xcrun', 'simctl', 'launch', 'BBBBBBBB-2222', 'dev.muster.taskboard']);
  await assert.rejects(manager.launchApp('BBBBBBBB-2222', 'com.missing', 'agent'), /not installed on Device/);
  await manager.launchApp('BBBBBBBB-2222', 'com.slow', 'agent');
  assert.equal(runs.filter(run => run.includes('com.slow')).length, 2, 'a launch that timed out after a cold boot is tried once more');
  await assert.rejects(manager.launchApp('BBBBBBBB-2222', '--console', 'agent'), /bundle id/);
  live('android', 'emulator-5554');
  await manager.launchApp('emulator-5554', 'com.example.app', 'agent');
  assert.deepEqual(runs.at(-1), ['adb', '-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example.app', '-c', 'android.intent.category.LAUNCHER', '1']);
  await assert.rejects(manager.launchApp('emulator-5554', 'com.none', 'agent'), /no launcher screen/);
  manager.control('emulator-5554', 'user');
  await assert.rejects(manager.launchApp('emulator-5554', 'com.example.app', 'agent'), /taken control/);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('routes without MCP never hear about the device tools; MCP routes get the server and the note', () => {
  const overrides = {[`mcp_servers.${DEVICE_MCP}.command`]: '/tmp/launcher', [`mcp_servers.${DEVICE_MCP}.env.MUSTER_CHAT_ID`]: 'c1'};
  const claude = adapterBrowser('claude-code-cli', 'agent', `Intro.\n\n${DEVICE_NOTE}`, overrides);
  assert.ok(claude.mcpServers?.[DEVICE_MCP]);assert.ok(claude.instructions?.includes(DEVICE_NOTE));
  for (const driver of ['openai-chat-completions', 'gemini-cli']) {
    const http = adapterBrowser(driver, 'agent', `Intro.\n\n${DEVICE_NOTE}`, overrides);
    assert.equal(http.mcpServers?.[DEVICE_MCP], undefined, driver);
    assert.ok(!http.instructions?.includes('muster_device'), `${driver} gets no device note`);
    assert.ok(http.instructions?.includes('Intro.'));
  }
});

test('agent tool host: bearer token required, launcher written 0700 and endpoint 0600, run options add the server only when allowed', async () => {
  const dir = tmp();
  const host = new DeviceToolHost({dir, execPath: process.execPath, target: toolTarget()});
  const launcher = await host.start();
  const endpoint = JSON.parse(fs.readFileSync(path.join(dir, 'device-endpoint.json'), 'utf8'));
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(dir, 'device-endpoint.json')).mode & 0o777, 0o600); assert.equal(fs.statSync(launcher).mode & 0o777, 0o700); }
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/call$/);
  const denied = await fetch(endpoint.url, {method: 'POST', body: '{}'});
  assert.equal(denied.status, 403);
  const ok = await fetch(endpoint.url, {method: 'POST', headers: {authorization: `Bearer ${endpoint.token}`}, body: JSON.stringify({chatId: 'c1', tool: 'device_list', arguments: {}})});
  assert.match(JSON.stringify(await ok.json()), /Pixel_9/);
  const unknown = await host.call('c1', 'device_shell', {});assert.equal(unknown.isError, true);
  const on = computerRunOptions({id: 'c1', mode: 'agent'}, undefined, launcher)!;
  assert.equal(on.configOverrides?.['mcp_servers.muster_device.command'], launcher);assert.equal(on.configOverrides?.['mcp_servers.muster_device.env.MUSTER_CHAT_ID'], 'c1');assert.match(on.developerInstructions, /device_open/);
  const off = computerRunOptions({id: 'c1', mode: 'agent'}, undefined, undefined)!;
  assert.ok(!off.developerInstructions.includes('muster_device'));assert.equal(off.configOverrides, undefined);
  host.dispose();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('3D bodies: built from each frame spec with one live screen (0..1 UVs, long side at the standard height), the cut-out and the spec\'s buttons', async () => {
  const {buildBody, SCREEN_NAME, SCREEN_HEIGHT} = await import('../src/renderer/devices/bodies.ts');
  const {FRAME_SPECS} = await import('../src/shared/device-frames.ts');
  const {Color} = await import('three');
  const colors = {body: new Color(0.2, 0.2, 0.2), trim: new Color(0.1, 0.1, 0.1), lens: new Color(0, 0, 0), screenOff: new Color(0, 0, 0)};
  for (const spec of Object.values(FRAME_SPECS)) {
    const body = buildBody(spec, undefined, colors);
    const screens: any[] = [], cutouts: any[] = [], buttons: string[] = [];
    body.traverse((node: any) => { if (node.name === SCREEN_NAME) screens.push(node); if (node.name === 'muster-cutout') cutouts.push(node); if (node.name.startsWith('muster-button-')) buttons.push(node.name.slice(14)); });
    assert.equal(screens.length, 1, spec.id);
    const geometry = screens[0].geometry; geometry.computeBoundingBox();
    const size = geometry.boundingBox.max.clone().sub(geometry.boundingBox.min);
    assert.ok(Math.abs(Math.max(size.x, size.y) - SCREEN_HEIGHT) < 1e-3, `${spec.id} screen long side`);
    assert.ok(Math.abs(size.x / size.y - spec.screen.width / spec.screen.height) < 1e-2, `${spec.id} screen aspect`);
    const uv = geometry.attributes.uv;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < uv.count; i++) { min = Math.min(min, uv.getX(i), uv.getY(i)); max = Math.max(max, uv.getX(i), uv.getY(i)); }
    assert.ok(min >= -1e-6 && max <= 1 + 1e-6 && max > 0.99, `${spec.id} UVs span 0..1`);
    assert.equal(cutouts.length, spec.cutout.kind === 'none' ? 0 : 1, `${spec.id} cut-out`);
    assert.deepEqual(buttons.sort(), spec.buttons.map(b => b.kind).sort(), `${spec.id} buttons`);
  }
});

test('3D screen orientation: a landscape picture turns the screen UVs a quarter so hits still name the picture pixel', async () => {
  const {orientScreen} = await import('../src/renderer/components/devices/orientScreen.ts');
  const {Mesh, PlaneGeometry} = await import('three');
  const mesh = new Mesh(new PlaneGeometry(1, 2));
  const before = Array.from(mesh.geometry.attributes.uv!.array as ArrayLike<number>);
  orientScreen(mesh, true);
  const turned = Array.from(mesh.geometry.attributes.uv!.array as ArrayLike<number>);
  for (let i = 0; i < before.length; i += 2) { assert.equal(turned[i], 1 - before[i + 1]!); assert.equal(turned[i + 1], before[i]); }
  orientScreen(mesh, false);
  assert.deepEqual(Array.from(mesh.geometry.attributes.uv!.array as ArrayLike<number>), before, 'portrait restores the original UVs');
});

test('frame specs: iOS from the simctl device type, Android from the AVD config; unknown devices get their own OS\'s generic frame', async () => {
  const {iosFrame, androidFrame, parseIni, parseCutout, frameForPicture, frameLayout} = await import('../src/shared/device-frames.ts');
  const ios = (type: string, name = type.replace(/-/g, ' ')) => iosFrame(`com.apple.CoreSimulator.SimDeviceType.${type}`, name).id;
  assert.equal(ios('iPhone-17-Pro'), 'iphone-island');assert.equal(ios('iPhone-15'), 'iphone-island');assert.equal(ios('iPhone-14-Pro'), 'iphone-island');assert.equal(ios('iPhone-Air'), 'iphone-island');
  assert.equal(ios('iPhone-16e'), 'iphone-notch');assert.equal(ios('iPhone-14'), 'iphone-notch');assert.equal(ios('iPhone-11'), 'iphone-notch');
  assert.equal(ios('iPhone-SE-3rd-generation', 'iPhone SE (3rd generation)'), 'iphone-home');assert.equal(ios('iPhone-8'), 'iphone-home');
  assert.equal(ios('iPad-Pro-13-inch-M5', 'iPad Pro 13-inch (M5)'), 'ipad');assert.equal(ios('iPad-10th-generation', 'iPad (10th generation)'), 'ipad');
  assert.equal(ios('iPad-9th-generation', 'iPad (9th generation)'), 'ipad-home');assert.equal(ios('iPad-mini-A17-Pro', 'iPad mini (A17 Pro)'), 'ipad-mini');
  assert.equal(iosFrame(undefined, 'Some Future Phone').os, 'ios', 'an unknown iOS device stays an iOS frame');
  assert.ok(iosFrame(undefined, 'iPhone 17 Pro').buttons.some(b => b.kind === 'camera' && b.edge === 'right'), 'iPhone 16 and later: Camera Control on the right');
  const island = iosFrame(undefined, 'iPhone 17 Pro');
  assert.deepEqual(island.buttons.filter(b => b.edge === 'left').map(b => b.kind), ['action', 'volume', 'volume']);assert.deepEqual(island.buttons.filter(b => b.edge === 'right').map(b => b.kind), ['power', 'camera']);

  const avd = (text: string, name = 'Device') => androidFrame(parseIni(text), name);
  assert.equal(avd('hw.device.name=pixel_9\nhw.lcd.width=1080\nhw.lcd.height=2424').id, 'pixel-pill');
  assert.equal(avd('hw.device.name=pixel_8').id, 'pixel');assert.equal(avd('hw.device.name=pixel_7_pro').id, 'pixel-curved');assert.equal(avd('hw.device.name=pixel_5').id, 'pixel-side-punch');
  assert.equal(avd('hw.device.name=pixel_4').id, 'pixel-bezel');assert.equal(avd('hw.device.name=pixel_3_xl').id, 'pixel-notch');assert.equal(avd('hw.device.name=pixel_2').id, 'android-classic-phone');
  const fold = avd('hw.device.name=pixel_9_pro_fold\nhw.sensor.hinge=yes');
  assert.equal(fold.id, 'pixel-fold');assert.equal(frameForPicture(fold, {width: 2076, height: 2152}).id, 'pixel-fold', 'open: the inner display');
  assert.equal(frameForPicture(fold, {width: 1080, height: 2092}).id, 'pixel-fold-folded', 'folded: the outer display');
  assert.equal(avd('hw.device.name=pixel_tablet').id, 'pixel-tablet');
  assert.equal(avd('hw.device.name=SM-S921B\nhw.device.manufacturer=Samsung').id, 'android-centre-punch');
  assert.equal(avd('hw.device.name=wearos_large_round\ntag.id=android-wear').id, 'wear-round');assert.equal(avd('hw.device.name=wearos_square\ntag.id=android-wear').id, 'wear-square');
  assert.equal(avd('hw.device.name=tv_1080p\ntag.id=google-tv').id, 'android-tv');assert.equal(avd('hw.device.name=automotive_1024p_landscape\ntag.id=android-automotive').id, 'android-automotive');
  assert.equal(avd('hw.device.name=small_phone').id, 'android-small-phone');
  const unknown = avd('hw.device.name=acme_x1\nhw.lcd.width=1200\nhw.lcd.height=2640\nhw.lcd.density=480');
  assert.equal(unknown.os, 'android');assert.equal(unknown.id, 'android-generic-phone');assert.deepEqual(unknown.screen, {width: 1200, height: 2640}, 'its own screen size');
  assert.equal(avd('hw.device.name=acme_tab\nhw.lcd.width=1600\nhw.lcd.height=2560\nhw.lcd.density=320').id, 'android-generic-tablet');
  assert.equal(androidFrame({}, 'Pixel_9_API_36').id, 'pixel-pill', 'the AVD name is the fallback');
  // The cut-out Android reports for a generic device.
  const dumpsys = 'mDisplayCutout=DisplayCutout{insets=Rect(0, 136 - 0, 0) waterfall=Insets{left=0, top=0, right=0, bottom=0} boundingRect={Bounds=[Rect(0, 0 - 0, 0), Rect(498, 0 - 582, 136), Rect(0, 0 - 0, 0), Rect(0, 0 - 0, 0)]} cutoutPathParserInfo={}}';
  const cutout = parseCutout(dumpsys, 1080)!;
  assert.equal(cutout.kind, 'punch-center');assert.ok(Math.abs(cutout.x - 0.5) < 0.01);
  assert.equal(androidFrame(parseIni('hw.device.name=acme_x1'), 'acme', cutout).cutout.kind, 'punch-center');
  assert.equal(parseCutout('no cutout here', 1080), undefined);
  assert.equal(parseCutout('DisplayCutout{insets=Rect(0, 0 - 0, 0) boundingRect={Bounds=[Rect(0, 0 - 0, 0), Rect(0, 0 - 0, 0), Rect(0, 0 - 0, 0), Rect(0, 0 - 0, 0)]}}', 1080)!.kind, 'none');
  // Layout: a landscape picture turns a portrait device once; the island moves to the left edge.
  const upright = frameLayout(island, {width: 1206, height: 2622}), turned = frameLayout(island, {width: 2622, height: 1206}, 1);
  assert.ok(upright.width < upright.height && turned.width > turned.height);
  assert.ok(Math.abs(turned.glass.w / turned.glass.h - 2622 / 1206) < 1e-6, 'the screen keeps the picture\'s proportions');
  assert.equal(turned.buttons.find(b => b.kind === 'power')!.edge, 'top', 'the right edge is on top after a counter-clockwise turn');
});

test('AVD config is read from the AVD folder (config.ini overlaid by hardware-qemu.ini); discovery attaches the derived frame', async () => {
  const dir = tmp(), avdDir = path.join(dir, 'avd');
  fs.mkdirSync(path.join(avdDir, 'Fold.avd'), {recursive: true});
  fs.writeFileSync(path.join(avdDir, 'Fold.ini'), `path=${path.join(avdDir, 'Fold.avd')}\n`);
  fs.writeFileSync(path.join(avdDir, 'Fold.avd', 'config.ini'), 'hw.device.name=pixel_9_pro_fold\nhw.lcd.width=2076\n');
  fs.writeFileSync(path.join(avdDir, 'Fold.avd', 'hardware-qemu.ini'), 'hw.lcd.width=2152\n');
  const {readAvdConfig, listAndroid, listIos} = await import('../src/main/devices/discovery.ts');
  const deps = {env: {ANDROID_AVD_HOME: avdDir}, home: dir, readText: (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }};
  assert.deepEqual(readAvdConfig(deps, 'Fold'), {'hw.device.name': 'pixel_9_pro_fold', 'hw.lcd.width': '2152'});
  assert.deepEqual(readAvdConfig(deps, '../etc'), {}, 'names that are not plain identifiers read nothing');
  const run = async (_file: string, args: string[]) => args[0] === '-list-avds' ? 'Fold\n' : args.join(' ') === 'simctl list devices --json' ? JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{udid: 'BBBBBBBB-2222', name: 'iPhone SE (3rd generation)', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation'}]}}) : '';
  const [android] = await listAndroid({...deps, run, exists: () => true, platform: 'darwin'});
  assert.equal(android!.frame!.id, 'pixel-fold');assert.equal(android!.formFactor, 'foldable');
  const [phone] = await listIos({...deps, run, exists: () => true, platform: 'darwin'});
  assert.equal(phone!.frame!.id, 'iphone-home');
  fs.rmSync(dir, {recursive: true, force: true});
});
