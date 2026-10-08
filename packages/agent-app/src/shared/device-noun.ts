/**
 * What to call the computer Muster runs on (#335): "This Mac" on macOS, "This PC" on Windows,
 * "This computer" on Linux. Every user-facing string that names the local machine goes through here, so a
 * Windows user never reads "Mac". Works in the renderer (navigator), the main process and the runtime
 * (process.platform). Nothing in this file changes behaviour; it only picks words.
 */
export type DevicePlatform = 'darwin' | 'win32' | 'linux';

export interface DeviceNoun {
  /** "This Mac" / "This PC" / "This computer" (start of a sentence or a label). */
  title: string;
  /** "this Mac" / "this PC" / "this computer". */
  lower: string;
  /** "your Mac" / "your PC" / "your computer". */
  your: string;
  /** "the Mac" / "the PC" / "the computer". */
  the: string;
  /** "Mac" / "PC" / "computer" with no article. */
  bare: string;
  /** "this Mac's" / "this PC's" / "this computer's". */
  possessive: string;
  /** "macOS" / "Windows" / "Linux". */
  os: string;
  platform: DevicePlatform;
  /** What shows a file in its folder: "Finder" / "File Explorer" / "your file manager". */
  fileManager: string;
  /** Where encrypted keys are kept (Electron safeStorage): "the macOS Keychain" / "the Windows credential store" / "the system keyring". */
  secretStore: string;
  /** The same without the article, for a label: "Keychain" / "Windows credential store" / "system keyring". */
  secretStoreShort: string;
}

const NOUNS: Record<DevicePlatform, string> = { darwin: 'Mac', win32: 'PC', linux: 'computer' };
const OS_NAMES: Record<DevicePlatform, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const FILE_MANAGERS: Record<DevicePlatform, string> = { darwin: 'Finder', win32: 'File Explorer', linux: 'your file manager' };
const SECRET_STORES: Record<DevicePlatform, string> = { darwin: 'the macOS Keychain', win32: 'the Windows credential store', linux: 'the system keyring' };

/** Maps any platform string (process.platform, navigator.platform, a user agent) to one of the three. Unknown systems read as a generic computer. */
export function normalizePlatform(value: string | undefined | null): DevicePlatform {
  const v = (value ?? '').toLowerCase();
  if (v === 'darwin' || v.includes('mac') || v.includes('iphone') || v.includes('ipad')) return 'darwin';
  if (v === 'win32' || v.includes('win')) return 'win32';
  return 'linux';
}

export function deviceNoun(platform?: string | null): DeviceNoun {
  const p = normalizePlatform(platform ?? detectDevicePlatform());
  const bare = NOUNS[p];
  const article = (word: string) => `${word} ${bare}`;
  return {
    title: article('This'), lower: article('this'), your: article('your'), the: article('the'), bare,
    possessive: `${article('this')}'s`, os: OS_NAMES[p], platform: p, fileManager: FILE_MANAGERS[p], secretStore: SECRET_STORES[p], secretStoreShort: SECRET_STORES[p].replace(/^the (macOS )?/, ''),
  };
}

let override: DevicePlatform | null = null;
/** Pins the platform the helper reports (tests and headless screenshots); null goes back to detection. */
export function setDevicePlatform(platform: string | null): void { override = platform === null ? null : normalizePlatform(platform); }

/** The platform this code is running on, honouring setDevicePlatform and MUSTER_DEVICE_PLATFORM. */
export function detectDevicePlatform(): DevicePlatform {
  if (override) return override;
  const proc = (globalThis as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
  const pinned = proc?.env?.MUSTER_DEVICE_PLATFORM;
  if (pinned) return normalizePlatform(pinned);
  if (proc?.platform) return normalizePlatform(proc.platform);
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  return normalizePlatform(nav?.platform || nav?.userAgent);
}

/** The noun forms for the computer we are running on. */
export const device = (): DeviceNoun => deviceNoun(detectDevicePlatform());
