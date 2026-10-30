/** Devices #809: agents drive the screen by its accessibility tree (element refs and labels, coordinates as the
 *  fallback), and typed device settings with read-back. The workflows run the real DeviceManager, link and agent tools
 *  against a fake helper on loopback that serves real-shaped iOS and Android trees (tests/fixtures/devices-ax). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeviceManager} from '../src/main/devices/manager.ts';
import {helperPaths} from '../src/main/devices/helper.ts';
import {runDeviceTool, DEVICE_TOOL_SPECS} from '../src/main/devices/agent-tools.ts';
import {managerToolTarget} from '../src/main/devices/index.ts';
import {findByLabel, formatAx, parseAndroidAx, parseIosAx, AX_ELEMENT_LIMIT} from '../src/main/devices/ax.ts';
import {androidShellWord, readDeviceSettings, runDeviceAction, type ActionHost} from '../src/main/devices/actions.ts';
import {DEVICE_COMMANDS, DEVICE_NOTE, deviceActionUnsupported, parseDeviceAction, type DeviceAction} from '../src/shared/device-protocol.ts';
import {androidDump, androidSnapshot, FakeDeviceHub, iosTree, TaskboardApp} from './fixtures/devices-ax/fake-device-hub.ts';

const UDID = 'A1B2C3D4-1111-2222-3333-444455556666';
const SERIAL = 'emulator-5554';
const textOf = (result: {content: {type: string; text?: string}[]}) => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const refFor = (snapshot: string, pattern: RegExp) => { const ref = new RegExp(`^(e\\d+) ${pattern.source}`, 'm').exec(snapshot)?.[1]; assert.ok(ref, `no element ${pattern} in:\n${snapshot}`); return ref!; };

/** A DeviceManager wired to the fake hub: devices and agent access on, the helper "installed", one booted iPhone and
 *  one running emulator. Settings commands answer from a small in-memory device. */
function rig(hub: FakeDeviceHub, settingsLog: string[][] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-809-'));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({enabled: true, agentControl: true}));
  const installed = helperPaths(path.join(dir, 'tools'));
  fs.mkdirSync(path.dirname(installed.entry), {recursive: true}); fs.writeFileSync(installed.entry, ''); fs.writeFileSync(installed.sentinel, '0.15.3\n');
  const sim = {appearance: 'light', content_size: 'large', increase_contrast: 'disabled'} as Record<string, string>;
  const manager = new DeviceManager({
    userData: dir, manifestDir: dir, env: {ANDROID_HOME: path.join(dir, 'sdk')}, home: dir, platform: 'darwin', exists: () => true, locate: name => `/bin/${name}`,
    run: async (file, args) => {
      const line = args.join(' ');
      if (args[0] === '-p') return '/Applications/Xcode.app/Contents/Developer';
      if (args[0] === 'xcodebuild') return 'Xcode 26.1';
      if (args[0] === '--version') return 'v24.0.0';
      if (line === 'simctl list devices --json') return JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{udid: UDID, name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'}]}});
      if (file.endsWith('adb') && line === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`;
      if (file.endsWith('emulator')) return 'Pixel_9\n';
      if (line.endsWith('emu avd name')) return 'Pixel_9\nOK\n';
      if (line.includes('ro.build.version.release')) return '16\n';
      if (line.includes('sys.boot_completed')) return '1\n';
      const ui = /^simctl ui \S+ (appearance|content_size|increase_contrast)(?: (\S+))?$/.exec(line);
      if (ui) { settingsLog.push([file, ...args]); if (ui[2]) { sim[ui[1]!] = ui[2]; return ''; } return `${sim[ui[1]!]}\n`; }
      if (line.includes('serve-sim-ax-settings')) { settingsLog.push([file, ...args]); return line.endsWith('status') ? '{"reduce-motion":"off","voiceover":"off"}' : ''; }
      if (/^-s emulator-5554 (shell|emu)/.test(line) || line.startsWith('simctl')) settingsLog.push([file, ...args]);
      return '';
    },
    runBuffer: async () => Buffer.alloc(0), fetch: (...args) => fetch(...args), socket: hub.socket,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: () => true});
      setTimeout(() => child.stdout.emit('data', hub.banner), 5);
      return child as never;
    },
    emit: () => {}, frame: () => {},
  });
  const chat = {mode: 'agent', permissionMode: 'workspace'};
  const target = managerToolTarget(manager, async () => chat);
  return {manager, target, chat, dir, sim, done: async () => { await manager.dispose(); fs.rmSync(dir, {recursive: true, force: true}); }};
}

for (const [platform, device] of [['iOS', UDID], ['Android', SERIAL]] as const) {
  // Spec: MUS-SPEC-21-809A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809a)
  test(`${platform}: an agent signs in by element ref and label from the accessibility tree, without a screenshot`, async () => {
    const hub = new FakeDeviceHub(); await hub.start();
    const {target, done} = rig(hub);
    try {
      const call = (tool: string, args: Record<string, unknown>) => runDeviceTool(target, 'c1', tool, {device, ...args});
      assert.match(textOf(await call('device_open', {})), /Opened/);
      const first = await call('device_snapshot', {});
      assert.equal(first.isError, undefined, textOf(first));
      const listing = textOf(first);
      // Find "Sign in": a button, not the heading that contains the words.
      assert.match(listing, /^e\d+ button "Sign in" \[\d+,\d+ \d+×\d+\]$/m);
      assert.match(listing, /^e\d+ (heading|text) "Sign in to Taskboard"/m);
      assert.ok(!/application|window|linearlayout|framelayout/i.test(listing), 'layout containers and the full-screen root are left out');
      const email = refFor(listing, /textfield "(?:Email|email)"/);
      // Type into the Email field by its ref, then into Password by its label, then tap Sign in by its label.
      assert.match(textOf(await call('device_type_into', {ref: email, text: 'ada@example.com'})), /Typed 15 characters into e\d+ textfield/);
      const password = await call('device_type_into', {label: 'Password', text: 'hunter2'});
      assert.equal(password.isError, undefined, textOf(password));
      assert.match(textOf(password), /(securefield|textfield) "(Password|password)"/, 'the label resolves to the field, not its caption');
      const tap = await call('device_tap_element', {label: 'Sign in'});
      assert.equal(tap.isError, undefined, textOf(tap));
      assert.match(textOf(tap), /Tapped e\d+ button "Sign in"/);
      const app = hub.app(device);
      assert.equal(app.screen, 'home');assert.equal(app.email, 'ada@example.com');assert.equal(app.password, 'hunter2');
      // Every tap landed inside its element (the centre of the field and button boxes).
      assert.deepEqual(app.taps.map(t => [Math.round(t.x * 100) / 100, Math.round(t.y * 100) / 100]), [[0.5, 0.3], [0.5, 0.42], [0.5, 0.53]]);
      // A ref from the sign-in screen, used after the screen changed, is refused instead of tapping whatever is there now.
      const stale = await call('device_tap_element', {ref: email});
      assert.equal(stale.isError, true);assert.match(textOf(stale), /no longer on screen|device_snapshot/);
      assert.equal(app.taps.length, 3, 'nothing was tapped for the stale ref');
      assert.match(textOf(await call('device_snapshot', {})), /(heading|text) "Welcome, ada@example\.com"/);
      // The helper was asked with its bearer token, never with the token in a URL.
      const axRequests = hub.requests.filter(r => /\/ax$|api\/accessibility/.test(r.path));
      assert.ok(axRequests.length >= 3);assert.ok(axRequests.every(r => r.auth === `Bearer ${hub.token}` && !r.path.includes(hub.token)));
    } finally { await done(); hub.stop(); }
  });
}

// Spec: MUS-SPEC-21-809B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809b)
test('element tools keep the device rules: read-only chats only look, user control stops taps, another chat cannot act, coordinates stay as the fallback', async () => {
  const hub = new FakeDeviceHub(); await hub.start();
  const {target, chat, manager, done} = rig(hub);
  try {
    const call = (tool: string, args: Record<string, unknown>, chatId = 'c1') => runDeviceTool(target, chatId, tool, {device: UDID, ...args});
    assert.match(textOf(await call('device_tap_element', {label: 'Sign in'})), /device_open/, 'acting needs an open session');
    await call('device_open', {});
    chat.permissionMode = 'read-only';
    assert.equal((await call('device_snapshot', {})).isError, undefined, 'a read-only chat may read the screen');
    assert.match(textOf(await call('device_tap_element', {label: 'Sign in'})), /read-only/);
    assert.match(textOf(await call('device_type_into', {label: 'Email', text: 'x'})), /read-only/);
    chat.permissionMode = 'workspace';
    manager.control(UDID, 'user');
    assert.match(textOf(await call('device_tap_element', {label: 'Sign in'})), /taken control/);
    manager.control(UDID, 'agent');
    assert.match(textOf(await call('device_tap_element', {label: 'Sign in'}, 'c2')), /Another chat/);
    assert.equal(hub.app(UDID).taps.length, 0);
    assert.match(textOf(await call('device_tap_element', {})), /ref.*label|label.*ref/i);
    assert.match(textOf(await call('device_tap_element', {label: 'Nope'})), /No element labelled "Nope"/);
    // Coordinates still work after a screenshot-free snapshot is not enough: device_tap wants a screenshot first.
    assert.match(textOf(await call('device_tap', {x: 10, y: 10})), /device_screenshot first/);
    const names = DEVICE_TOOL_SPECS.map(spec => spec.name);
    for (const name of ['device_snapshot', 'device_tap_element', 'device_type_into', 'device_settings', 'device_tap', 'device_screenshot']) assert.ok(names.includes(name as never), name);
    assert.match(DEVICE_NOTE, /device_snapshot/);assert.match(DEVICE_NOTE, /ref/);assert.match(DEVICE_NOTE, /fall back|fallback/i);
  } finally { await done(); hub.stop(); }
});

// Spec: MUS-SPEC-21-809C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809c)
test('accessibility trees flatten to labelled elements: full-screen roots skipped, values kept, the 500 cap, Android captions find their field', () => {
  const app = new TaskboardApp();
  app.email = 'ada@example.com';
  const ios = parseIosAx(iosTree(app));
  assert.deepEqual(ios.screen, {width: 402, height: 874});
  const field = ios.elements.find(e => e.role === 'textfield')!;
  assert.deepEqual([field.label, field.value, field.editable, field.key], ['Email', 'ada@example.com', true, 'id:email-field']);
  assert.ok(!ios.elements.some(e => e.role === 'application' || e.role === 'window'), 'full-screen roots skipped');
  assert.ok(!ios.elements.some(e => e.role === 'other'), 'an unlabelled group is left out');
  const android = parseAndroidAx(androidSnapshot(androidDump(app)));
  assert.deepEqual(android.screen, {width: 1080, height: 2424});
  const edit = android.elements.find(e => e.role === 'textfield')!;
  assert.deepEqual([edit.label, edit.value, edit.key], ['email', 'ada@example.com', 'id:com.example.taskboard:id/email']);
  assert.ok(!android.elements.some(e => e.role === 'framelayout'), 'the full-screen content frame is dropped');
  // A field with no id or description is found from the caption above it.
  const bare = androidSnapshot(androidDump(new TaskboardApp()));
  for (const node of bare.nodes as {resourceId: string}[]) node.resourceId = '';
  const parsed = parseAndroidAx(bare);
  const found = findByLabel(parsed, 'Password', 'type');
  assert.ok('element' in found, JSON.stringify(found));
  assert.equal(found.element.role, 'textfield');assert.ok(found.element.frame.y > parsed.elements.find(e => e.label === 'Password')!.frame.y);
  // Tapping by a label two different buttons share is an error that lists both refs.
  const twice = parseIosAx([{type: 'Application', frame: {x: 0, y: 0, width: 100, height: 100}, children: [
    {type: 'Button', AXLabel: 'Delete', frame: {x: 0, y: 10, width: 50, height: 10}, children: []}, {type: 'Button', AXLabel: 'Delete', frame: {x: 0, y: 30, width: 50, height: 10}, children: []}]}]);
  const ambiguous = findByLabel(twice, 'delete', 'tap');
  assert.ok('error' in ambiguous);assert.match(ambiguous.error, /2 elements match "delete": e1 button "Delete"; e2 button "Delete"/);
  // The cap, and a bounded listing.
  const many = parseIosAx([{type: 'Application', frame: {x: 0, y: 0, width: 400, height: 800}, children: Array.from({length: 700}, (_, i) => ({type: 'Button', AXLabel: `Row ${i}`, frame: {x: 0, y: i, width: 400, height: 1}, children: []}))}]);
  assert.equal(many.elements.length, AX_ELEMENT_LIMIT);assert.equal(many.truncated, true);
  const listing = formatAx(many, 'iPhone', 4000);
  assert.ok(listing.length <= 4200);assert.match(listing, /more elements were left out/);
  assert.throws(() => parseIosAx({error: 'ax_unavailable', message: 'The simulator could not describe its screen.'}), /could not describe/);
  assert.throws(() => parseAndroidAx({ok: false, error: 'uiautomator dump failed'}), /uiautomator dump failed/);
});

// --- Settings: ported from T3 Code's DeviceActions.test.ts (MIT, T3 Tools Inc., fa4e4677) ------------------------------

function actionHost(platform: 'ios' | 'android', respond: (args: string[]) => string | Error = () => '', helpers: ActionHost['helpers'] = {axSettings: '/hub/simax/serve-sim-ax-settings', serveSim: '/hub/serve-sim.js'}) {
  const calls: string[][] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-809-act-'));
  let rotated = 0;
  const host: ActionHost = {platform, deviceId: platform === 'ios' ? 'SIM-1' : SERIAL, adb: '/sdk/platform-tools/adb', node: '/bin/node', helpers, tmpDir,
    run: async (file, args) => { calls.push([file, ...args]); const out = respond(args); if (out instanceof Error) throw out; return out; }, rotate: async () => { rotated++; }};
  return {host, calls, tmpDir, rotated: () => rotated};
}

// Spec: MUS-SPEC-21-809D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809d)
test('settings actions run fixed argv per platform: URLs arrive whole, rotation follows the natural orientation, permissions apply where they can', async () => {
  for (const url of ['https://example.com/callback?code=1&state=2', "https://example.com/it's?a=1&b=2", 'https://example.com/a b?key=value', 'https://example.com/plain']) {
    const {host, calls} = actionHost('android');
    await runDeviceAction(host, parseDeviceAction({type: 'openUrl', url}));
    const args = calls[0]!.slice(1);
    assert.deepEqual(args.slice(0, 3), ['-s', SERIAL, 'shell']);
    if (process.platform !== 'win32') {
      // adb joins its arguments verbatim before the Android shell parses them.
      const out = spawnSync('/bin/sh', ['-c', `am() { printf '%s\\0' "$@"; }\n${args.slice(3).join(' ')}`], {encoding: 'utf8'}).stdout;
      assert.deepEqual(out.split('\0').slice(0, -1), ['start', '-a', 'android.intent.action.VIEW', '-d', url], url);
    }
  }
  for (const [deviceId, wmSize, value, expected] of [
    ['emulator-5554', 'Physical size: 2560x1600', 'portrait', '-9.81:0:0'],
    ['emulator-5554', 'Physical size: 2560x1600', 'landscape_left', '0:9.81:0'],
    ['R5CT1234', 'Physical size: 2560x1600', 'portrait', '3'],
    ['R5CT1234', 'Physical size: 2560x1600', 'landscape_left', '0'],
    ['R5CT1234', 'Physical size: 1080x1920\nOverride size: 1920x1080', 'portrait', '3'],
  ] as const) {
    const {host, calls} = actionHost('android', args => args.join(' ').endsWith('shell wm size') ? `${wmSize}\n` : '');
    host.deviceId = deviceId;
    await runDeviceAction(host, {type: 'setOrientation', value});
    assert.equal(calls.at(-1)!.at(-1), expected, `${deviceId} ${wmSize} ${value}`);
  }
  for (const [permission, decision, first] of [['camera', 'grant', 'android.permission.CAMERA'], ['photos', 'revoke', 'android.permission.READ_MEDIA_IMAGES']] as const) {
    const {host} = actionHost('android', args => new Error(`Unknown package: ${args.at(-1)}`));
    await assert.rejects(runDeviceAction(host, {type: 'setPermission', appId: 'com.example.missing', permission, decision}), (error: Error) => error.message.includes(`Unknown package: ${first}`) && /permission/.test(error.message));
  }
  for (const [permission, permissions, success] of [['photos', ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE'], 1], ['contacts', ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'], 0]] as const) {
    const {host, calls} = actionHost('android', args => args.at(-1) === permissions[success] ? '' : new Error('not declared'));
    await runDeviceAction(host, {type: 'setPermission', appId: 'com.example.app', permission, decision: 'grant'});
    assert.deepEqual(calls.map(call => call.at(-1)), permissions, `${permission}: a partial change is kept`);
  }
  // iOS: simctl for what it can do, the helper's tools for the rest; a push goes through a private file, removed after.
  const ios = actionHost('ios', args => { if (args[1] === 'push') { const file = args.at(-1)!; assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {aps: {alert: 'Your order shipped'}}); } return ''; });
  const run = (action: unknown) => runDeviceAction(ios.host, parseDeviceAction(action));
  await run({type: 'setAppearance', value: 'dark'});
  await run({type: 'setTextSize', value: 'extra-large'});
  await run({type: 'setToggle', setting: 'increaseContrast', value: true});
  await run({type: 'setToggle', setting: 'reduceMotion', value: true});
  await run({type: 'setLocation', latitude: 51.5074, longitude: -0.1278});
  await run({type: 'clearLocation'});
  await run({type: 'setPermission', appId: 'com.example.app', permission: 'camera', decision: 'grant'});
  await run({type: 'setPermission', appId: 'com.example.app', permission: 'notifications', decision: 'revoke'});
  await run({type: 'openUrl', url: 'taskboard://tasks/42'});
  await run({type: 'sendPush', appId: 'com.example.app', payload: 'Your order shipped'});
  await run({type: 'rotate'});
  assert.deepEqual(ios.calls.map(call => call.slice(1).join(' ').replace(/\/[^ ]*push-[^ ]*/, '<file>')), [
    'simctl ui SIM-1 appearance dark',
    'simctl ui SIM-1 content_size accessibility-large',
    'simctl ui SIM-1 increase_contrast enabled',
    'simctl spawn SIM-1 /hub/simax/serve-sim-ax-settings set reduce-motion on',
    'simctl location SIM-1 set 51.5074,-0.1278',
    'simctl location SIM-1 clear',
    'simctl privacy SIM-1 grant camera com.example.app',
    '/hub/serve-sim.js permissions revoke notifications com.example.app -d SIM-1',
    'simctl openurl SIM-1 taskboard://tasks/42',
    'simctl push SIM-1 com.example.app <file>',
  ]);
  assert.equal(ios.rotated(), 1, 'rotate turns the live session');
  assert.deepEqual(fs.readdirSync(ios.tmpDir), [], 'the push file is gone');
  // Missing helper parts say so; unsupported actions say so before anything runs.
  const bare = actionHost('ios', () => '', {});
  await assert.rejects(runDeviceAction(bare.host, {type: 'setToggle', setting: 'voiceOver', value: true}), /Reinstall the helper/);
  for (const [platform, action, reason] of [
    ['ios', {type: 'shake'}, /Shake is not supported on the iOS Simulator/],
    ['android', {type: 'shake'}, /Shake is not supported on the Android Emulator/],
    ['android', {type: 'sendPush', appId: 'com.x', payload: 'hi'}, /push notification is not supported on the Android Emulator/],
    ['android', {type: 'clearLocation'}, /cannot clear its location/],
    ['ios', {type: 'setOrientation', value: 'landscape_left'}, /use rotate/],
    ['android', {type: 'setToggle', setting: 'voiceOver', value: true}, /voiceOver setting is not supported on the Android Emulator/],
    ['android', {type: 'setPermission', appId: 'com.x', permission: 'faceid', decision: 'grant'}, /faceid permission is not supported/],
  ] as const) {
    const {host, calls} = actionHost(platform);
    await assert.rejects(runDeviceAction(host, action as DeviceAction), reason);
    assert.deepEqual(calls, [], `${platform} ${action.type}: nothing ran`);
    assert.match(deviceActionUnsupported(platform, action as DeviceAction)!, reason);
  }
  assert.equal(androidShellWord('plain/path'), 'plain/path');assert.equal(androidShellWord("it's"), `'it'\\''s'`);
});

// Spec: MUS-SPEC-21-809E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809e)
test('settings read back from the device; unreadable values are unknown, not guessed; actions are validated before they run', async () => {
  const ios = actionHost('ios', args => {
    const key = args.join(' ');
    if (key.endsWith('ui SIM-1 appearance')) return 'dark\n';
    if (key.endsWith('ui SIM-1 content_size')) return 'extra-extra-large\n';
    if (key.endsWith('ui SIM-1 increase_contrast')) return 'enabled\n';
    if (key.includes('serve-sim-ax-settings status')) return '{"reduce-motion":"on","reduce-transparency":"off","show-borders":"off","voiceover":"off","liquid-glass":"tinted","color-filter":"grayscale"}';
    return new Error('unexpected');
  });
  assert.deepEqual((await readDeviceSettings(ios.host)).settings, {appearance: 'dark', textSize: 'large', increaseContrast: true, reduceMotion: true, reduceTransparency: false, showBorders: false, voiceOver: false, liquidGlass: 'tinted', colorFilter: 'grayscale'});
  const broken = await readDeviceSettings(actionHost('ios', () => new Error('boom')).host);
  assert.deepEqual(broken, {settings: {}, foregroundApp: null});
  const android = actionHost('android', args => {
    const key = args.join(' ');
    if (key.endsWith('cmd uimode night')) return 'Night mode: yes\n';
    if (key.endsWith('font_scale')) return '0.85\n';
    if (key.endsWith('animator_duration_scale')) return '0\n';
    if (key.endsWith('wifi_on')) return '1\n';
    if (key.endsWith('dumpsys window')) return '  mFocusedApp=ActivityRecord{155579877 u0 com.example.app/.MainActivity t15}\n  mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.MainActivity}\n';
    return new Error('unexpected');
  });
  assert.deepEqual(await readDeviceSettings(android.host), {settings: {appearance: 'dark', textSize: 'small', reduceMotion: true, networkEnabled: true}, foregroundApp: 'com.example.app'});
  // The validator: bounds, enums, ids, URL shape and the 4 KB APNs limit.
  for (const [bad, reason] of [
    [{type: 'setLocation', latitude: 91, longitude: 0}, /Latitude/], [{type: 'setLocation', latitude: 0, longitude: -181}, /Longitude/], [{type: 'setLocation', latitude: '1', longitude: 0}, /Latitude/],
    [{type: 'setAppearance', value: 'auto'}, /appearance: light, dark/], [{type: 'setTextSize', value: 'huge'}, /text size/], [{type: 'setToggle', setting: 'reduceMotion', value: 'yes'}, /true \(on\)/],
    [{type: 'setPermission', appId: '-rf', permission: 'camera', decision: 'grant'}, /bundle id/], [{type: 'setPermission', appId: 'com.x', permission: 'bluetooth', decision: 'grant'}, /permission/],
    [{type: 'openUrl', url: 'not a url'}, /scheme/], [{type: 'openUrl', url: 'https://x.test/\nrm'}, /scheme/], [{type: 'openUrl', url: `https://x.test/${'a'.repeat(2100)}`}, /2048/],
    [{type: 'sendPush', appId: 'com.x', payload: {aps: {alert: 'x'.repeat(5000)}}}, /4 KB/], [{type: 'sendPush', appId: 'com.x', payload: ''}, /1 to 1000/], [{type: 'sendPush', appId: 'com.x', payload: [1]}, /JSON object/],
    [{type: 'runShell', command: 'reboot'}, /Unknown device action runShell/], [null, /Pass a device action/],
  ] as const) assert.throws(() => parseDeviceAction(bad), reason, JSON.stringify(bad));
  assert.deepEqual(parseDeviceAction({type: 'openUrl', url: '  myapp://open?x=1  ', extra: true}), {type: 'openUrl', url: 'myapp://open?x=1'}, 'unknown fields are dropped');
  assert.ok(DEVICE_COMMANDS['devices.detail'] && DEVICE_COMMANDS['devices.action']);
});

// Spec: MUS-SPEC-21-809F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809f)
test('device_settings: an agent switches to dark mode and larger text and reads them back; unsupported actions say so', async () => {
  const hub = new FakeDeviceHub(); await hub.start();
  const log: string[][] = [];
  const {target, chat, manager, done} = rig(hub, log);
  try {
    const call = (args: Record<string, unknown>) => runDeviceTool(target, 'c1', 'device_settings', {device: UDID, ...args});
    const before = textOf(await call({}));
    assert.match(before, /appearance: light/);assert.match(before, /text size: default/);
    assert.match(textOf(await call({action: {type: 'setAppearance', value: 'dark'}})), /device_open/, 'changing a setting needs the agent\'s open session');
    await runDeviceTool(target, 'c1', 'device_open', {device: UDID});
    const dark = await call({action: {type: 'setAppearance', value: 'dark'}});
    assert.equal(dark.isError, undefined, textOf(dark));assert.match(textOf(dark), /appearance: dark/);
    assert.match(textOf(await call({action: {type: 'setTextSize', value: 'large'}})), /text size: large/);
    const shake = await call({action: {type: 'shake'}});
    assert.equal(shake.isError, true);assert.match(textOf(shake), /Shake is not supported on the iOS Simulator/);
    assert.match(textOf(await call({action: {type: 'setLocation', latitude: 200, longitude: 0}})), /Latitude/);
    chat.permissionMode = 'read-only';
    assert.equal((await call({})).isError, undefined, 'reading settings is allowed in a read-only chat');
    assert.match(textOf(await call({action: {type: 'setAppearance', value: 'light'}})), /read-only/);
    chat.permissionMode = 'workspace';
    manager.control(UDID, 'user');
    assert.match(textOf(await call({action: {type: 'setAppearance', value: 'light'}})), /taken control/);
    // The renderer commands: the same actions, validated, with the read-back as the answer.
    const detail = await manager.action(UDID, {type: 'setAppearance', value: 'light'});
    assert.equal(detail.settings.appearance, 'light');assert.equal(detail.platform, 'ios');
    await assert.rejects(manager.action(UDID, {type: 'setAppearance', value: 'sepia'}), /appearance/);
    assert.ok(log.filter(call => call.join(' ').includes(UDID)).every(call => call[0] === '/usr/bin/xcrun'), 'only simctl ran against the iPhone');
  } finally { await done(); hub.stop(); }
});
