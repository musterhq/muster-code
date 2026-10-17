/**
 * Real-device smoke test for Devices (#363), run in CI (.github/workflows/agent-app-devices.yml) on a macOS runner with
 * Xcode (iOS Simulator) and on Linux with KVM (Android Emulator). It drives the same main-process code the app uses:
 * installs the pinned helper with npm ci from the shipped lockfile, starts it on loopback with a token, boots a device
 * headless, streams until the first frame arrives through the helper, checks input is admitted, presses Home, lists apps,
 * launches Settings, takes screenshots, then shuts everything down. Artifacts (first frame, screenshot, a JSON report) go to $SMOKE_OUT.
 *
 *   node --experimental-transform-types scripts/device-smoke.ts ios|android
 */
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeviceManager} from '../src/main/devices/manager.ts';
import {locateCli} from '../src/runtime/adapters/shared.ts';
import type {LinkFrame} from '../src/main/devices/link.ts';

const platform = process.argv[2] === 'android' ? 'android' : 'ios';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.SMOKE_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'device-smoke-out-'));
fs.mkdirSync(out, {recursive: true});
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'device-smoke-'));
const report: Record<string, unknown> = {platform, started: new Date().toISOString()};
const step = (name: string, detail?: unknown) => { console.log(`[smoke] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); (report.steps as unknown[] ?? (report.steps = [])).push({name, at: Date.now(), ...(detail === undefined ? {} : {detail})}); };
const run = (file: string, args: string[], options: {timeoutMs?: number} = {}) => new Promise<string>((resolve, reject) => execFile(file, args, {timeout: options.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'}, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(stdout)));
const runBuffer = (file: string, args: string[], options: {timeoutMs?: number} = {}) => new Promise<Buffer>((resolve, reject) => execFile(file, args, {timeout: options.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer'}, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(stdout)));

let first: ((frame: LinkFrame) => void) | undefined;
const manager = new DeviceManager({
  userData, manifestDir: path.join(here, '..', 'resources', 'device-helper'), run, runBuffer, exists: fs.existsSync,
  readText: file => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }, env: process.env, home: os.homedir(), platform: process.platform,
  locate: name => locateCli(name, process.env, os.homedir()),
  spawn: (command, args, options) => spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe']}),
  fetch: (...args) => fetch(...args),
  socket: (url, headers) => new (WebSocket as unknown as new (url: string, init: {headers: Record<string, string>}) => WebSocket)(url, {headers}) as never,
  emit: event => { if (event.type === 'deviceSessions') step('sessions', event.sessions.map(s => ({state: s.state, input: s.inputReady, error: s.error}))); },
  frame: (_id, frame) => first?.(frame),
});

const deadline = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
let exit = 1;
try {
  const setup = await manager.setup(true);
  step('setup', {ios: setup.ios, android: setup.android, node: setup.node});
  if (!(platform === 'ios' ? setup.ios : setup.android).available) throw new Error(`${platform} tools are not available on this runner.`);
  await manager.configure({enabled: true});
  const installed = await deadline(manager.installHelper(), 10 * 60_000, 'helper install');
  step('helper installed', installed.helper);
  const list = await manager.devices(true);
  step('devices', list.devices.map(d => `${d.platform}:${d.name}:${d.state}`));
  const pick = list.devices.filter(d => d.platform === platform).sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted') || Number(a.formFactor !== 'phone') - Number(b.formFactor !== 'phone'))[0];
  if (!pick) throw new Error(`No ${platform} device to test with.`);
  step('device', pick);
  // The frame Muster derived for it (simctl device type, or the AVD's config and reported cut-out).
  step('frame', {id: pick.frame?.id, family: pick.frame?.family, source: pick.frame?.source, cutout: pick.frame?.cutout});
  const frame = new Promise<LinkFrame>((resolve) => { first = f => { if (f.data.length && (f.codec === 'jpeg' || f.key)) { first = undefined; resolve(f); } }; });
  const session = await deadline(manager.open(pick.id), 6 * 60_000, 'boot and open');
  step('opened', {state: session.state});
  manager.view(session.deviceId, 'smoke', true);
  const got = await deadline(frame, 120_000, 'first frame');
  const file = path.join(out, `${platform}-first-frame.${got.codec === 'jpeg' ? 'jpg' : 'h264'}`);
  fs.writeFileSync(file, got.data);
  if (got.codec === 'jpeg' && !(got.data[0] === 0xff && got.data[1] === 0xd8)) throw new Error('The first frame is not a JPEG.');
  if (got.codec === 'h264') {
    const {avcCodecFromAnnexB} = await import('../src/renderer/devices/geometry.ts');
    const codec = avcCodecFromAnnexB(got.data);
    if (!codec) throw new Error('The first H.264 keyframe carries no SPS.');
    step('h264 keyframe', {codec});
  }
  step('first frame', {codec: got.codec, bytes: got.data.length, file});
  const admitted = await manager.waitForInput(session.deviceId, 30_000);
  step('input admitted', admitted);
  if (!admitted) throw new Error('The device did not admit input.');
  await manager.button(session.deviceId, 'home');
  step('pressed home');
  // The agent tools' app path: list installed apps, launch the system Settings app, then go home again.
  const apps = await manager.apps(session.deviceId);
  const settings = platform === 'ios' ? 'com.apple.Preferences' : 'com.android.settings';
  step('apps', {count: apps.length, settings: apps.some(app => app.id === settings)});
  if (!apps.some(app => app.id === settings)) throw new Error(`${settings} is not in the app list.`);
  await manager.launchApp(session.deviceId, settings, 'agent');
  step('launched settings');
  const launched = await manager.screenshot(session.deviceId);
  fs.writeFileSync(path.join(out, `${platform}-settings.png`), launched.png);
  await manager.button(session.deviceId, 'home');
  const shot = await manager.screenshot(session.deviceId);
  fs.writeFileSync(path.join(out, `${platform}-screenshot.png`), shot.png);
  step('screenshot', {width: shot.width, height: shot.height});
  manager.view(session.deviceId, 'smoke', false);
  await manager.close(session.deviceId);
  exit = 0;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error('[smoke] FAILED', report.error);
  // Diagnostics: what the helper said, and what its own health and device routes answer.
  try {
    const hub = await manager.hubEndpoint();
    for (const route of [platform === 'ios' ? '/vendor/serve-sim/api' : '/vendor/serve-emu/health', '/api/devices', platform === 'android' ? '/vendor/serve-emu/api/devices' : '/vendor/serve-sim/grid/api/status']) {
      const response = await fetch(`${hub.origin}${route}`, {headers: {authorization: `Bearer ${hub.token}`}, signal: AbortSignal.timeout(15_000)}).catch(e => ({status: 0, text: async () => String(e)}));
      console.error(`[smoke] ${route} -> ${response.status} ${(await response.text()).slice(0, 1500)}`);
    }
  } catch (e) { console.error('[smoke] no helper for diagnostics', e); }
  console.error('[smoke] helper log tail:\n' + manager.hubLog.slice(-6000));
  report.hubLog = manager.hubLog.slice(-16000);
} finally {
  await manager.dispose().catch(() => undefined);
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(out, `${platform}-report.json`), JSON.stringify(report, null, 2));
  fs.rmSync(userData, {recursive: true, force: true});
  process.exit(exit);
}
