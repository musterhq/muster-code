/**
 * Device settings (#809): typed actions on a running simulator or emulator, and the settings read back afterwards.
 * Only fixed argv reaches simctl, adb or the helper's own tools; values come from the validated DeviceAction union
 * (shared/device-protocol.ts), so no free text is ever run.
 *
 * Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), apps/server/src/device/DeviceActions.ts at
 * fa4e4677c0ecc437aece2dcea39f76ef31414152, onto Muster's plain `run` (which rejects on a non-zero exit) instead of
 * Effect. Muster's changes: a push payload goes through a 0600 temp file (Muster's run has no stdin), rotate uses the
 * live session, and actions the platform cannot do are refused in plain words, never skipped silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import {deviceActionUnsupported, type DeviceAction, type DeviceColorFilter, type DeviceOrientation, type DevicePlatform, type DeviceSettingValues, type DeviceTextSize} from '../../shared/device-protocol.ts';
import {errorLine, type Run} from './discovery.ts';

export interface ActionHost {
  platform: DevicePlatform;
  deviceId: string;
  run: Run;
  adb: string;
  /** Node.js, which runs the helper's serve-sim CLI (notification permission on iOS). */
  node?: string;
  /** The helper's tools inside the pinned install; absent when missing. */
  helpers: {axSettings?: string; serveSim?: string};
  /** A private folder for short-lived files (a push payload). */
  tmpDir: string;
  /** Turns the live session a quarter clockwise. */
  rotate(): Promise<void>;
}
export class DeviceActionError extends Error {
  constructor(message: string, readonly reason: 'unsupported' | 'helper_missing' | 'command_failed') { super(message); this.name = 'DeviceActionError'; }
}

const IOS_TEXT_SIZES: Record<DeviceTextSize, string> = {small: 'small', default: 'large', large: 'extra-extra-large', 'extra-large': 'accessibility-large'};
const ANDROID_TEXT_SIZES: Record<DeviceTextSize, string> = {small: '0.85', default: '1.0', large: '1.15', 'extra-large': '1.3'};
export function textSizeFromIos(category: string): DeviceTextSize {
  const entry = (Object.entries(IOS_TEXT_SIZES) as [DeviceTextSize, string][]).find(([, value]) => value === category);
  if (entry) return entry[0];
  if (category.startsWith('accessibility')) return 'extra-large';
  if (category.includes('extra')) return 'large';
  return category === 'extra-small' || category === 'small' || category === 'medium' ? 'small' : 'default';
}
export function textSizeFromAndroid(scale: number): DeviceTextSize {
  if (scale <= 0.9) return 'small';
  if (scale >= 1.25) return 'extra-large';
  if (scale >= 1.1) return 'large';
  return 'default';
}
const IOS_TOGGLE_OPTIONS: Record<string, string> = {reduceMotion: 'reduce-motion', reduceTransparency: 'reduce-transparency', showBorders: 'show-borders', voiceOver: 'voiceover'};
const IOS_TCC_SERVICES: Record<string, string> = {camera: 'camera', microphone: 'microphone', photos: 'photos', contacts: 'contacts', calendar: 'calendar', reminders: 'reminders', location: 'location', motion: 'motion', 'media-library': 'media-library', faceid: 'faceid'};
const ANDROID_PERMISSIONS: Record<string, readonly string[]> = {
  camera: ['android.permission.CAMERA'],
  microphone: ['android.permission.RECORD_AUDIO'],
  photos: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE'],
  contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
  location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  motion: ['android.permission.ACTIVITY_RECOGNITION'],
};
// Android numbers rotations from the display's natural orientation and the emulator's accelerometer reports gravity in
// that same frame, so both tables are keyed by the orientation a portrait-native device shows at each rotation.
const ANDROID_GRAVITY: Record<DeviceOrientation, string> = {portrait: '0:9.81:0', landscape_left: '9.81:0:0', portrait_upside_down: '0:-9.81:0', landscape_right: '-9.81:0:0'};
const ANDROID_ROTATION: Record<DeviceOrientation, string> = {portrait: '0', landscape_left: '1', portrait_upside_down: '2', landscape_right: '3'};
// A landscape-native tablet sits a quarter turn further along: its portrait is rotation 3 and its landscape rotation 0.
const ANDROID_LANDSCAPE_NATIVE: Record<DeviceOrientation, DeviceOrientation> = {portrait: 'landscape_right', landscape_left: 'portrait', portrait_upside_down: 'landscape_left', landscape_right: 'portrait_upside_down'};
/** `wm size` reports the natural size; an `Override size:` line, printed after `Physical size:`, is what the window manager uses. */
export function isLandscapeNative(wmSize: string | undefined): boolean {
  const size = wmSize ? [...wmSize.matchAll(/size: (\d+)x(\d+)/g)].at(-1) : undefined;
  return size !== undefined && Number(size[1]) > Number(size[2]);
}
/** adb shell joins its arguments without escaping before the device's shell parses them. */
export const androidShellWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const failed = (operation: string) => (error: unknown): never => { throw new DeviceActionError(`Could not change ${operation}: ${errorLine(error)}`, 'command_failed'); };

/** Runs one action. Unsupported ones throw a DeviceActionError with the reason before anything runs. */
export async function runDeviceAction(host: ActionHost, action: DeviceAction): Promise<void> {
  const unsupported = deviceActionUnsupported(host.platform, action);
  if (unsupported) throw new DeviceActionError(unsupported, 'unsupported');
  if (action.type === 'rotate') { await host.rotate(); return; }
  if (host.platform === 'ios') await runIos(host, action);
  else await runAndroid(host, action);
}

const simctl = (host: ActionHost, args: string[], operation: string) =>
  host.run('/usr/bin/xcrun', ['simctl', args[0]!, host.deviceId, ...args.slice(1)], {timeoutMs: 60_000}).catch(failed(operation));
function axSettings(host: ActionHost, args: string[], operation: string): Promise<string> {
  if (!host.helpers.axSettings) throw new DeviceActionError('This setting needs a part of the device helper that is missing. Reinstall the helper in Settings › Integrations › Devices.', 'helper_missing');
  return host.run('/usr/bin/xcrun', ['simctl', 'spawn', host.deviceId, host.helpers.axSettings, ...args], {timeoutMs: 30_000}).catch(failed(operation));
}

async function runIos(host: ActionHost, action: DeviceAction): Promise<void> {
  switch (action.type) {
    case 'setAppearance': await simctl(host, ['ui', 'appearance', action.value], 'the appearance'); return;
    case 'setTextSize': await simctl(host, ['ui', 'content_size', IOS_TEXT_SIZES[action.value]], 'the text size'); return;
    case 'setToggle':
      if (action.setting === 'increaseContrast') { await simctl(host, ['ui', 'increase_contrast', action.value ? 'enabled' : 'disabled'], 'Increase Contrast'); return; }
      await axSettings(host, ['set', IOS_TOGGLE_OPTIONS[action.setting]!, action.value ? 'on' : 'off'], 'the accessibility setting'); return;
    case 'setLiquidGlass': await axSettings(host, ['set', 'liquid-glass', action.value], 'Liquid Glass'); return;
    case 'setColorFilter': await axSettings(host, ['set', 'color-filter', action.value], 'the colour filter'); return;
    case 'setLocation': await simctl(host, ['location', 'set', `${action.latitude},${action.longitude}`], 'the location'); return;
    case 'clearLocation': await simctl(host, ['location', 'clear'], 'the location'); return;
    case 'setPermission': {
      if (action.permission === 'notifications') {
        // simctl privacy has no notifications service; the helper's serve-sim CLI edits the BulletinBoard settings.
        if (!host.helpers.serveSim || !host.node) throw new DeviceActionError('Notification permission needs a part of the device helper that is missing. Reinstall the helper in Settings › Integrations › Devices.', 'helper_missing');
        await host.run(host.node, [host.helpers.serveSim, 'permissions', action.decision, 'notifications', action.appId, '-d', host.deviceId], {timeoutMs: 30_000}).catch(failed('the permission'));
        return;
      }
      await simctl(host, ['privacy', action.decision, IOS_TCC_SERVICES[action.permission]!, action.appId], 'the permission'); return;
    }
    case 'openUrl': await simctl(host, ['openurl', action.url], 'the URL'); return;
    case 'launchApp': await simctl(host, ['launch', action.appId], 'the app'); return;
    case 'terminateApp': await simctl(host, ['terminate', action.appId], 'the app'); return;
    case 'sendPush': {
      const payload = typeof action.payload === 'string' ? {aps: {alert: action.payload}} : action.payload;
      fs.mkdirSync(host.tmpDir, {recursive: true, mode: 0o700});
      const dir = fs.mkdtempSync(path.join(host.tmpDir, 'push-'));
      try {
        const file = path.join(dir, 'payload.apns');
        fs.writeFileSync(file, JSON.stringify(payload), {mode: 0o600});
        await simctl(host, ['push', action.appId, file], 'the push notification');
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
      return;
    }
    default: throw new DeviceActionError(`${action.type} is not supported on the iOS Simulator.`, 'unsupported');
  }
}

async function runAndroid(host: ActionHost, action: DeviceAction): Promise<void> {
  const adb = (args: string[], operation: string) => host.run(host.adb, ['-s', host.deviceId, ...args], {timeoutMs: 30_000}).catch(failed(operation));
  const shell = (args: string[], operation: string) => adb(['shell', ...args.map(androidShellWord)], operation);
  switch (action.type) {
    case 'setAppearance': await shell(['cmd', 'uimode', 'night', action.value === 'dark' ? 'yes' : 'no'], 'the appearance'); return;
    case 'setTextSize': await shell(['settings', 'put', 'system', 'font_scale', ANDROID_TEXT_SIZES[action.value]], 'the text size'); return;
    case 'setToggle':
      if (action.setting === 'networkEnabled') {
        const state = action.value ? 'enable' : 'disable';
        await shell(['svc', 'wifi', state], 'the network');
        await shell(['svc', 'data', state], 'the network');
        return;
      }
      if (action.setting === 'reduceMotion') {
        for (const key of ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']) await shell(['settings', 'put', 'global', key, action.value ? '0' : '1'], 'Remove animations');
        return;
      }
      throw new DeviceActionError(`The ${action.setting} setting is not supported on the Android Emulator.`, 'unsupported');
    case 'setOrientation': {
      const wmSize = await shell(['wm', 'size'], 'the orientation').catch(() => undefined);
      const rotation = isLandscapeNative(wmSize) ? ANDROID_LANDSCAPE_NATIVE[action.value] : action.value;
      // `user-rotation lock` only turns window content on recent images; the captured display stays put. Tilting the
      // emulator's accelerometer turns it for real, so that is used for an emulator.
      if (host.deviceId.startsWith('emulator-')) {
        await shell(['settings', 'put', 'system', 'accelerometer_rotation', '1'], 'the orientation');
        await shell(['cmd', 'window', 'user-rotation', 'free'], 'the orientation');
        await adb(['emu', 'sensor', 'set', 'acceleration', ANDROID_GRAVITY[rotation]], 'the orientation');
        return;
      }
      await shell(['cmd', 'window', 'user-rotation', 'lock', ANDROID_ROTATION[rotation]], 'the orientation');
      return;
    }
    case 'setLocation': await adb(['emu', 'geo', 'fix', String(action.longitude), String(action.latitude)], 'the location'); return;
    case 'setPermission': {
      const permissions = ANDROID_PERMISSIONS[action.permission];
      if (!permissions) throw new DeviceActionError(`The ${action.permission} permission is not supported on the Android Emulator.`, 'unsupported');
      // pm refuses a permission the app or image does not declare, and Photos lists both the Android 13 and the older
      // storage permission, so this fails only when none of them applied.
      const verb = action.decision === 'grant' ? 'grant' : 'revoke';
      const results = await Promise.allSettled(permissions.map(permission => shell(['pm', verb, action.appId, permission], 'the permission')));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure && !results.some(result => result.status === 'fulfilled')) throw failure.reason;
      return;
    }
    case 'openUrl': await shell(['am', 'start', '-a', 'android.intent.action.VIEW', '-d', action.url], 'the URL'); return;
    case 'launchApp': await shell(['monkey', '-p', action.appId, '-c', 'android.intent.category.LAUNCHER', '1'], 'the app'); return;
    case 'terminateApp': await shell(['am', 'force-stop', action.appId], 'the app'); return;
    default: throw new DeviceActionError(`${action.type} is not supported on the Android Emulator.`, 'unsupported');
  }
}

const quiet = (promise: Promise<string>) => promise.then(out => out.trim(), () => undefined);
const COLOR_FILTERS: readonly string[] = ['none', 'grayscale', 'red-green', 'green-red', 'blue-yellow'];
/** The settings as the device reports them now. Anything unreadable is left out instead of failing the read. */
export async function readDeviceSettings(host: Pick<ActionHost, 'platform' | 'deviceId' | 'run' | 'adb' | 'helpers'>): Promise<{settings: DeviceSettingValues; foregroundApp: string | null}> {
  if (host.platform === 'ios') {
    const ui = (option: string) => quiet(host.run('/usr/bin/xcrun', ['simctl', 'ui', host.deviceId, option], {timeoutMs: 20_000})).then(out => out?.toLowerCase());
    const ax = host.helpers.axSettings ? quiet(host.run('/usr/bin/xcrun', ['simctl', 'spawn', host.deviceId, host.helpers.axSettings, 'status'], {timeoutMs: 20_000})) : Promise.resolve(undefined);
    const [appearance, contentSize, contrast, axOut] = await Promise.all([ui('appearance'), ui('content_size'), ui('increase_contrast'), ax]);
    let status: Record<string, unknown> = {};
    try { const parsed = axOut ? JSON.parse(axOut) : {}; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) status = parsed; } catch {}
    const onOff = (value: unknown) => value === 'on' ? true : value === 'off' ? false : undefined;
    const settings: DeviceSettingValues = {};
    if (appearance === 'light' || appearance === 'dark') settings.appearance = appearance;
    if (contentSize) settings.textSize = textSizeFromIos(contentSize);
    if (contrast === 'enabled' || contrast === 'disabled') settings.increaseContrast = contrast === 'enabled';
    for (const [key, option] of [['reduceMotion', 'reduce-motion'], ['reduceTransparency', 'reduce-transparency'], ['showBorders', 'show-borders'], ['voiceOver', 'voiceover']] as const) {
      const value = onOff(status[option]);
      if (value !== undefined) settings[key] = value;
    }
    if (status['liquid-glass'] === 'clear' || status['liquid-glass'] === 'tinted') settings.liquidGlass = status['liquid-glass'];
    if (typeof status['color-filter'] === 'string' && COLOR_FILTERS.includes(status['color-filter'])) settings.colorFilter = status['color-filter'] as DeviceColorFilter;
    return {settings, foregroundApp: null};
  }
  const shell = (args: string[]) => quiet(host.run(host.adb, ['-s', host.deviceId, 'shell', ...args], {timeoutMs: 20_000}));
  const [night, fontScale, animator, wifi, focus] = await Promise.all([
    shell(['cmd', 'uimode', 'night']),
    shell(['settings', 'get', 'system', 'font_scale']),
    shell(['settings', 'get', 'global', 'animator_duration_scale']),
    shell(['settings', 'get', 'global', 'wifi_on']),
    // API 36 dropped focus from `dumpsys window windows`; the unfiltered dump still has it.
    shell(['dumpsys', 'window']),
  ]);
  const settings: DeviceSettingValues = {};
  if (night?.includes('yes')) settings.appearance = 'dark'; else if (night?.includes('no')) settings.appearance = 'light';
  const scale = fontScale && fontScale !== 'null' ? Number(fontScale) : Number.NaN;
  if (Number.isFinite(scale)) settings.textSize = textSizeFromAndroid(scale);
  if (animator !== undefined && animator !== 'null' && animator !== '' && Number.isFinite(Number(animator))) settings.reduceMotion = Number(animator) === 0;
  if (wifi === '1' || wifi === '0') settings.networkEnabled = wifi === '1';
  const focused = focus?.match(/m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ ]+)\//);
  return {settings, foregroundApp: focused ? focused[1]! : null};
}
