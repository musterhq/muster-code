/**
 * Device discovery and platform checks (#363). Read-only: `xcrun simctl list`, `adb devices`, `emulator -list-avds`
 * and version probes. Nothing here boots, installs or changes anything, so Settings can show what is available before
 * the user turns devices on. Every external program is reached through an injected runner so tests drive the parsers.
 */
import path from 'node:path';
import type {DeviceFormFactor, DeviceInfo, PlatformCheck} from '../../shared/device-protocol.ts';
import {device} from '../../shared/device-noun.ts';

export type Run = (file: string, args: string[], options?: {timeoutMs?: number; env?: NodeJS.ProcessEnv}) => Promise<string>;
export interface ProbeDeps {
  run: Run;
  exists(file: string): boolean;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

// --- iOS ---------------------------------------------------------------------------------------------------------

interface SimctlDevice {udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown; deviceTypeIdentifier?: unknown}
/** `xcrun simctl list devices --json`: available iPhone and iPad simulators, newest runtime first. Watch, TV and Vision are left out. */
export function parseSimctlDevices(json: string): DeviceInfo[] {
  let parsed: {devices?: Record<string, SimctlDevice[]>};
  try { parsed = JSON.parse(json); } catch { return []; }
  const out: DeviceInfo[] = [];
  const runtimes = Object.entries(parsed.devices ?? {}).sort(([a], [b]) => runtimeVersion(b) - runtimeVersion(a));
  for (const [runtime, devices] of runtimes) {
    const os = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!os || !Array.isArray(devices)) continue;
    for (const device of devices) {
      if (typeof device?.udid !== 'string' || typeof device.name !== 'string' || device.isAvailable === false) continue;
      const type = typeof device.deviceTypeIdentifier === 'string' ? device.deviceTypeIdentifier : device.name;
      const formFactor: DeviceFormFactor | null = /iPad/i.test(type) ? 'tablet' : /iPhone/i.test(type) ? (/Fold|Duo/i.test(type) ? 'foldable' : 'phone') : null;
      if (!formFactor) continue;
      const state = String(device.state ?? '').toLowerCase();
      out.push({id: device.udid, name: device.name, platform: 'ios', osVersion: `iOS ${os[1]}.${os[2]}`, formFactor,
        state: state === 'booted' ? 'booted' : state === 'booting' ? 'booting' : state === 'shutting down' ? 'shutting-down' : 'shutdown'});
    }
  }
  return out;
}
const runtimeVersion = (runtime: string) => { const m = /-(\d+)-(\d+)$/.exec(runtime); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; };

/** Xcode (not just the Command Line Tools) is what ships simctl and the simulator runtimes. */
export async function checkIos(deps: ProbeDeps): Promise<PlatformCheck> {
  if (deps.platform !== 'darwin') return {available: false, reason: 'iOS Simulators need a Mac with Xcode.', fix: ['Use Android Emulators here, or open Muster on a Mac with Xcode to use iOS Simulators.']};
  let developerDir = '';
  try { developerDir = (await deps.run('/usr/bin/xcode-select', ['-p'], {timeoutMs: 5000})).trim(); } catch {}
  const fix = ['Install Xcode from the App Store.', 'Open Xcode once and let it install its components.', 'In Terminal run: sudo xcode-select -s /Applications/Xcode.app'];
  if (!developerDir) return {available: false, reason: 'Xcode is not installed.', fix};
  if (developerDir.includes('CommandLineTools')) return {available: false, reason: 'Only the Command Line Tools are selected, and iOS Simulators need the full Xcode.', fix, detail: developerDir};
  try {
    const version = (await deps.run('/usr/bin/xcrun', ['xcodebuild', '-version'], {timeoutMs: 10_000})).split('\n')[0]?.trim() ?? 'Xcode';
    await deps.run('/usr/bin/xcrun', ['simctl', 'help'], {timeoutMs: 10_000});
    return {available: true, detail: version};
  } catch (error) {
    return {available: false, reason: 'Xcode is installed but its simulator tools did not answer.', fix: ['Open Xcode once and accept its license and component install.', `If you just updated Xcode, restart ${device().your}.`], detail: errorLine(error)};
  }
}
export async function listIos(deps: ProbeDeps): Promise<DeviceInfo[]> {
  return parseSimctlDevices(await deps.run('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], {timeoutMs: 20_000}));
}

// --- Android -----------------------------------------------------------------------------------------------------

/** ANDROID_HOME, ANDROID_SDK_ROOT, then the SDK Manager's default folder for this platform. */
export function androidSdkRoot(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  const explicit = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim();
  if (explicit) return explicit;
  if (platform === 'darwin') return path.join(home, 'Library', 'Android', 'sdk');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Android', 'Sdk');
  return path.join(home, 'Android', 'Sdk');
}
export interface AndroidTools {sdk: string; adb: string; emulator: string}
export function androidTools(deps: Pick<ProbeDeps, 'env' | 'home' | 'platform'>): AndroidTools {
  const sdk = androidSdkRoot(deps.env, deps.home, deps.platform), exe = deps.platform === 'win32' ? '.exe' : '';
  return {sdk, adb: path.join(sdk, 'platform-tools', `adb${exe}`), emulator: path.join(sdk, 'emulator', `emulator${exe}`)};
}
export async function checkAndroid(deps: ProbeDeps): Promise<PlatformCheck> {
  const tools = androidTools(deps);
  const fix = ['Install Android Studio from developer.android.com/studio.', 'In Android Studio open Settings › Languages & Frameworks › Android SDK and install the Android Emulator and Android SDK Platform-Tools.', 'Create a virtual device in Device Manager.', 'If the SDK is somewhere else, set ANDROID_HOME to its folder and restart Muster.'];
  if (!deps.exists(tools.sdk)) return {available: false, reason: 'Android SDK not found.', fix, detail: `Looked in ${tools.sdk}`};
  if (!deps.exists(tools.emulator)) return {available: false, reason: 'The Android Emulator is not installed in the SDK.', fix: fix.slice(1), detail: tools.sdk};
  if (!deps.exists(tools.adb)) return {available: false, reason: 'Android SDK Platform-Tools (adb) are not installed.', fix: fix.slice(1, 2), detail: tools.sdk};
  return {available: true, detail: `Android SDK at ${tools.sdk.replace(deps.home, '~')}`};
}
/** `adb devices`: running emulators only (physical phones are out of scope). */
export function parseAdbDevices(stdout: string): {serial: string; state: string}[] {
  return stdout.split(/\r?\n/).map(line => /^(emulator-\d+)\s+(\S+)/.exec(line.trim())).filter((m): m is RegExpExecArray => !!m).map(m => ({serial: m[1]!, state: m[2]!}));
}
export const parseAvdList = (stdout: string): string[] => stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9._-]+$/.test(line));
export function androidFormFactor(name: string): DeviceFormFactor {
  if (/fold|flip|duo/i.test(name)) return 'foldable';
  if (/tablet|pixel[ _-]?c\b|tab\b|pixel[ _-]?tablet/i.test(name)) return 'tablet';
  return 'phone';
}
export async function listAndroid(deps: ProbeDeps): Promise<DeviceInfo[]> {
  const tools = androidTools(deps);
  const [adbOut, avdOut] = await Promise.all([
    deps.run(tools.adb, ['devices'], {timeoutMs: 10_000}).catch(() => ''),
    deps.run(tools.emulator, ['-list-avds'], {timeoutMs: 15_000}).catch(() => ''),
  ]);
  const running = parseAdbDevices(adbOut);
  const out: DeviceInfo[] = [];
  const named = new Set<string>();
  for (const {serial, state} of running) {
    // `emu avd name` answers the AVD a running emulator was started from (first line), so it is not listed twice.
    const avd = (await deps.run(tools.adb, ['-s', serial, 'emu', 'avd', 'name'], {timeoutMs: 5000}).catch(() => '')).split(/\r?\n/)[0]?.trim() || serial;
    const release = state === 'device' ? (await deps.run(tools.adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], {timeoutMs: 5000}).catch(() => '')).trim() : '';
    const booted = state === 'device' && (await deps.run(tools.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {timeoutMs: 5000}).catch(() => '')).trim() === '1';
    named.add(avd);
    out.push({id: serial, name: avd, platform: 'android', osVersion: release ? `Android ${release}` : 'Android', formFactor: androidFormFactor(avd), state: booted ? 'booted' : 'booting'});
  }
  for (const avd of parseAvdList(avdOut)) if (!named.has(avd)) out.push({id: `avd:${avd}`, name: avd, platform: 'android', osVersion: 'Android', formFactor: androidFormFactor(avd), state: 'shutdown'});
  return out;
}

// --- Node (runs and installs the helper) -------------------------------------------------------------------------

export const MIN_NODE_MAJOR = 20;
export async function checkNode(deps: ProbeDeps, node: string | undefined, npm: string | undefined): Promise<PlatformCheck> {
  const fix = [`Install Node.js ${MIN_NODE_MAJOR} or later from nodejs.org (it includes npm).`, 'Restart Muster so it finds the new install.'];
  if (!node || !npm) return {available: false, reason: !node ? 'Node.js was not found. Muster uses it to run the device helper.' : 'npm was not found. Muster uses it to download the device helper.', fix};
  try {
    const version = (await deps.run(node, ['--version'], {timeoutMs: 5000})).trim();
    const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
    if (major < MIN_NODE_MAJOR) return {available: false, reason: `Node.js ${version} is too old for the device helper.`, fix, detail: node};
    return {available: true, detail: version.replace(/^v/, '')};
  } catch (error) { return {available: false, reason: 'Node.js did not start.', fix, detail: errorLine(error)}; }
}

export const errorLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n').find(line => line.trim())?.trim().slice(0, 240) ?? 'Unknown error';
