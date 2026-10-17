/**
 * Real device frames read at runtime from the user's own tools (#363), never bundled, copied or downloaded by Muster:
 *
 * - iOS: Xcode's DeviceKit chrome, the frame Apple's Simulator draws. The device helper (serve-sim) reads the
 *   simulator's `.simdevicetype` profile and its `.devicechrome` bundle under /Library/Developer on this Mac and
 *   rasterises the chrome's PDFs; main fetches the parsed descriptor (`GET /grid/api`) and the allowlisted images
 *   (`GET /grid/api/devicekit-chrome`) from the loopback helper, read-only, and hands them to the renderer in memory.
 * - Android: the AVD's emulator skin in the user's Android SDK (`skins/<name>/layout` and its images; the SDK skins
 *   are Apache-2.0), read from disk by main.
 *
 * Anything missing, unexpected or landscape falls back to Muster's parametric frame (shared/device-frames.ts).
 */
import path from 'node:path';
import type {DeviceChrome, DeviceRect} from '../../shared/device-protocol.ts';

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const rect = (value: unknown): DeviceRect | null => {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const x = num(r?.x) ?? 0, y = num(r?.y) ?? 0, w = num(r?.width), h = num(r?.height);
  return w !== null && h !== null && w > 0 && h > 0 ? {x, y, w, h} : null;
};
const IMAGE_NAME = /^[A-Za-z0-9 ._()+-]{1,128}$/;

// --- iOS: the helper's DeviceKit descriptor ----------------------------------------------------------------------
export interface HubChrome {identifier: string; width: number; height: number; body: DeviceRect; screen: DeviceRect; radii: [number, number, number, number]; composite: string; buttons: {image: string; rect: DeviceRect; onTop: boolean}[]}
/** The chrome the helper describes for one simulator (from `GET /vendor/serve-sim/grid/api`), or null. */
export function parseHubChrome(json: unknown, udid: string): HubChrome | null {
  const root = json && typeof json === 'object' ? json as Record<string, unknown> : null;
  const lists = root ? Object.values(root).filter(Array.isArray) as unknown[][] : [];
  const entry = lists.flat().find(item => item && typeof item === 'object' && String((item as Record<string, unknown>).device ?? '').toUpperCase() === udid.toUpperCase()) as Record<string, unknown> | undefined;
  const chrome = entry?.chrome && typeof entry.chrome === 'object' ? entry.chrome as Record<string, unknown> : null;
  if (!chrome) return null;
  const identifier = typeof chrome.identifier === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(chrome.identifier) ? chrome.identifier : null;
  const composite = typeof chrome.compositeImage === 'string' && IMAGE_NAME.test(chrome.compositeImage) ? chrome.compositeImage : null;
  const frame = rect(chrome.frame), body = rect(chrome.body), screen = rect(chrome.screen);
  // Only composite chromes are drawn; sliced ones (nine-part images) fall back to the parametric frame.
  if (!identifier || !composite || !frame || !body || !screen) return null;
  const corners = chrome.screenCornerRadii && typeof chrome.screenCornerRadii === 'object' ? chrome.screenCornerRadii as Record<string, unknown> : {};
  const r = num(chrome.screenRadius) ?? 0;
  const radii: [number, number, number, number] = [num(corners.topLeft) ?? r, num(corners.topRight) ?? r, num(corners.bottomRight) ?? r, num(corners.bottomLeft) ?? r];
  const buttons = (Array.isArray(chrome.buttons) ? chrome.buttons : []).flatMap(item => {
    const b = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const image = typeof b.image === 'string' && IMAGE_NAME.test(b.image) ? b.image : null, r2 = rect(b.frame);
    return image && r2 ? [{image, rect: r2, onTop: b.onTop === true}] : [];
  });
  return {identifier, width: frame.w, height: frame.h, body, screen, radii, composite, buttons};
}

// --- Android: the emulator skin's layout file --------------------------------------------------------------------
export type SkinNode = {[key: string]: SkinNode | string};
/** The emulator skin `layout` format: `name { ... }` blocks and `key value` lines. */
type SkinToken = {open: string} | {close: true} | {key: string; value: string};
export function parseSkinLayout(text: string): SkinNode {
  const tokens = text.replace(/#[^\n]*/g, '').split('\n').flatMap((line): SkinToken[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const open = /^([A-Za-z0-9_.-]+)\s*\{$/.exec(trimmed);
    if (open) return [{open: open[1]!}];
    if (trimmed === '}') return [{close: true}];
    const pair = /^([A-Za-z0-9_.-]+)\s+(.+)$/.exec(trimmed);
    return pair ? [{key: pair[1]!, value: pair[2]!.trim()}] : [];
  });
  const root: SkinNode = {}, stack: SkinNode[] = [root];
  for (const token of tokens) {
    const top = stack[stack.length - 1]!;
    if ('open' in token) { const child: SkinNode = {}; top[token.open] = child; stack.push(child); }
    else if ('close' in token) { if (stack.length > 1) stack.pop(); }
    else top[token.key] = token.value;
  }
  return root;
}
const node = (value: SkinNode | string | undefined): SkinNode => value && typeof value === 'object' ? value : {};
const int = (value: SkinNode | string | undefined): number | null => typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : null;
export interface SkinChrome {width: number; height: number; background: string; screen: DeviceRect; mask?: string}
/** The portrait layout of a skin: its size, background image, where the display sits, and an optional display mask. */
export function skinPortrait(layout: SkinNode): SkinChrome | null {
  const parts = node(layout.parts), layouts = node(layout.layouts);
  const portraitLayout = node(layouts.portrait);
  const width = int(portraitLayout.width), height = int(portraitLayout.height);
  if (!width || !height) return null;
  // The layout places parts by name: the frame image part and the "device" (display) part.
  let frameAt = {x: 0, y: 0}, displayAt: {x: number; y: number} | null = null, framePart = 'portrait';
  for (const value of Object.values(portraitLayout)) {
    const part = node(value);
    if (typeof part.name !== 'string') continue;
    const at = {x: int(part.x) ?? 0, y: int(part.y) ?? 0};
    if (part.name === 'device') displayAt = at; else { framePart = part.name; frameAt = at; }
  }
  const display = node(node(parts.device).display);
  const dw = int(display.width), dh = int(display.height);
  const image = node(node(parts[framePart]).background).image;
  if (!displayAt || !dw || !dh || typeof image !== 'string' || !IMAGE_NAME.test(image)) return null;
  const mask = node(node(parts[framePart]).foreground).mask;
  return {width, height, background: image, screen: {x: displayAt.x - frameAt.x + (int(display.x) ?? 0), y: displayAt.y - frameAt.y + (int(display.y) ?? 0), w: dw, h: dh},
    ...(typeof mask === 'string' && IMAGE_NAME.test(mask) ? {mask} : {})};
}
/** The skin folder an AVD uses: `skin.path` (absolute, or relative to the SDK), else `<sdk>/skins/<skin.name>`. */
export function skinDir(config: Record<string, string>, sdk: string): string | null {
  const raw = config['skin.path']?.trim(), name = config['skin.name']?.trim();
  if (raw === '_no_skin' || (!raw && !name)) return null;
  const dir = raw ? (path.isAbsolute(raw) ? raw : path.join(sdk, raw)) : path.join(sdk, 'skins', name!);
  // Only real skin folders: never a path outside a "skins" directory.
  return /(^|[\\/])skins[\\/][^\\/]+[\\/]?$/.test(dir) ? dir : null;
}
/** Pixel size of a PNG or WebP (enough to check a mask matches the display), or null. */
export function imageSize(bytes: Uint8Array): {width: number; height: number} | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return {width: b.readUInt32BE(16), height: b.readUInt32BE(20)};
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return {width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3)};
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return {width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff)}; }
    if (kind === 'VP8 ') return {width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff};
  }
  return null;
}
const mime = (file: string) => /\.webp$/i.test(file) ? 'image/webp' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
export const dataUrl = (bytes: Uint8Array, type: string) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** An Android skin as a DeviceChrome, read from the user's SDK; null when the AVD has none or it is unusable. */
export function androidSkinChrome(dir: string, read: {text(file: string): string | undefined; bytes(file: string): Uint8Array | undefined}): DeviceChrome | null {
  const layoutText = read.text(path.join(dir, 'layout'));
  const skin = layoutText ? skinPortrait(parseSkinLayout(layoutText)) : null;
  if (!skin) return null;
  const background = read.bytes(path.join(dir, skin.background));
  const size = background ? imageSize(background) : null;
  if (!background || !size) return null;
  // The layout's coordinates are the background's pixels; a mismatch means a layout this reader does not understand.
  if (Math.abs(size.width - skin.width) > 2 || Math.abs(size.height - skin.height) > 2) return null;
  const maskBytes = skin.mask ? read.bytes(path.join(dir, skin.mask)) : undefined, maskSize = maskBytes ? imageSize(maskBytes) : null;
  const mask = maskBytes && maskSize && Math.abs(maskSize.width - skin.screen.w) <= 2 && Math.abs(maskSize.height - skin.screen.h) <= 2 ? dataUrl(maskBytes, mime(skin.mask!)) : undefined;
  return {source: 'android-skin', detail: `Android SDK skin ${path.basename(dir)} (Apache-2.0), read from ${dir}`, width: skin.width, height: skin.height,
    image: {rect: {x: 0, y: 0, w: skin.width, h: skin.height}, dataUrl: dataUrl(background, mime(skin.background))},
    screen: {...skin.screen, radii: [0, 0, 0, 0]}, ...(mask ? {mask} : {}), buttons: []};
}
