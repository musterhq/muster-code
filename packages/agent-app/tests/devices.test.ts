/** Devices (#363): discovery parsers, wire formats, flow control, the helper install and lifetime, the manager's
 *  consent and lifecycle rules, the live link, and the agent tools' safety checks. No simulator or helper is needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {androidFormFactor, androidSdkRoot, checkAndroid, checkIos, checkNode, parseAdbDevices, parseAvdList, parseSimctlDevices, listAndroid, type ProbeDeps} from '../src/main/devices/discovery.ts';
import {FrameGate, hasIdr, iosPacket, IOS_TAG, MjpegParser, semuInfo, SEMU_MAGIC} from '../src/main/devices/frames.ts';
import {hidForChar, hidUsageForCode, androidKeycode} from '../src/main/devices/keys.ts';
import {deviceButton, deviceId, parseDeviceInput, DEVICE_COMMANDS} from '../src/shared/device-protocol.ts';
import {helperInstalled, helperPaths, hubArgs, hubEnv, installHelper, npmError, parseHubBanner} from '../src/main/devices/helper.ts';
import {DeviceManager} from '../src/main/devices/manager.ts';
import {DeviceLink, rawPoint, H264_BACKLOG} from '../src/main/devices/link.ts';
import {DeviceToolHost, runDeviceTool, type DeviceToolTarget} from '../src/main/devices/agent-tools.ts';
import {computerRunOptions} from '../src/runtime/domains/computer.ts';
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
  const env = hubEnv({PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', EXPO_DEVICE_HUB_SESSION_TOKEN: 'x'}, dir, '/sdk');
  assert.equal(env.TMPDIR, path.join(dir, 'tmp'));assert.equal(env.ANDROID_HOME, '/sdk');
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'EXPO_DEVICE_HUB_SESSION_TOKEN']) assert.equal(env[key], undefined, key);
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
  await assert.rejects(installHelper({paths, manifestDir: manifest, npm: {command: '/npm', args: []}, env: {}, spawn: fakeChild(1)}), /disk space/);
  assert.equal(helperInstalled(paths), false);assert.ok(!fs.existsSync(paths.installDir));
  assert.deepEqual(fs.readdirSync(path.dirname(paths.installDir)).filter(n => n.startsWith('.staging')), [], 'staging removed');
  await installHelper({paths, manifestDir: manifest, npm: {command: '/node', args: ['/npm-cli.js']}, env: {}, spawn: (command, args, options) => {
    seen.push([command, ...args]);
    return fakeChild(0, cwd => { const entry = path.join(cwd, 'node_modules', 'expo-device-hub', 'dist', 'server'); fs.mkdirSync(entry, {recursive: true}); fs.writeFileSync(path.join(entry, 'cli.mjs'), ''); assert.ok(fs.existsSync(path.join(cwd, 'package-lock.json'))); })(command, args, options);
  }});
  assert.deepEqual(seen[0]!.slice(0, 3), ['/node', '/npm-cli.js', 'ci']);assert.ok(seen[0]!.includes('--ignore-scripts'));
  assert.equal(helperInstalled(paths), true);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {enabled: true, agentControl: true, appleModels: false});
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await manager.configure({enabled: false});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {enabled: false, agentControl: false, appleModels: false}, 'turning devices off also turns agent access off');
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

function toolTarget(overrides: Partial<DeviceToolTarget> = {}): DeviceToolTarget & {taps: number[][]} {
  const taps: number[][] = [];
  return {taps, agentAccess: () => true, chat: async () => ({mode: 'agent', permissionMode: 'workspace'}),
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

test('Apple models: opt-in only, https from apple.com, checksum verified, converted GLB cached, cleared when turned off', async () => {
  const {AppleModels, sha256} = await import('../src/main/devices/models.ts');
  const dir = tmp();
  const good = Buffer.from('fake usdz bytes');
  const source = {id: 'iphone' as const, label: 'iPhone', url: 'https://www.apple.com/x.usdz', sha256: sha256(good), bodyNode: 'B', screenNode: 'S'};
  let body = good, fetched = 0;
  const models = new AppleModels(dir, (async (url: string) => { fetched++; assert.equal(url, source.url); return new Response(body); }) as typeof fetch, () => {}, [source]);
  assert.equal(models.status()[0]!.state, 'absent');
  const first = await models.get('iphone');
  assert.deepEqual(Buffer.from(first.usdz!), good);assert.equal(first.glb, undefined);assert.equal(first.bodyNode, 'B');
  await models.get('iphone');assert.equal(fetched, 1, 'a verified download is reused');
  assert.throws(() => models.store('iphone', new Uint8Array([1, 2, 3])), /Invalid converted model/);
  const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(32)]);
  models.store('iphone', new Uint8Array(glb));
  assert.equal(models.status()[0]!.state, 'converted');assert.deepEqual(Buffer.from((await models.get('iphone')).glb!), glb);
  models.clear();assert.equal(models.status()[0]!.state, 'absent');assert.ok(!fs.existsSync(path.join(dir, 'device-models')));
  body = Buffer.from('tampered');
  await assert.rejects(models.get('iphone'), /checksum mismatch/);assert.equal(models.status()[0]!.state, 'failed');
  const evil = new AppleModels(dir, (async () => new Response(good)) as typeof fetch, () => {}, [{...source, url: 'https://evil.example/x.usdz'}]);
  await assert.rejects(evil.get('iphone'), /only downloaded from apple.com/);
  await assert.rejects(models.get('android'), /Unknown device model/);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('3D bodies: Muster-made phone, tablet and foldable each carry one live screen with 0..1 UVs at the standard height', async () => {
  const {buildBody, SCREEN_NAME, SCREEN_HEIGHT} = await import('../src/renderer/devices/bodies.ts');
  const {Color} = await import('three');
  const colors = {body: new Color(0.2, 0.2, 0.2), trim: new Color(0.1, 0.1, 0.1), lens: new Color(0, 0, 0), screenOff: new Color(0, 0, 0)};
  for (const [form, aspect] of [['phone', 0.46], ['tablet', 0.75], ['foldable', 0.9]] as const) {
    const body = buildBody(form, aspect, colors);
    const screens: any[] = [];
    body.traverse((node: any) => { if (node.name === SCREEN_NAME) screens.push(node); });
    assert.equal(screens.length, 1, form);
    const geometry = screens[0].geometry; geometry.computeBoundingBox();
    const size = geometry.boundingBox.max.clone().sub(geometry.boundingBox.min);
    assert.ok(Math.abs(size.y - SCREEN_HEIGHT) < 1e-6, `${form} screen height`);
    assert.ok(Math.abs(size.x / size.y - aspect) < 1e-6, `${form} screen aspect`);
    const uv = geometry.attributes.uv;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < uv.count; i++) { min = Math.min(min, uv.getX(i), uv.getY(i)); max = Math.max(max, uv.getX(i), uv.getY(i)); }
    assert.ok(min >= -1e-6 && max <= 1 + 1e-6 && max > 0.99, `${form} UVs span 0..1`);
  }
});

test('Apple conversion geometry: the display frame comes from its triangles, not an axis-aligned box', async () => {
  const {displayFrame} = await import('../src/renderer/devices/appleModels.ts');
  const {Vector3, Matrix4, PlaneGeometry} = await import('three');
  // A 1×2 display tilted 30° about X and moved: the frame must recover its normal, its long side and its height.
  const plane = new PlaneGeometry(1, 2, 4, 8).applyMatrix4(new Matrix4().makeRotationX(Math.PI / 6)).translate(3, 1, -2);
  const frame = displayFrame(plane.attributes.position as any, plane.index ? plane.index.array : null);
  assert.ok(Math.abs(Math.abs(frame.normal.dot(new Vector3(0, 0, 1).applyMatrix4(new Matrix4().makeRotationX(Math.PI / 6)))) - 1) < 1e-3, 'normal');
  assert.ok(Math.abs(frame.height - 2) < 1e-6, 'height along the long side');
  assert.ok(frame.center.distanceTo(new Vector3(3, 1, -2)) < 1e-6, 'centre');
  assert.ok(frame.up.y > 0, 'not upside down');
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
