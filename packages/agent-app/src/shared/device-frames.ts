/**
 * Device frames (#363): one parametric description of a device's outside — screen, corners, cut-out, bezels, edge,
 * buttons, form — that both the flat view (SVG/CSS) and the 3D view draw from. Every frame is drawn by Muster from these
 * numbers; no device maker's artwork, mesh or photo is used.
 *
 * Specs come from the device itself wherever possible: the simulator's device type (iOS), the AVD's config.ini and
 * hardware-qemu.ini (screen size, density, device profile, tags, hinge) and, for a running emulator, the display
 * cut-out Android reports. Known families map to built-in specs; anything else gets a generic spec for its own OS,
 * computed from its screen, so a device never wears another OS's frame.
 *
 * Units: lengths are fractions of the screen's short side. Positions along an edge are fractions of that edge
 * (0 = top or left). Everything is described in the device's natural orientation.
 */
export type FrameForm = 'phone' | 'foldable' | 'tablet' | 'watch-round' | 'watch-square' | 'tv' | 'automotive';
export type CutoutKind = 'none' | 'island' | 'notch' | 'waterdrop' | 'punch-center' | 'punch-side';
export type FrameEdge = 'left' | 'right' | 'top' | 'bottom';
export type ButtonKind = 'power' | 'volume' | 'action' | 'camera' | 'crown' | 'mute';
export interface FrameCutout {kind: CutoutKind; width: number; height: number; /** Centre across the screen width, 0..1. */ x: number; /** Gap from the screen's top edge. */ y: number}
export interface FrameButton {edge: FrameEdge; at: number; length: number; kind: ButtonKind}
export interface FrameSpec {
  /** Stable id of the spec ("iphone-island", "pixel-flat", "android-generic-phone"…). */
  id: string;
  /** Plain name of the family, for tooltips and the 3D label. */
  family: string;
  os: 'ios' | 'android';
  form: FrameForm;
  /** Reference screen size in pixels, natural orientation; the live picture's own size wins once it arrives. */
  screen: {width: number; height: number};
  /** Screen corner radius (the real display's rounding; the live picture is masked to it). */
  radius: number;
  bezel: {side: number; top: number; bottom: number};
  /** Outer corner radius; defaults to the screen radius plus the side bezel (concentric). */
  bodyRadius?: number;
  edge: 'flat' | 'curved';
  color: 'dark' | 'light' | 'titanium';
  cutout: FrameCutout;
  buttons: FrameButton[];
  /** A round Home button in the bottom bezel. */
  home?: boolean;
  /** A front camera on the bezel (devices without a screen cut-out). */
  camera?: {edge: FrameEdge; at: number};
  /** A speaker slit above the screen. */
  speaker?: boolean;
  /** An open foldable: the hinge runs down the middle. */
  hinge?: boolean;
  /** The other display of a foldable (folded posture). */
  folded?: FrameSpec;
  /** A TV on a stand. */
  stand?: boolean;
  /** Back camera styling for the 3D view. */
  back: 'square' | 'bar' | 'pill' | 'single' | 'none';
  /** Where the spec came from: a built-in family, the AVD's own numbers, or a generic fallback. */
  source: 'family' | 'device' | 'generic';
}

const none: FrameCutout = {kind: 'none', width: 0, height: 0, x: 0.5, y: 0};
const btn = (edge: FrameEdge, at: number, length: number, kind: ButtonKind): FrameButton => ({edge, at, length, kind});

// --- Apple -------------------------------------------------------------------------------------------------------
// Measured from the devices' published screen geometry (points): e.g. iPhone 16 Pro, 402×874 pt, 55 pt corners, a
// 126×37 pt island 11 pt from the top.
const IPHONE_ISLAND: FrameSpec = {id: 'iphone-island', family: 'iPhone with Dynamic Island', os: 'ios', form: 'phone', screen: {width: 1206, height: 2622}, radius: 0.137,
  bezel: {side: 0.034, top: 0.034, bottom: 0.034}, edge: 'flat', color: 'titanium', back: 'square', source: 'family',
  cutout: {kind: 'island', width: 0.313, height: 0.092, x: 0.5, y: 0.027},
  buttons: [btn('left', 0.17, 0.05, 'action'), btn('left', 0.25, 0.085, 'volume'), btn('left', 0.345, 0.085, 'volume'), btn('right', 0.28, 0.13, 'power')]};
const IPHONE_NOTCH: FrameSpec = {...IPHONE_ISLAND, id: 'iphone-notch', family: 'iPhone with notch', screen: {width: 1170, height: 2532}, radius: 0.121, color: 'dark',
  bezel: {side: 0.04, top: 0.04, bottom: 0.04}, cutout: {kind: 'notch', width: 0.415, height: 0.083, x: 0.5, y: 0},
  buttons: [btn('left', 0.16, 0.04, 'mute'), btn('left', 0.24, 0.085, 'volume'), btn('left', 0.335, 0.085, 'volume'), btn('right', 0.28, 0.13, 'power')]};
const IPHONE_HOME: FrameSpec = {id: 'iphone-home', family: 'iPhone with Home button', os: 'ios', form: 'phone', screen: {width: 750, height: 1334}, radius: 0,
  bezel: {side: 0.06, top: 0.3, bottom: 0.3}, bodyRadius: 0.16, edge: 'curved', color: 'dark', back: 'single', source: 'family', cutout: none, home: true, speaker: true,
  camera: {edge: 'top', at: 0.36}, buttons: [btn('left', 0.15, 0.04, 'mute'), btn('left', 0.23, 0.08, 'volume'), btn('left', 0.32, 0.08, 'volume'), btn('right', 0.22, 0.08, 'power')]};
const IOS_PHONE: FrameSpec = {...IPHONE_NOTCH, id: 'ios-generic-phone', family: 'iPhone', cutout: none, source: 'generic'};
const IPAD: FrameSpec = {id: 'ipad', family: 'iPad', os: 'ios', form: 'tablet', screen: {width: 1668, height: 2420}, radius: 0.022,
  bezel: {side: 0.045, top: 0.045, bottom: 0.045}, edge: 'flat', color: 'dark', back: 'single', source: 'family', cutout: none,
  // Landscape front camera: on the long edge, which is the right side held in portrait.
  camera: {edge: 'right', at: 0.5}, buttons: [btn('top', 0.84, 0.08, 'power'), btn('right', 0.1, 0.05, 'volume'), btn('right', 0.16, 0.05, 'volume')]};
const IPAD_MINI: FrameSpec = {...IPAD, id: 'ipad-mini', family: 'iPad mini', screen: {width: 1488, height: 2266}, camera: {edge: 'top', at: 0.5}};
const IPAD_HOME: FrameSpec = {...IPAD, id: 'ipad-home', family: 'iPad with Home button', screen: {width: 1620, height: 2160}, radius: 0,
  bezel: {side: 0.1, top: 0.14, bottom: 0.14}, bodyRadius: 0.1, edge: 'curved', home: true, camera: {edge: 'top', at: 0.5}};

/** The frame for an iOS simulator, from its simctl device type (`com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro`) and name. */
export function iosFrame(deviceType: string | undefined, name: string): FrameSpec {
  const label = `${(deviceType ?? '').replace(/^.*SimDeviceType\./, '').replace(/-/g, ' ')} ${name}`;
  if (/iPad/i.test(label)) {
    const gen = Number(/\((\d+)(?:st|nd|rd|th) generation\)/i.exec(label)?.[1] ?? 0);
    if (/mini/i.test(label)) return gen && gen <= 5 ? IPAD_HOME : IPAD_MINI;
    if (/iPad Air/i.test(label)) return gen && gen <= 3 ? IPAD_HOME : IPAD;
    if (/iPad Pro/i.test(label)) return /9\.7|10\.5|\(1st generation\)|\(2nd generation\).*12\.9|12\.9.*\(2nd generation\)/i.test(label) ? IPAD_HOME : IPAD;
    if (/iPad \(\d+(?:st|nd|rd|th) generation\)/i.test(label)) return gen <= 9 ? IPAD_HOME : IPAD;
    return IPAD;
  }
  if (!/iPhone/i.test(label)) return IOS_PHONE;
  if (/\bSE\b|iPhone [678]\b|iPhone [678] Plus/i.test(label)) return IPHONE_HOME;
  if (/iPhone Air/i.test(label)) return IPHONE_ISLAND;
  const model = /iPhone (\d{2})(e)?\b(.*)/i.exec(label);
  if (model) {
    const number = Number(model[1]), budget = !!model[2], pro = /Pro/i.test(model[3] ?? '');
    if (budget) return IPHONE_NOTCH;
    if (number >= 15 || (number === 14 && pro)) {
      // iPhone 16 and later carry a Camera Control on the right, below the side button.
      return number >= 16 ? {...IPHONE_ISLAND, buttons: [...IPHONE_ISLAND.buttons, btn('right', 0.62, 0.07, 'camera')]} : IPHONE_ISLAND;
    }
    if (number >= 11) return IPHONE_NOTCH;
  }
  if (/iPhone X/i.test(label)) return IPHONE_NOTCH;
  return IOS_PHONE;
}

// --- Android -----------------------------------------------------------------------------------------------------
const PIXEL: FrameSpec = {id: 'pixel', family: 'Pixel', os: 'android', form: 'phone', screen: {width: 1080, height: 2424}, radius: 0.092,
  bezel: {side: 0.036, top: 0.036, bottom: 0.036}, edge: 'flat', color: 'dark', back: 'bar', source: 'family',
  cutout: {kind: 'punch-center', width: 0.042, height: 0.042, x: 0.5, y: 0.03},
  buttons: [btn('right', 0.23, 0.075, 'power'), btn('right', 0.37, 0.14, 'volume')]};
const PIXEL_CURVED: FrameSpec = {...PIXEL, id: 'pixel-curved', family: 'Pixel Pro (curved)', screen: {width: 1440, height: 3120}, edge: 'curved', bezel: {side: 0.022, top: 0.034, bottom: 0.034}};
const PIXEL_PILL: FrameSpec = {...PIXEL, id: 'pixel-pill', family: 'Pixel', back: 'pill', radius: 0.1};
const PIXEL_SIDE_PUNCH: FrameSpec = {...PIXEL, id: 'pixel-side-punch', family: 'Pixel (corner camera)', screen: {width: 1080, height: 2340}, radius: 0.07, back: 'square',
  cutout: {kind: 'punch-side', width: 0.045, height: 0.045, x: 0.08, y: 0.035}};
const PIXEL_BEZEL: FrameSpec = {...PIXEL, id: 'pixel-bezel', family: 'Pixel (forehead)', screen: {width: 1080, height: 2280}, radius: 0.06, back: 'square',
  cutout: none, bezel: {side: 0.04, top: 0.11, bottom: 0.045}, speaker: true};
const PIXEL_NOTCH: FrameSpec = {...PIXEL, id: 'pixel-notch', family: 'Pixel (notch)', screen: {width: 1440, height: 2960}, radius: 0.07, back: 'single',
  cutout: {kind: 'notch', width: 0.3, height: 0.075, x: 0.5, y: 0}};
const ANDROID_CLASSIC: FrameSpec = {...PIXEL, id: 'android-classic-phone', family: 'Android phone', screen: {width: 1080, height: 1920}, radius: 0, bodyRadius: 0.12,
  bezel: {side: 0.05, top: 0.17, bottom: 0.17}, cutout: none, speaker: true, camera: {edge: 'top', at: 0.3}, back: 'single', source: 'family'};
const PIXEL_FOLD_OUTER: FrameSpec = {...PIXEL, id: 'pixel-fold-folded', family: 'Pixel Fold (folded)', form: 'foldable', screen: {width: 1080, height: 2092}, radius: 0.08};
const PIXEL_FOLD: FrameSpec = {id: 'pixel-fold', family: 'Pixel Fold', os: 'android', form: 'foldable', screen: {width: 2076, height: 2152}, radius: 0.04,
  bezel: {side: 0.03, top: 0.03, bottom: 0.03}, edge: 'flat', color: 'dark', back: 'bar', source: 'family', hinge: true,
  cutout: {kind: 'punch-side', width: 0.03, height: 0.03, x: 0.93, y: 0.025}, buttons: [btn('right', 0.2, 0.07, 'power'), btn('right', 0.33, 0.12, 'volume')], folded: PIXEL_FOLD_OUTER};
const PIXEL_TABLET: FrameSpec = {id: 'pixel-tablet', family: 'Pixel Tablet', os: 'android', form: 'tablet', screen: {width: 2560, height: 1600}, radius: 0.025,
  bezel: {side: 0.06, top: 0.06, bottom: 0.06}, edge: 'curved', color: 'light', back: 'single', source: 'family', cutout: none,
  camera: {edge: 'top', at: 0.5}, buttons: [btn('top', 0.12, 0.05, 'power'), btn('right', 0.12, 0.08, 'volume')]};
const CENTRE_PUNCH: FrameSpec = {...PIXEL, id: 'android-centre-punch', family: 'Android phone (centre punch-hole)', screen: {width: 1080, height: 2340}, radius: 0.07,
  bezel: {side: 0.028, top: 0.03, bottom: 0.03}, back: 'single', cutout: {kind: 'punch-center', width: 0.034, height: 0.034, x: 0.5, y: 0.028},
  // Volume above power, both on the right.
  buttons: [btn('right', 0.25, 0.13, 'volume'), btn('right', 0.39, 0.07, 'power')]};
const SMALL_PHONE: FrameSpec = {...PIXEL, id: 'android-small-phone', family: 'Small Android phone', screen: {width: 720, height: 1280}, radius: 0.03,
  bezel: {side: 0.05, top: 0.12, bottom: 0.12}, cutout: none, speaker: true, back: 'single', source: 'family'};
const WEAR_ROUND: FrameSpec = {id: 'wear-round', family: 'Wear OS (round)', os: 'android', form: 'watch-round', screen: {width: 454, height: 454}, radius: 0.5,
  bezel: {side: 0.1, top: 0.1, bottom: 0.1}, edge: 'curved', color: 'dark', back: 'none', source: 'family', cutout: none, buttons: [btn('right', 0.4, 0.14, 'crown')]};
const WEAR_SQUARE: FrameSpec = {...WEAR_ROUND, id: 'wear-square', family: 'Wear OS (square)', form: 'watch-square', screen: {width: 360, height: 360}, radius: 0.16, bodyRadius: 0.26};
const TV: FrameSpec = {id: 'android-tv', family: 'Android TV', os: 'android', form: 'tv', screen: {width: 1920, height: 1080}, radius: 0.004,
  bezel: {side: 0.02, top: 0.02, bottom: 0.03}, bodyRadius: 0.012, edge: 'flat', color: 'dark', back: 'none', source: 'family', cutout: none, buttons: [], stand: true};
const AUTOMOTIVE: FrameSpec = {id: 'android-automotive', family: 'Android Automotive', os: 'android', form: 'automotive', screen: {width: 1408, height: 792}, radius: 0.03,
  bezel: {side: 0.05, top: 0.05, bottom: 0.09}, bodyRadius: 0.1, edge: 'curved', color: 'dark', back: 'none', source: 'family', cutout: none, buttons: []};
const ANDROID_TABLET: FrameSpec = {...PIXEL_TABLET, id: 'android-generic-tablet', family: 'Android tablet', color: 'dark', source: 'generic'};
const ANDROID_PHONE: FrameSpec = {...PIXEL, id: 'android-generic-phone', family: 'Android phone', radius: 0.07, back: 'single', cutout: none, source: 'generic'};

export const FRAME_SPECS: Readonly<Record<string, FrameSpec>> = Object.fromEntries([IPHONE_ISLAND, IPHONE_NOTCH, IPHONE_HOME, IOS_PHONE, IPAD, IPAD_MINI, IPAD_HOME, PIXEL, PIXEL_CURVED, PIXEL_PILL,
  PIXEL_SIDE_PUNCH, PIXEL_BEZEL, PIXEL_NOTCH, ANDROID_CLASSIC, PIXEL_FOLD, PIXEL_FOLD_OUTER, PIXEL_TABLET, CENTRE_PUNCH, SMALL_PHONE, WEAR_ROUND, WEAR_SQUARE, TV, AUTOMOTIVE,
  ANDROID_TABLET, ANDROID_PHONE].map(spec => [spec.id, spec]));

/** What an AVD says about itself: config.ini merged with hardware-qemu.ini (when it is running). */
export type AvdConfig = Record<string, string>;
export function parseIni(text: string): AvdConfig {
  const out: AvdConfig = {};
  for (const line of text.split(/\r?\n/)) { const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]!.toLowerCase()] = m[2]!; }
  return out;
}

/** A running emulator's top cut-out, from `dumpsys window displays` (DisplayCutout bounds) and the display width. */
export function parseCutout(dumpsys: string, displayWidth: number): FrameCutout | undefined {
  const bounds = /DisplayCutout\{[^]*?boundingRect=\{Bounds=\[([^\]]*)\]/.exec(dumpsys)?.[1];
  if (!bounds || !(displayWidth > 0)) return undefined;
  const rects = [...bounds.matchAll(/Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/g)].map(m => m.slice(1, 5).map(Number) as [number, number, number, number]);
  const top = rects[1];
  if (!top || top[2] <= top[0] || top[3] <= top[1]) return none;
  const width = (top[2] - top[0]) / displayWidth, height = top[3] / displayWidth, x = (top[0] + top[2]) / 2 / displayWidth;
  const ratio = (top[2] - top[0]) / Math.max(1, top[3] - top[1]);
  // Bounds include the status-bar padding around a hole, so a hole reads a little larger than the lens: shrink it.
  if (ratio < 1.6 && width < 0.14) return {kind: Math.abs(x - 0.5) < 0.12 ? 'punch-center' : 'punch-side', width: width * 0.7, height: width * 0.7, x, y: Math.max(0.01, (top[3] - (top[2] - top[0]) * 0.85) / displayWidth)};
  if (width > 0.25) return {kind: 'notch', width, height, x, y: 0};
  return {kind: 'waterdrop', width, height, x, y: 0};
}

/** The frame for an Android emulator, from its AVD configuration (and, when running, the cut-out it reports). */
export function androidFrame(config: AvdConfig, avdName: string, cutout?: FrameCutout): FrameSpec {
  const device = (config['hw.device.name'] || avdName).toLowerCase().replace(/[\s-]+/g, '_');
  const maker = (config['hw.device.manufacturer'] || '').toLowerCase();
  const tags = `${config['tag.id'] ?? ''},${config['tag.ids'] ?? ''},${config['image.sysdir.1'] ?? ''}`.toLowerCase();
  const skin = `${config['skin.name'] ?? ''} ${config['skin.path'] ?? ''}`.toLowerCase();
  const width = Number(config['hw.lcd.width']) || 0, height = Number(config['hw.lcd.height']) || 0, density = Number(config['hw.lcd.density']) || 0;
  const withCutout = (spec: FrameSpec): FrameSpec => cutout && spec.source !== 'family' ? {...spec, cutout} : spec;
  const sized = (spec: FrameSpec): FrameSpec => width > 0 && height > 0 ? {...spec, screen: {width, height}} : spec;

  // Form first, from what the image and profile say they are.
  if (/wear/.test(tags) || /^wear/.test(device)) return /round|circular/.test(`${device} ${skin}`) || config['hw.lcd.circular'] === 'true' ? sized(WEAR_ROUND) : sized(WEAR_SQUARE);
  if (/android-tv|google-tv|\btv\b/.test(tags) || /^tv_|_tv$|television/.test(device)) return sized(TV);
  if (/automotive/.test(tags) || /automotive/.test(device)) return sized(AUTOMOTIVE);
  // AVDs carry default (empty) display-region keys and a hinge setting of "no": only a real hinge or second region counts.
  const foldable = /fold|flip/.test(device) || config['hw.sensor.hinge'] === 'yes' || Number(config['hw.displayregion.0.1.width'] ?? 0) > 0;

  // Known families by hardware profile.
  if (/pixel(_\d+)?(_pro)?_fold|^pixel_fold/.test(device)) return PIXEL_FOLD;
  if (/pixel_tablet/.test(device)) return sized(PIXEL_TABLET);
  const pixel = /^pixel(?:_(\d+)(a)?)?(?:_(pro|xl|pro_xl))?(?:_|$)/.exec(device);
  if (pixel && !foldable) {
    const gen = Number(pixel[1] ?? 1), variant = pixel[3] ?? '';
    if (gen >= 9) return sized(PIXEL_PILL);
    if (gen >= 6) return sized(gen <= 7 && variant.startsWith('pro') ? PIXEL_CURVED : PIXEL);
    if (gen === 5 || (gen === 4 && pixel[2])) return sized(PIXEL_SIDE_PUNCH);
    if (gen === 4) return sized(PIXEL_BEZEL);
    if (gen === 3 && variant === 'xl' && !pixel[2]) return sized(PIXEL_NOTCH);
    return sized(ANDROID_CLASSIC);
  }
  if (/samsung|galaxy|^sm_/.test(`${maker} ${device}`)) return withCutout(sized(CENTRE_PUNCH));
  if (/^small_phone|^nexus_(4|5|s|one)\b|^nexus_(4|5)$/.test(device)) return sized(SMALL_PHONE);
  if (/^nexus/.test(device)) return sized(ANDROID_CLASSIC);

  // Anything else: a generic Android frame computed from its own screen.
  const short = Math.min(width, height), long = Math.max(width, height);
  const dp = density > 0 && short > 0 ? short / (density / 160) : 0;
  if (foldable) return withCutout({...PIXEL_FOLD, id: 'android-generic-foldable', family: 'Android foldable', source: 'generic', cutout: none, folded: {...PIXEL_FOLD_OUTER, id: 'android-generic-foldable-folded', family: 'Android foldable (folded)', source: 'generic', cutout: none}, ...(width && height ? {screen: {width, height}} : {})});
  if (dp >= 600 || /tablet/.test(device)) return withCutout(sized(ANDROID_TABLET));
  const modern = short > 0 ? long / short >= 1.95 : true;
  return withCutout({...ANDROID_PHONE, ...(width && height ? {screen: {width, height}, source: 'device' as const} : {}),
    ...(modern ? {} : {radius: 0.02, bezel: {side: 0.05, top: 0.12, bottom: 0.12}, speaker: true})});
}

/** A frame from a name alone (a session from before specs, or a preview): never another OS's frame. */
export function frameFromName(platform: 'ios' | 'android', name: string): FrameSpec {
  return platform === 'ios' ? iosFrame(undefined, name) : androidFrame({}, name);
}
/** The spec to draw for the live picture: a foldable shows its folded display when the picture has that shape. */
export function frameForPicture(spec: FrameSpec, picture?: {width: number; height: number}): FrameSpec {
  if (!spec.folded || !picture?.width || !picture.height) return spec;
  const ratio = Math.min(picture.width, picture.height) / Math.max(picture.width, picture.height);
  return ratio < 0.7 ? spec.folded : spec;
}

// --- Layout: the spec turned into shapes, shared by the SVG and the 3D builder ------------------------------------

export type PathOp = ['M' | 'L', number, number] | ['Q', number, number, number, number] | ['Z'];
export interface Circle {cx: number; cy: number; r: number}
export interface FrameShape {path?: PathOp[]; circle?: Circle; ring?: boolean}
export interface Rect {x: number; y: number; w: number; h: number}
export interface FrameLayout {
  width: number; height: number;
  body: PathOp[];
  bodyRect: Rect;
  /** The screen rectangle and its corner radius; `round` for a circular watch face. */
  glass: Rect & {r: number; round: boolean};
  buttons: {rect: Rect; kind: ButtonKind; edge: FrameEdge}[];
  /** Drawn over the screen (the cut-out). */
  cutouts: FrameShape[];
  /** Drawn on the bezel (camera, speaker, Home button, hinge marks). */
  marks: FrameShape[];
  /** Drawn under the body (a TV stand). */
  stand: PathOp[][];
  /** Quarter turns applied (counter-clockwise) to show a picture in the other orientation. */
  turns: number;
}

const roundRectPath = (x: number, y: number, w: number, h: number, r: number): PathOp[] => {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  return [['M', x + k, y], ['L', x + w - k, y], ['Q', x + w, y, x + w, y + k], ['L', x + w, y + h - k], ['Q', x + w, y + h, x + w - k, y + h],
    ['L', x + k, y + h], ['Q', x, y + h, x, y + h - k], ['L', x, y + k], ['Q', x, y, x + k, y], ['Z']];
};
/** A notch hanging from the top edge, with rounded lower corners and soft shoulders. */
const notchPath = (cx: number, top: number, w: number, h: number): PathOp[] => {
  const s = h * 0.45, r = h * 0.55, x0 = cx - w / 2, x1 = cx + w / 2;
  return [['M', x0 - s, top], ['Q', x0, top, x0, top + s], ['L', x0, top + h - r], ['Q', x0, top + h, x0 + r, top + h], ['L', x1 - r, top + h],
    ['Q', x1, top + h, x1, top + h - r], ['L', x1, top + s], ['Q', x1, top, x1 + s, top], ['Z']];
};
const dropPath = (cx: number, top: number, w: number, h: number): PathOp[] =>
  [['M', cx - w / 2, top], ['Q', cx - w / 4, top, cx - w / 4, top + h * 0.5], ['Q', cx - w / 4, top + h, cx, top + h], ['Q', cx + w / 4, top + h, cx + w / 4, top + h * 0.5], ['Q', cx + w / 4, top, cx + w / 2, top], ['Z']];

/**
 * Lays a spec out around a screen. `picture` (the live frame's size) sets the screen's proportions; `turns` rotates the
 * whole device counter-clockwise in quarter turns (a landscape picture on a portrait device is one turn).
 */
export function frameLayout(spec: FrameSpec, picture?: {width: number; height: number}, turns = 0): FrameLayout {
  // Screen size in short-side units, natural orientation.
  const naturalLandscape = spec.screen.width > spec.screen.height;
  let pw = picture?.width || spec.screen.width, ph = picture?.height || spec.screen.height;
  if ((pw > ph) !== naturalLandscape && pw !== ph) [pw, ph] = [ph, pw];
  const short = Math.min(pw, ph), sw = pw / short, sh = ph / short;
  const {side, top, bottom} = spec.bezel, margin = 0.03;
  const round = spec.form === 'watch-round';
  const bw = sw + side * 2, bh = sh + top + bottom;
  const bodyR = round ? Math.min(bw, bh) / 2 : spec.bodyRadius ?? spec.radius + side;
  const standH = spec.stand ? 0.22 : 0;
  const W = bw + margin * 2, H = bh + margin * 2 + standH;
  const bx = margin, by = margin;
  const glass = {x: bx + side, y: by + top, w: sw, h: sh, r: round ? Math.min(sw, sh) / 2 : spec.radius, round};
  const body = roundRectPath(bx, by, bw, bh, bodyR);
  const buttons = spec.buttons.map(button => {
    const thick = 0.018, along = button.edge === 'left' || button.edge === 'right' ? bh : bw, len = button.length * along, at = button.at * along;
    const rect: Rect = button.edge === 'left' ? {x: bx - thick, y: by + at - len / 2, w: thick + 0.01, h: len}
      : button.edge === 'right' ? {x: bx + bw - 0.01, y: by + at - len / 2, w: thick + 0.01, h: len}
      : button.edge === 'top' ? {x: bx + at - len / 2, y: by - thick, w: len, h: thick + 0.01}
      : {x: bx + at - len / 2, y: by + bh - 0.01, w: len, h: thick + 0.01};
    return {rect, kind: button.kind, edge: button.edge};
  });
  const cutouts: FrameShape[] = [];
  const c = spec.cutout, cx = glass.x + c.x * sw, cy = glass.y + c.y;
  if (c.kind === 'island') cutouts.push({path: roundRectPath(cx - c.width / 2, cy, c.width, c.height, c.height / 2)});
  else if (c.kind === 'notch') cutouts.push({path: notchPath(cx, glass.y, c.width, c.height)});
  else if (c.kind === 'waterdrop') cutouts.push({path: dropPath(cx, glass.y, c.width, c.height)});
  else if (c.kind === 'punch-center' || c.kind === 'punch-side') cutouts.push({circle: {cx, cy: cy + c.height / 2, r: c.width / 2}});
  const marks: FrameShape[] = [];
  if (spec.speaker) marks.push({path: roundRectPath(bx + bw / 2 - 0.09, by + top * 0.45 - 0.008, 0.18, 0.016, 0.008)});
  if (spec.home) { const r = Math.min(0.085, bottom * 0.32); marks.push({circle: {cx: bx + bw / 2, cy: by + bh - bottom / 2, r}, ring: true}); }
  if (spec.camera) {
    const {edge, at} = spec.camera, r = 0.013;
    const point = edge === 'top' ? {cx: bx + bw * at, cy: by + top / 2} : edge === 'bottom' ? {cx: bx + bw * at, cy: by + bh - bottom / 2}
      : edge === 'left' ? {cx: bx + side / 2, cy: by + bh * at} : {cx: bx + bw - side / 2, cy: by + bh * at};
    marks.push({circle: {...point, r}});
  }
  if (spec.hinge) for (const y of [by + 0.004, by + bh - 0.014]) marks.push({path: roundRectPath(bx + bw / 2 - 0.004, y, 0.008, 0.01, 0.003)});
  const stand: PathOp[][] = spec.stand ? [roundRectPath(bx + bw / 2 - 0.05, by + bh, 0.1, standH * 0.7, 0.01), roundRectPath(bx + bw / 2 - 0.38, by + bh + standH * 0.62, 0.76, standH * 0.3, 0.03)] : [];
  const layout: FrameLayout = {width: W, height: H, body, bodyRect: {x: bx, y: by, w: bw, h: bh}, glass, buttons, cutouts, marks, stand, turns: 0};
  return rotateLayout(layout, ((turns % 4) + 4) % 4);
}

/** Rotates a layout counter-clockwise by quarter turns (the device turned with its picture). */
export function rotateLayout(layout: FrameLayout, turns: number): FrameLayout {
  let out = layout;
  for (let i = 0; i < turns; i++) {
    const W = out.width;
    // One counter-clockwise quarter turn: (x, y) -> (y, W - x); the new box is H × W.
    const p = (x: number, y: number): [number, number] => [y, W - x];
    const path = (ops: PathOp[]): PathOp[] => ops.map(op => op[0] === 'Z' ? op : op[0] === 'Q' ? ['Q', ...p(op[1], op[2]), ...p(op[3], op[4])] : [op[0], ...p(op[1], op[2])]);
    const rect = (r: Rect): Rect => ({x: r.y, y: W - r.x - r.w, w: r.h, h: r.w});
    const shape = (s: FrameShape): FrameShape => ({...s, ...(s.path ? {path: path(s.path)} : {}), ...(s.circle ? {circle: {cx: s.circle.cy, cy: W - s.circle.cx, r: s.circle.r}} : {})});
    const turnEdge: Record<FrameEdge, FrameEdge> = {top: 'left', left: 'bottom', bottom: 'right', right: 'top'};
    out = {width: out.height, height: W, body: path(out.body), bodyRect: rect(out.bodyRect), glass: {...rect(out.glass), r: out.glass.r, round: out.glass.round},
      buttons: out.buttons.map(b => ({...b, rect: rect(b.rect), edge: turnEdge[b.edge]})), cutouts: out.cutouts.map(shape), marks: out.marks.map(shape), stand: out.stand.map(path), turns: out.turns + 1};
  }
  return out;
}
export const svgPath = (ops: PathOp[]): string => ops.map(op => op[0] === 'Z' ? 'Z' : `${op[0]}${op.slice(1).map(n => +(n as number).toFixed(4)).join(' ')}`).join('');
