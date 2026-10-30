/**
 * Devices (#363): iOS Simulators and Android Emulators shown and driven inside Muster.
 *
 * Main owns everything: the pinned Expo Device Hub helper (downloaded on first enable, bound to 127.0.0.1 with a
 * per-launch bearer token that never leaves main), discovery, boot/stop, the live streams and input. The renderer only
 * sees these commands, the events below, and frames pushed over a dedicated IPC channel. Agents reach devices through
 * the muster_device MCP tools, which exist only while the separate "Let agents use devices" setting is on.
 */
import type {FrameSpec} from './device-frames.ts';
export type DevicePlatform = 'ios' | 'android';
/** Body shape for the frame and the 3D model; derived from the simulator type or the AVD profile. */
export type DeviceFormFactor = 'phone' | 'tablet' | 'foldable';
export type DeviceState = 'booted' | 'shutdown' | 'booting' | 'shutting-down';
export interface DeviceInfo {
  /** iOS: simulator UDID. Android: emulator serial once running (emulator-5554), else `avd:<name>`. */
  id: string;
  name: string;
  platform: DevicePlatform;
  /** "iOS 26.0", "Android 16". */
  osVersion: string;
  state: DeviceState;
  formFactor: DeviceFormFactor;
  /** How the device looks (flat and 3D), from its simctl device type or AVD profile (shared/device-frames.ts). */
  frame?: FrameSpec;
}
export interface PlatformCheck {
  available: boolean;
  /** Plain-English reason when unavailable ("Xcode is not installed."). */
  reason?: string;
  /** Numbered fix steps shown under the reason. */
  fix?: string[];
  /** What was found ("Xcode 26.1", "Android SDK at ~/Library/Android/sdk"). */
  detail?: string;
}
export type DeviceHelperState = 'absent' | 'installing' | 'installed' | 'failed';
export interface DeviceHelperStatus {
  state: DeviceHelperState;
  /** The pinned Expo Device Hub version Muster installs and runs. */
  version: string;
  /** Approximate download size, shown before the user agrees to install. */
  downloadMB: number;
  progress?: string;
  error?: string;
  /** Whether the helper process is running now (it starts on demand and stops when nothing needs it). */
  running: boolean;
}
export interface DeviceSetup {
  enabled: boolean;
  /** Separate opt-in: agents get the device_* tools only while this is on. */
  agentControl: boolean;
  helper: DeviceHelperStatus;
  ios: PlatformCheck;
  android: PlatformCheck;
  /** Node.js runs the helper and npm installs it. */
  node: PlatformCheck;
  /** Realistic 3D models: downloaded on demand from apple.com, converted and cached on this computer (default on). */
  appleModels: boolean;
  models: {id: 'iphone' | 'ipad'; label: string; state: 'absent' | 'downloading' | 'ready' | 'converted' | 'failed'; error?: string}[];
  /** The desktop platform: iOS is hidden (with a note) anywhere but macOS. */
  host: 'darwin' | 'win32' | 'linux';
}
export interface DeviceList { devices: DeviceInfo[]; errors: string[]; checkedAt: number }
export type DeviceSessionState = 'starting' | 'live' | 'reconnecting' | 'error';
export type DeviceOrientation = 'portrait' | 'landscape_left' | 'portrait_upside_down' | 'landscape_right';
export interface DeviceScreen { width: number; height: number; orientation: DeviceOrientation }
export interface DeviceRect {x: number; y: number; w: number; h: number}
/**
 * A real device frame read at runtime from the user's own tools (main/devices/chrome.ts): Xcode's DeviceKit chrome for
 * a simulator, the AVD's skin from the Android SDK for an emulator. Never bundled or downloaded; images travel in memory.
 * Units are the chrome's own (points or skin pixels); the renderer scales the whole thing.
 */
export interface DeviceChrome {
  source: 'xcode' | 'android-skin';
  /** Where it came from, for diagnostics ("DeviceKit phone11", "Android SDK skin pixel_6 (Apache-2.0)"). */
  detail: string;
  width: number; height: number;
  /** The frame picture and where it sits. */
  image: {rect: DeviceRect; dataUrl: string};
  /** Where the live picture goes, with its corner radii (top-left, top-right, bottom-right, bottom-left). */
  screen: DeviceRect & {radii: [number, number, number, number]};
  /** An alpha mask for the display (Android skins that ship one). */
  mask?: string;
  /** Hardware buttons drawn as separate images (iOS), under or over the frame. */
  buttons: {rect: DeviceRect; dataUrl: string; onTop: boolean}[];
}
/** One live device view. Opened by the user (a sidebar tab) or by an agent (device_open, tied to its chat). */
export interface DeviceSession {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
  formFactor: DeviceFormFactor;
  frame?: FrameSpec;
  /** The chat whose agent opened it; absent for a session the user opened. */
  chatId?: string;
  openedBy: 'user' | 'agent';
  /** Who may send input. Taking control pauses the agent's taps and typing on this device. */
  control: 'agent' | 'user';
  state: DeviceSessionState;
  error?: string;
  screen?: DeviceScreen;
  /** Whether touches and keys can reach the device right now. */
  inputReady: boolean;
  openedAt: number;
  lastFrameAt?: number;
}
export type DeviceButton = 'home' | 'power' | 'appSwitcher' | 'back' | 'volumeUp' | 'volumeDown';
export type DeviceInput =
  | { kind: 'touch'; phase: 'begin' | 'move' | 'end'; x: number; y: number }
  | { kind: 'key'; phase: 'down' | 'up'; code: string; key: string }
  | { kind: 'text'; text: string };
/** A frame pushed to the renderer on DEVICE_FRAME_CHANNEL. JPEG frames are whole pictures; H.264 is an access unit. */
export interface DeviceFrame { deviceId: string; codec: 'jpeg' | 'h264'; key: boolean; data: Uint8Array; pts?: number; /** The emulator's encoder restarted: rebuild the decoder from the next keyframe. */ reset?: boolean;
  /** H.264 framing: Annex-B start codes (Android) or AVCC length prefixes with a separate description (iOS). */ format?: 'annexb' | 'avcc';
  /** An avcC decoder description (iOS): configure the decoder from it, then decode the AVCC frames that follow. */ config?: boolean }
/** window.musterDevices in the desktop app (absent in a browser host). */
export interface DeviceBridge { onFrame(listener: (frame: DeviceFrame) => void): () => void; ack(deviceId: string): void; input(deviceId: string, input: DeviceInput): void }

export interface DeviceCommands {
  'devices.setup': { input: undefined; output: DeviceSetup };
  /** Turning devices off stops Muster's helper and every session; the user's simulators keep running. */
  'devices.configure': { input: { enabled?: boolean; agentControl?: boolean; appleModels?: boolean }; output: DeviceSetup };
  /** Downloads and installs the pinned helper (npm ci of a lockfile shipped with the app, scripts disabled). */
  'devices.installHelper': { input: undefined; output: DeviceSetup };
  'devices.list': { input: { refresh?: boolean } | undefined; output: DeviceList };
  'devices.boot': { input: { id: string }; output: DeviceInfo };
  'devices.shutdown': { input: { id: string }; output: void };
  /** Starts (booting when needed) or focuses a live session. */
  'devices.open': { input: { id: string }; output: DeviceSession };
  'devices.close': { input: { id: string }; output: void };
  'devices.sessions': { input: undefined; output: DeviceSession[] };
  /** A viewer (tab, PiP card) on screen or not; frames flow only while one is active and the window is in front. */
  'devices.view': { input: { id: string; viewer: string; active: boolean }; output: void };
  'devices.button': { input: { id: string; button: DeviceButton }; output: void };
  'devices.rotate': { input: { id: string }; output: void };
  'devices.screenshot': { input: { id: string }; output: { dataUrl: string; width: number; height: number } };
  /** Taking control pauses agent input on the device; 'agent' hands it back. */
  'devices.control': { input: { id: string; owner: 'agent' | 'user' }; output: DeviceSession };
  /** This window cannot decode the simulator's H.264 (no WebCodecs, or its profile is unsupported): stream MJPEG instead. */
  'devices.streamFallback': { input: { id: string }; output: void };
  /** The device's real frame from the user's own Xcode or Android SDK, or null (the parametric frame is used). */
  'devices.chrome': { input: { id: string }; output: DeviceChrome | null };
  /** A realistic 3D model: the cached conversion, or the verified apple.com download for the renderer to convert. */
  'devices.model': { input: { id: 'iphone' | 'ipad' }; output: { id: string; bodyNode: string; screenNode: string; glb?: Uint8Array; usdz?: Uint8Array } };
  'devices.modelStore': { input: { id: 'iphone' | 'ipad'; glb: Uint8Array }; output: void };
  /** The device's current settings, read back from simctl or adb (#809). Unreadable values are left out. */
  'devices.detail': { input: { id: string }; output: DeviceDetail };
  /** Runs one typed setting change on a running device, then reads the settings back (#809). */
  'devices.action': { input: { id: string; action: DeviceAction }; output: DeviceDetail };
}
export type DeviceEvent =
  | { type: 'deviceSetup'; setup: DeviceSetup }
  | { type: 'deviceList'; list: DeviceList }
  | { type: 'deviceSessions'; sessions: DeviceSession[] };
export const DEVICE_COMMANDS = {'devices.setup': true, 'devices.configure': true, 'devices.installHelper': true, 'devices.list': true, 'devices.boot': true, 'devices.shutdown': true, 'devices.open': true, 'devices.close': true, 'devices.sessions': true, 'devices.view': true, 'devices.button': true, 'devices.rotate': true, 'devices.screenshot': true, 'devices.control': true, 'devices.streamFallback': true, 'devices.chrome': true, 'devices.model': true, 'devices.modelStore': true, 'devices.detail': true, 'devices.action': true} as const satisfies Record<keyof DeviceCommands, true>;

/** IPC: main → renderer frames, renderer → main frame acknowledgements (flow control) and input. */
export const DEVICE_FRAME_CHANNEL = 'muster:device-frame';
export const DEVICE_ACK_CHANNEL = 'muster:device-ack';
export const DEVICE_INPUT_CHANNEL = 'muster:device-input';
export const DEVICE_MCP = 'muster_device';
export const DEVICE_MCP_LAUNCHER_ENV = 'MUSTER_DEVICE_MCP_LAUNCHER';
export const DEVICE_NOTE = `Devices: this computer's iOS Simulators and Android Emulators are available through the ${DEVICE_MCP} MCP tools (device_list, device_open, device_screenshot, device_tap, device_type, device_apps, device_launch_app, device_button, device_close). Prefer them over raw simctl or adb for looking at and driving a device: device_open shows the session to the user live, then screenshot, tap at pixel coordinates of that screenshot, and screenshot again to check. To start an app, find its id with device_apps and use device_launch_app; device_button presses home, back (Android) or the app switcher. If a tool says the user has control, stop and wait.`;

const DEVICE_ID = /^(?:[A-Fa-f0-9-]{8,64}|emulator-\d{2,5}|avd:[A-Za-z0-9._-]{1,128}|[A-Za-z0-9._:-]{1,128})$/;
/** Device ids reach simctl and adb as arguments: only plain identifiers, never flags or paths. */
export function deviceId(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_ID.test(value) || value.startsWith('-')) throw new Error('Invalid device id.');
  return value;
}
export const DEVICE_BUTTONS: readonly DeviceButton[] = ['home', 'power', 'appSwitcher', 'back', 'volumeUp', 'volumeDown'];
export function deviceButton(value: unknown): DeviceButton {
  if (typeof value !== 'string' || !(DEVICE_BUTTONS as readonly string[]).includes(value)) throw new Error('Unknown device button.');
  return value as DeviceButton;
}
/** Validates renderer input before it reaches a device; anything malformed is dropped, never forwarded. */
export function parseDeviceInput(value: unknown): DeviceInput | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
  if (input.kind === 'touch' && (input.phase === 'begin' || input.phase === 'move' || input.phase === 'end')) {
    const x = unit(input.x), y = unit(input.y);
    return x === null || y === null ? null : { kind: 'touch', phase: input.phase, x, y };
  }
  if (input.kind === 'key' && (input.phase === 'down' || input.phase === 'up') && typeof input.code === 'string' && typeof input.key === 'string' && input.code.length <= 32 && input.key.length <= 32) return { kind: 'key', phase: input.phase, code: input.code, key: input.key };
  if (input.kind === 'text' && typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 4000) return { kind: 'text', text: input.text };
  return null;
}
// --- Device settings (#809) ----------------------------------------------------------------------------------------
// Typed actions only: nothing free-form reaches simctl or adb. Shapes follow T3 Code's device contract (MIT, T3 Tools Inc.,
// packages/contracts/src/device.ts at fa4e4677c0ecc437aece2dcea39f76ef31414152), written as plain unions with a validator.
export type DeviceAppearance = 'light' | 'dark';
export type DeviceTextSize = 'small' | 'default' | 'large' | 'extra-large';
export type DeviceColorFilter = 'none' | 'grayscale' | 'red-green' | 'green-red' | 'blue-yellow';
export type DeviceToggle = 'reduceMotion' | 'increaseContrast' | 'reduceTransparency' | 'showBorders' | 'voiceOver' | 'networkEnabled';
export type DevicePermission = 'camera' | 'microphone' | 'photos' | 'contacts' | 'calendar' | 'reminders' | 'location' | 'notifications' | 'motion' | 'media-library' | 'faceid';
export type DevicePermissionDecision = 'grant' | 'revoke' | 'reset';
export type DeviceAction =
  | { type: 'setAppearance'; value: DeviceAppearance }
  | { type: 'setTextSize'; value: DeviceTextSize }
  | { type: 'setToggle'; setting: DeviceToggle; value: boolean }
  | { type: 'setLiquidGlass'; value: 'clear' | 'tinted' }
  | { type: 'setColorFilter'; value: DeviceColorFilter }
  | { type: 'setOrientation'; value: DeviceOrientation }
  | { type: 'rotate' }
  | { type: 'setLocation'; latitude: number; longitude: number }
  | { type: 'clearLocation' }
  | { type: 'setPermission'; appId: string; permission: DevicePermission; decision: DevicePermissionDecision }
  | { type: 'openUrl'; url: string }
  | { type: 'launchApp'; appId: string }
  | { type: 'terminateApp'; appId: string }
  | { type: 'sendPush'; appId: string; payload: string | Record<string, unknown> }
  | { type: 'shake' };
export type DeviceActionType = DeviceAction['type'];
/** Settings as read back from the device. A key that could not be read is absent (unknown), never guessed. */
export interface DeviceSettingValues {
  appearance?: DeviceAppearance; textSize?: DeviceTextSize;
  reduceMotion?: boolean; increaseContrast?: boolean; reduceTransparency?: boolean; showBorders?: boolean; voiceOver?: boolean; networkEnabled?: boolean;
  liquidGlass?: 'clear' | 'tinted'; colorFilter?: DeviceColorFilter;
}
export interface DeviceDetail { deviceId: string; platform: DevicePlatform; settings: DeviceSettingValues; foregroundApp: string | null; readAt: number }
export const DEVICE_APPEARANCES: readonly DeviceAppearance[] = ['light', 'dark'];
export const DEVICE_TEXT_SIZES: readonly DeviceTextSize[] = ['small', 'default', 'large', 'extra-large'];
export const DEVICE_COLOR_FILTERS: readonly DeviceColorFilter[] = ['none', 'grayscale', 'red-green', 'green-red', 'blue-yellow'];
export const DEVICE_TOGGLES: readonly DeviceToggle[] = ['reduceMotion', 'increaseContrast', 'reduceTransparency', 'showBorders', 'voiceOver', 'networkEnabled'];
export const DEVICE_PERMISSIONS: readonly DevicePermission[] = ['camera', 'microphone', 'photos', 'contacts', 'calendar', 'reminders', 'location', 'notifications', 'motion', 'media-library', 'faceid'];
const ORIENTATION_VALUES: readonly DeviceOrientation[] = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'];
/** What each platform can do. Anything else is refused with a plain "not supported" (never a silent no-op). */
export const DEVICE_ACTION_SUPPORT: Record<DevicePlatform, {actions: readonly DeviceActionType[]; toggles: readonly DeviceToggle[]; permissions: readonly DevicePermission[]}> = {
  ios: {actions: ['setAppearance', 'setTextSize', 'setToggle', 'setLiquidGlass', 'setColorFilter', 'rotate', 'setLocation', 'clearLocation', 'setPermission', 'openUrl', 'launchApp', 'terminateApp', 'sendPush'],
    toggles: ['reduceMotion', 'increaseContrast', 'reduceTransparency', 'showBorders', 'voiceOver'], permissions: DEVICE_PERMISSIONS},
  android: {actions: ['setAppearance', 'setTextSize', 'setToggle', 'setOrientation', 'rotate', 'setLocation', 'setPermission', 'openUrl', 'launchApp', 'terminateApp'],
    toggles: ['reduceMotion', 'networkEnabled'], permissions: ['camera', 'microphone', 'photos', 'contacts', 'calendar', 'location', 'notifications', 'motion']},
};
/** Why an action is refused on a platform, in plain words; null when it is supported. */
export function deviceActionUnsupported(platform: DevicePlatform, action: DeviceAction): string | null {
  const support = DEVICE_ACTION_SUPPORT[platform], os = platform === 'ios' ? 'the iOS Simulator' : 'the Android Emulator';
  if (action.type === 'shake') return `Shake is not supported on ${os}: neither ${platform === 'ios' ? 'simctl' : 'adb'} nor the device helper can shake the device.`;
  if (action.type === 'setOrientation' && platform === 'ios') return 'Setting an exact orientation is not supported on the iOS Simulator; use rotate, which turns it a quarter clockwise.';
  if (action.type === 'clearLocation' && platform === 'android') return 'The Android Emulator cannot clear its location; set another location instead.';
  if (action.type === 'sendPush' && platform === 'android') return 'Sending a push notification is not supported on the Android Emulator (it needs Firebase Cloud Messaging); it works on the iOS Simulator.';
  if (!support.actions.includes(action.type)) return `${action.type} is not supported on ${os}.`;
  if (action.type === 'setToggle' && !support.toggles.includes(action.setting)) return `The ${action.setting} setting is not supported on ${os}.`;
  if (action.type === 'setPermission' && !support.permissions.includes(action.permission)) return `The ${action.permission} permission is not supported on ${os}.`;
  return null;
}
const DEVICE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const oneOf = <T extends string>(list: readonly T[], value: unknown, what: string): T => {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) throw new Error(`Choose ${what}: ${list.join(', ')}.`);
  return value as T;
};
const appIdOf = (value: unknown): string => {
  if (typeof value !== 'string' || !DEVICE_APP_ID.test(value)) throw new Error('Pass the app\'s bundle id (iOS) or package name (Android).');
  return value;
};
/** Validates a settings action from the renderer or an agent; anything malformed is refused with the reason. */
export function parseDeviceAction(value: unknown): DeviceAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pass a device action.');
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case 'setAppearance': return {type: 'setAppearance', value: oneOf(DEVICE_APPEARANCES, input.value, 'an appearance')};
    case 'setTextSize': return {type: 'setTextSize', value: oneOf(DEVICE_TEXT_SIZES, input.value, 'a text size')};
    case 'setToggle': {
      const setting = oneOf(DEVICE_TOGGLES, input.setting, 'a setting');
      if (typeof input.value !== 'boolean') throw new Error('Pass value true (on) or false (off).');
      return {type: 'setToggle', setting, value: input.value};
    }
    case 'setLiquidGlass': return {type: 'setLiquidGlass', value: oneOf(['clear', 'tinted'] as const, input.value, 'a Liquid Glass look')};
    case 'setColorFilter': return {type: 'setColorFilter', value: oneOf(DEVICE_COLOR_FILTERS, input.value, 'a colour filter')};
    case 'setOrientation': return {type: 'setOrientation', value: oneOf(ORIENTATION_VALUES, input.value, 'an orientation')};
    case 'rotate': return {type: 'rotate'};
    case 'shake': return {type: 'shake'};
    case 'clearLocation': return {type: 'clearLocation'};
    case 'setLocation': {
      const latitude = input.latitude, longitude = input.longitude;
      if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error('Latitude must be a number from -90 to 90.');
      if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Longitude must be a number from -180 to 180.');
      return {type: 'setLocation', latitude, longitude};
    }
    case 'setPermission': return {type: 'setPermission', appId: appIdOf(input.appId), permission: oneOf(DEVICE_PERMISSIONS, input.permission, 'a permission'), decision: oneOf(['grant', 'revoke', 'reset'] as const, input.decision, 'grant, revoke or reset')};
    case 'openUrl': {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      // Any scheme (deep links), but one argument: no control characters, no leading dash, bounded length.
      if (!/^[A-Za-z][A-Za-z0-9+.-]{0,31}:\S/.test(url) || url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) throw new Error('Pass a URL with its scheme, such as https://example.com or myapp://path (up to 2048 characters).');
      return {type: 'openUrl', url};
    }
    case 'launchApp': return {type: 'launchApp', appId: appIdOf(input.appId)};
    case 'terminateApp': return {type: 'terminateApp', appId: appIdOf(input.appId)};
    case 'sendPush': {
      const appId = appIdOf(input.appId), payload = input.payload;
      if (typeof payload === 'string') { if (!payload.trim() || payload.length > 1000) throw new Error('A push message must be 1 to 1000 characters.'); return {type: 'sendPush', appId, payload}; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Pass the push payload as a message or a JSON object (an APNs payload such as {"aps":{"alert":"Hi"}}).');
      // APNs caps a payload at 4 KB.
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 4096) throw new Error('A push payload must be 4 KB or less.');
      return {type: 'sendPush', appId, payload: payload as Record<string, unknown>};
    }
    default: throw new Error(`Unknown device action ${typeof input.type === 'string' ? input.type.slice(0, 40) : ''}.`.replace(' .', '.'));
  }
}
/** A device's name for a tab or a card: "iPhone 17 Pro", or the AVD name with underscores as spaces. */
export const deviceTitle = (device: Pick<DeviceInfo, 'name'>): string => device.name.replace(/_/g, ' ');
declare global { interface Window { musterDevices?: DeviceBridge } }
