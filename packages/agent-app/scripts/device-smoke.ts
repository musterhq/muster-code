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
/** Every forwarded frame (measurements), acknowledged at once like a renderer that keeps up. */
let onFrame: ((frame: LinkFrame) => void) | undefined;
const manager = new DeviceManager({
  userData, manifestDir: path.join(here, '..', 'resources', 'device-helper'), run, runBuffer, exists: fs.existsSync,
  readText: file => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }, env: process.env, home: os.homedir(), platform: process.platform,
  locate: name => locateCli(name, process.env, os.homedir()),
  spawn: (command, args, options) => spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe']}),
  fetch: (...args) => fetch(...args),
  socket: (url, headers) => new (WebSocket as unknown as new (url: string, init: {headers: Record<string, string>}) => WebSocket)(url, {headers}) as never,
  emit: event => { if (event.type === 'deviceSessions') step('sessions', event.sessions.map(s => ({state: s.state, input: s.inputReady, error: s.error}))); },
  frame: (id, frame) => { first?.(frame); onFrame?.(frame); if (!frame.config) manager.ack(id); },
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
  const frame = new Promise<LinkFrame>((resolve) => { first = f => { if (f.data.length && !f.config && (f.codec === 'jpeg' || f.key)) { first = undefined; resolve(f); } }; });
  const session = await deadline(manager.open(pick.id), 6 * 60_000, 'boot and open');
  step('opened', {state: session.state});
  // Which frame the view would draw: the device's own (Xcode chrome or SDK skin, read at runtime) or the parametric one.
  // Only its description is logged; the images are never saved.
  const chrome = await manager.chrome(session.deviceId).catch(error => { step('frame source error', String(error)); return null; });
  step('frame source', chrome ? {source: chrome.source, detail: chrome.detail, size: [chrome.width, chrome.height], screen: chrome.screen, buttons: chrome.buttons.length, imageBytes: chrome.image.dataUrl.length, mask: !!chrome.mask} : 'parametric');
  manager.view(session.deviceId, 'smoke', true);
  const got = await deadline(frame, 120_000, 'first frame');
  const file = path.join(out, `${platform}-first-frame.${got.codec === 'jpeg' ? 'jpg' : 'h264'}`);
  fs.writeFileSync(file, got.data);
  if (got.codec === 'jpeg' && !(got.data[0] === 0xff && got.data[1] === 0xd8)) throw new Error('The first frame is not a JPEG.');
  if (got.codec === 'h264' && got.format !== 'avcc') {
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
  // Smoothness and cost, per transport: 5 s of swiping in Settings (so the screen keeps changing).
  const measure = async (label: string) => {
    await new Promise(r => setTimeout(r, 1500));
    let frames = 0, bytes = 0, waiting: number | undefined;
    const latencies: number[] = [];
    onFrame = frame => { if (frame.config) return; frames++; bytes += frame.data.length; if (waiting !== undefined) { latencies.push(performance.now() - waiting); waiting = undefined; } };
    const cpu = process.cpuUsage(), started = performance.now();
    while (performance.now() - started < 5000) {
      for (const [from, to] of [[0.75, 0.3], [0.3, 0.75]] as const) {
        waiting = performance.now();
        manager.input(session.deviceId, {kind: 'touch', phase: 'begin', x: 0.5, y: from}, 'agent');
        for (let i = 1; i <= 12; i++) { await new Promise(r => setTimeout(r, 16)); manager.input(session.deviceId, {kind: 'touch', phase: 'move', x: 0.5, y: from + (to - from) * i / 12}, 'agent'); }
        manager.input(session.deviceId, {kind: 'touch', phase: 'end', x: 0.5, y: to}, 'agent');
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const seconds = (performance.now() - started) / 1000, used = process.cpuUsage(cpu);
    onFrame = undefined;
    latencies.sort((a, b) => a - b);
    const result = {label, transport: manager.liveStats(session.deviceId)?.transport, fps: +(frames / seconds).toFixed(1), kbps: Math.round(bytes * 8 / seconds / 1000),
      mainCpuPct: +((used.user + used.system) / 1000 / (seconds * 1000) * 100).toFixed(1), inputToFrameMs: latencies.length ? {median: Math.round(latencies[latencies.length >> 1]!), p90: Math.round(latencies[Math.floor(latencies.length * 0.9)]!)} : null,
      restarts: manager.liveStats(session.deviceId)?.restarts};
    step('measure', result);
    return result;
  };
  const measurements = [await measure(platform === 'ios' ? 'after: H.264 (AVCC)' : 'H.264 (scrcpy)')];
  if (platform === 'ios') {
    // Before: the MJPEG stream this replaced (also the fallback for windows that cannot decode H.264).
    manager.streamFallback(session.deviceId);
    for (let i = 0; i < 50 && manager.liveStats(session.deviceId)?.transport !== 'mjpeg'; i++) await new Promise(r => setTimeout(r, 100));
    measurements.push(await measure('before: MJPEG'));
  }
  report.measurements = measurements;
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
