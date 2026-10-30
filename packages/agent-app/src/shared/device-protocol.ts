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
  /** The machine it runs on (#812): absent for this computer; a remote host's id (`ssh-…`), whose devices' ids start with `<hostId>:`. */
  hostId?: string;
  /** That host's name as the user gave it, shown beside the device ("on build-mac"). */
  hostLabel?: string;
}
/**
 * Where devices run (#812). `local` is this computer. `ssh` is a host from Settings › Environments › SSH hosts: Muster
 * installs the same pinned helper there (no sudo, in ~/.muster/device-host), starts it and forwards it to a loopback port
 * here. `cloud` is reserved for hosted devices (not built yet).
 */
export type DeviceHostKind = 'local' | 'ssh' | 'cloud';
export type DeviceHostState = 'off' | 'connecting' | 'installing' | 'starting' | 'ready' | 'reconnecting' | 'failed';
export interface DeviceHostSummary {
  /** `ssh-<12 hex>` for an SSH host. */
  id: string;
  kind: DeviceHostKind;
  label: string;
  /** user@host:port, for the settings row. */
  address?: string;
  /** The SSH host record this host uses (Settings › Environments). */
  sshHostId?: string;
  state: DeviceHostState;
  /** Plain-English status or the reason it failed. */
  detail?: string;
  /** What the host has, once probed: iOS needs a Mac with Xcode. */
  ios?: PlatformCheck;
  android?: PlatformCheck;
  /** The remote OS and Node.js, once probed ("darwin", "v22.11.0"). */
  os?: string;
  node?: string;
  /** The helper version running there (always the pinned one; anything else is refused). */
  helperVersion?: string;
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
  /** Remote device hosts (#812): every SSH host you have, with whether Muster uses it for devices. */
  hosts?: DeviceHostSummary[];
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
  /** The remote host it runs on (#812); absent for this computer. */
  hostId?: string;
  hostLabel?: string;
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
  /** Remote device hosts (#812): every SSH host with its device state. */
  'devices.hosts': { input: undefined; output: DeviceHostSummary[] };
  /** Use an SSH host for devices: install the pinned helper there if needed, start it, forward it and list its devices. */
  'devices.connectHost': { input: { sshHostId: string }; output: DeviceHostSummary };
  /** Stop using it: close its sessions, stop its helper and tunnel. Nothing of Muster's keeps running on the host. */
  'devices.disconnectHost': { input: { sshHostId: string }; output: DeviceHostSummary };
}
export type DeviceEvent =
  | { type: 'deviceSetup'; setup: DeviceSetup }
  | { type: 'deviceList'; list: DeviceList }
  | { type: 'deviceSessions'; sessions: DeviceSession[] };
export const DEVICE_COMMANDS = {'devices.setup': true, 'devices.configure': true, 'devices.installHelper': true, 'devices.list': true, 'devices.boot': true, 'devices.shutdown': true, 'devices.open': true, 'devices.close': true, 'devices.sessions': true, 'devices.view': true, 'devices.button': true, 'devices.rotate': true, 'devices.screenshot': true, 'devices.control': true, 'devices.streamFallback': true, 'devices.chrome': true, 'devices.model': true, 'devices.modelStore': true, 'devices.hosts': true, 'devices.connectHost': true, 'devices.disconnectHost': true} as const satisfies Record<keyof DeviceCommands, true>;

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
/** A device's name for a tab or a card: "iPhone 17 Pro", or the AVD name with underscores as spaces. */
export const deviceTitle = (device: Pick<DeviceInfo, 'name'>): string => device.name.replace(/_/g, ' ');
declare global { interface Window { musterDevices?: DeviceBridge } }
