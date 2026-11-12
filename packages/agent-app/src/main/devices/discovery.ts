/**
 * Device discovery and platform checks (#363). Read-only: `xcrun simctl list`, `adb devices -l`, `emulator -list-avds`
 * and version probes. Nothing here boots, installs or changes anything, so Settings can show what is available before
 * the user turns devices on. Every external program is reached through an injected runner so tests drive the parsers.
 */
import path from 'node:path';
import type {DeviceFormFactor, DeviceInfo, PlatformCheck} from '../../shared/device-protocol.ts';
import {device} from '../../shared/device-noun.ts';
import {androidFrame, iosFrame, parseCutout, parseIni, type AvdConfig, type FrameSpec} from '../../shared/device-frames.ts';

export type Run = (file: string, args: string[], options?: {timeoutMs?: number; env?: NodeJS.ProcessEnv}) => Promise<string>;
export interface ProbeDeps {
  run: Run;
  exists(file: string): boolean;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** Reads a small text file (AVD configuration); undefined when it is missing. */
  readText?(file: string): string | undefined;
  /** Reads a small binary file (an emulator skin image); undefined when missing or too large. */
  readBytes?(file: string): Uint8Array | undefined;
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
      out.push({id: device.udid, name: device.name, platform: 'ios', osVersion: `iOS ${os[1]}.${os[2]}`, formFactor, frame: iosFrame(typeof device.deviceTypeIdentifier === 'string' ? device.deviceTypeIdentifier : undefined, device.name),
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
/** Where adb lives when there is no SDK copy: PATH, then the usual package-manager folders (an app started from the Dock
 *  does not get the shell's PATH; Homebrew installs adb at /opt/homebrew/bin). */
const ADB_FOLDERS: Partial<Record<NodeJS.Platform, string[]>> = {darwin: ['/opt/homebrew/bin', '/usr/local/bin'], linux: ['/usr/bin', '/usr/local/bin']};
/** The SDK's own adb and emulator; with no SDK adb, the first adb on PATH or in a package-manager folder. The emulator is
 *  only ever the SDK's. */
export function androidTools(deps: Pick<ProbeDeps, 'env' | 'home' | 'platform'> & Partial<Pick<ProbeDeps, 'exists'>>): AndroidTools {
  const sdk = androidSdkRoot(deps.env, deps.home, deps.platform), exe = deps.platform === 'win32' ? '.exe' : '';
  let adb = path.join(sdk, 'platform-tools', `adb${exe}`);
  if (deps.exists && !deps.exists(adb)) {
    const pathVar = deps.env.PATH ?? deps.env.Path ?? '';
    const folders = [...pathVar.split(deps.platform === 'win32' ? ';' : ':').filter(dir => dir && path.isAbsolute(dir)), ...(ADB_FOLDERS[deps.platform] ?? [])];
    const found = folders.map(dir => path.join(dir, `adb${exe}`)).find(file => deps.exists!(file));
    if (found) adb = found;
  }
  return {sdk, adb, emulator: path.join(sdk, 'emulator', `emulator${exe}`)};
}
export async function checkAndroid(deps: ProbeDeps): Promise<PlatformCheck> {
  const tools = androidTools(deps);
  const fix = ['Install Android Studio from developer.android.com/studio.', 'In Android Studio open Settings › Languages & Frameworks › Android SDK and install the Android Emulator and Android SDK Platform-Tools.', 'Create a virtual device in Device Manager.', 'If the SDK is somewhere else, set ANDROID_HOME to its folder and restart Muster.', 'For a phone over USB only, adb is enough (on a Mac: brew install android-platform-tools).'];
  const sdk = deps.exists(tools.sdk), adb = deps.exists(tools.adb), emulator = sdk && deps.exists(tools.emulator);
  const where = (file: string) => file.replace(deps.home, '~');
  if (!sdk && !adb) return {available: false, reason: 'Android SDK not found.', fix, detail: `Looked in ${tools.sdk}`};
  // USB phones need only adb; emulators need the SDK.
  if (!sdk) return {available: true, detail: `adb at ${where(tools.adb)}: phones over USB only; emulators need the Android SDK`};
  if (!emulator && !adb) return {available: false, reason: 'The Android Emulator is not installed in the SDK.', fix: fix.slice(1, 4), detail: tools.sdk};
  if (!adb) return {available: false, reason: 'Android SDK Platform-Tools (adb) are not installed.', fix: fix.slice(1, 2), detail: tools.sdk};
  if (!emulator) return {available: true, detail: `Android SDK at ${where(tools.sdk)} without the Android Emulator: phones over USB only`};
  return {available: true, detail: `Android SDK at ${where(tools.sdk)}`};
}
export interface AdbEntry {serial: string; state: string; model?: string; emulator: boolean}
/** `adb devices -l`: every device adb sees, with its state and the model it reports. */
export function parseAdbDeviceList(stdout: string): AdbEntry[] {
  const out: AdbEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9._:-]{1,128})\s+(device|unauthorized|offline|authorizing|no permissions|recovery|sideload|bootloader)\b(.*)$/.exec(raw.trim());
    if (!m || m[1]!.startsWith('-')) continue;
    const model = /\bmodel:([A-Za-z0-9._-]{1,80})/.exec(m[3]!)?.[1];
    out.push({serial: m[1]!, state: m[2]!, ...(model ? {model} : {}), emulator: /^emulator-\d+$/.test(m[1]!)});
  }
  return out;
}
/** `adb devices`: running emulators only. */
export function parseAdbDevices(stdout: string): {serial: string; state: string}[] {
  return parseAdbDeviceList(stdout).filter(entry => entry.emulator).map(({serial, state}) => ({serial, state}));
}
export const parseAvdList = (stdout: string): string[] => stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9._-]+$/.test(line));
export function androidFormFactor(name: string): DeviceFormFactor {
  if (/fold|flip|duo/i.test(name)) return 'foldable';
  if (/tablet|pixel[ _-]?c\b|tab\b|pixel[ _-]?tablet/i.test(name)) return 'tablet';
  return 'phone';
}
/** Where AVDs live: ANDROID_AVD_HOME, else ANDROID_USER_HOME/avd, else ~/.android/avd. */
export function avdHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.ANDROID_AVD_HOME?.trim() || (env.ANDROID_USER_HOME?.trim() ? path.join(env.ANDROID_USER_HOME.trim(), 'avd') : path.join(home, '.android', 'avd'));
}
/** An AVD's own description: `<name>.ini` points at its folder; config.ini there, overlaid by hardware-qemu.ini while it runs. */
export function readAvdConfig(deps: Pick<ProbeDeps, 'env' | 'home' | 'readText'>, name: string): AvdConfig {
  if (!deps.readText || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) return {};
  const root = avdHome(deps.env, deps.home);
  const pointer = parseIni(deps.readText(path.join(root, `${name}.ini`)) ?? '');
  const dir = pointer.path && path.isAbsolute(pointer.path) ? pointer.path : path.join(root, `${name}.avd`);
  return {...parseIni(deps.readText(path.join(dir, 'config.ini')) ?? ''), ...parseIni(deps.readText(path.join(dir, 'hardware-qemu.ini')) ?? '')};
}
const formOf = (frame: FrameSpec, name: string) => frame.form === 'foldable' ? 'foldable' as const : frame.form === 'tablet' ? 'tablet' as const : frame.form === 'phone' ? 'phone' as const : androidFormFactor(name);
/** The cut-out Android itself reports (a generic device's only source for it). */
async function reportedCutout(deps: ProbeDeps, adb: string, serial: string) {
  const [displays, size] = await Promise.all([
    deps.run(adb, ['-s', serial, 'shell', 'dumpsys', 'window', 'displays'], {timeoutMs: 5000}).catch(() => ''),
    deps.run(adb, ['-s', serial, 'shell', 'wm', 'size'], {timeoutMs: 5000}).catch(() => ''),
  ]);
  const physical = /(\d+)x(\d+)/.exec(size);
  return physical ? parseCutout(displays, Math.min(Number(physical[1]), Number(physical[2]))) : undefined;
}
const getprop = (deps: ProbeDeps, adb: string, serial: string, name: string) => deps.run(adb, ['-s', serial, 'shell', 'getprop', name], {timeoutMs: 5000}).then(out => out.trim(), () => '');
export const USB_DEBUGGING_FIX = 'Unlock the phone and tap Allow on its “Allow USB debugging?” prompt (tick Always allow from this computer). No prompt? Unplug the cable and plug it back in.';
const NO_PERMISSION_FIX = 'This computer cannot open the phone over USB. On Linux add a udev rule for Android phones (the android-sdk-platform-tools-common package has one), then unplug the phone and plug it back in.';
/** A real phone adb sees: listed by its maker and model with a generic frame. Nothing is run on one that isn't authorized. */
async function physicalDevice(deps: ProbeDeps, adb: string, entry: AdbEntry): Promise<DeviceInfo | null> {
  const reported = entry.model?.replace(/_/g, ' ');
  if (entry.state === 'unauthorized' || entry.state === 'no permissions' || entry.state === 'authorizing') {
    const name = reported ?? `Android phone ${entry.serial}`;
    const frame = androidFrame({}, name);
    return {id: entry.serial, name, platform: 'android', osVersion: 'Android', formFactor: formOf(frame, name), frame, state: 'unauthorized', physical: true, fix: entry.state === 'no permissions' ? NO_PERMISSION_FIX : USB_DEBUGGING_FIX};
  }
  if (entry.state !== 'device') return null;
  const [model, maker, release, booted] = await Promise.all(['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'sys.boot_completed'].map(name => getprop(deps, adb, entry.serial, name)));
  const base = (model || reported || 'Android phone').slice(0, 80);
  const brand = maker ? maker.charAt(0).toUpperCase() + maker.slice(1) : '';
  const name = brand && !base.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${base}` : base;
  const ready = booted === '1';
  const frame = androidFrame({}, name, ready ? await reportedCutout(deps, adb, entry.serial) : undefined);
  return {id: entry.serial, name, platform: 'android', osVersion: release ? `Android ${release}` : 'Android', formFactor: formOf(frame, name), frame, state: ready ? 'booted' : 'booting', physical: true};
}
export async function listAndroid(deps: ProbeDeps): Promise<DeviceInfo[]> {
  const tools = androidTools(deps);
  const [adbOut, avdOut] = await Promise.all([
    deps.run(tools.adb, ['devices', '-l'], {timeoutMs: 10_000}).catch(() => ''),
    // The emulator is the SDK's only; with adb alone (no SDK) only phones are listed.
    deps.exists(tools.emulator) ? deps.run(tools.emulator, ['-list-avds'], {timeoutMs: 15_000}).catch(() => '') : Promise.resolve(''),
  ]);
  const out: DeviceInfo[] = [];
  const named = new Set<string>();
  for (const entry of parseAdbDeviceList(adbOut)) {
    if (!entry.emulator) { const phone = await physicalDevice(deps, tools.adb, entry); if (phone) out.push(phone); continue; }
    const {serial, state} = entry;
    // `emu avd name` answers the AVD a running emulator was started from (first line), so it is not listed twice.
    const avd = (await deps.run(tools.adb, ['-s', serial, 'emu', 'avd', 'name'], {timeoutMs: 5000}).catch(() => '')).split(/\r?\n/)[0]?.trim() || serial;
    const release = state === 'device' ? await getprop(deps, tools.adb, serial, 'ro.build.version.release') : '';
    const booted = state === 'device' && await getprop(deps, tools.adb, serial, 'sys.boot_completed') === '1';
    const cutout = booted ? await reportedCutout(deps, tools.adb, serial) : undefined;
    named.add(avd);
    const frame = androidFrame(readAvdConfig(deps, avd), avd, cutout);
    out.push({id: serial, name: avd, platform: 'android', osVersion: release ? `Android ${release}` : 'Android', formFactor: formOf(frame, avd), frame, state: booted ? 'booted' : 'booting'});
  }
  for (const avd of parseAvdList(avdOut)) if (!named.has(avd)) {
    const frame = androidFrame(readAvdConfig(deps, avd), avd);
    out.push({id: `avd:${avd}`, name: avd, platform: 'android', osVersion: 'Android', formFactor: formOf(frame, avd), frame, state: 'shutdown'});
  }
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

// --- Installed apps (agent tools) ---------------------------------------------------------------------------------

export interface DeviceApp {id: string; name: string; user: boolean}
/** An app id that reaches simctl or adb as an argument: a bundle id or package name, never a flag or a path. */
export const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** `xcrun simctl listapps <udid>` (an old-style plist): bundle id, display name and whether the user installed it. */
export function parseSimctlApps(text: string): DeviceApp[] {
  const out: DeviceApp[] = [];
  for (const block of text.split(/\n\s{4}"?[A-Za-z0-9._-]+"?\s*=\s*\{/).slice(1)) {
    const field = (name: string) => new RegExp(`\\n\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\n]+));`).exec(`\n${block}`);
    const value = (name: string) => { const m = field(name); return (m?.[1] ?? m?.[2])?.trim(); };
    const id = value('CFBundleIdentifier');
    if (!id || !APP_ID.test(id)) continue;
    out.push({id, name: value('CFBundleDisplayName') || value('CFBundleName') || id, user: value('ApplicationType') === 'User'});
  }
  return sortApps(out);
}
/** `adb shell pm list packages [-3]`: one `package:<name>` per line. */
export function parseAdbPackages(stdout: string, user: boolean): DeviceApp[] {
  return stdout.split(/\r?\n/).map(line => /^package:([A-Za-z0-9._]+)\s*$/.exec(line.trim())?.[1]).filter((id): id is string => !!id && APP_ID.test(id)).map(id => ({id, name: id, user}));
}
/** The user's own apps first, then by name. */
export const sortApps = (apps: DeviceApp[]): DeviceApp[] => apps.sort((a, b) => Number(b.user) - Number(a.user) || a.name.localeCompare(b.name));
