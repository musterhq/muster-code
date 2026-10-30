/**
 * Scene colours come from the renderer's theme tokens (#324), never from literals: the same CSS custom properties
 * the rest of the app paints with are resolved to RGB here, so Light/Dark/System, the built-in themes and imported
 * themes all re-colour the 3D background, default material and accent without a second palette to maintain.
 */
export interface EngineTheme {
  /** Scene background (the surface the viewer sits on). 0xRRGGBB. */
  background: number;
  /** Default model colour for formats without materials (STL, PLY, OBJ without MTL). */
  model: number;
  /** Highlights: wireframe overlay, selection. */
  accent: number;
  /** Text colour, for any overlay drawn into the scene. */
  text: number;
  /** True when the background is dark (lights are balanced differently). */
  dark: boolean;
}

/** Token names read from the element; each has a fallback so a missing token never throws. */
export const THEME_TOKENS = {background: '--bg-sunken', surface: '--bg', text: '--text', accent: '--accent'} as const;

let probe: CanvasRenderingContext2D | null | undefined;

/** Resolve any CSS colour (including `color-mix()` and `var()` results) to [r,g,b] 0-255, or null when unparseable. */
export function resolveCssColor(value: string): [number, number, number] | null {
  if (probe === undefined) {
    try { probe = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d', {willReadFrequently: true}) : null; } catch { probe = null; }
  }
  if (!probe || !value) return parseHex(value);
  try {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = value; // an invalid value leaves the previous style, so reset first and compare below
    const normalized = probe.fillStyle;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    if (a === 0) return parseHex(normalized);
    return [r!, g!, b!];
  } catch { return parseHex(value); }
}

function parseHex(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const pack = (c: [number, number, number]) => (c[0] << 16) | (c[1] << 8) | c[2];
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const luminance = (c: [number, number, number]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Pure derivation from four resolved colours; exported so tests do not need a DOM. */
export function deriveTheme(bg: [number, number, number], surface: [number, number, number], text: [number, number, number], accent: [number, number, number]): EngineTheme {
  return {background: pack(bg), model: pack(mix(bg, text, 0.62)), accent: pack(accent), text: pack(text), dark: luminance(surface) < 0.5};
}

const FALLBACK = deriveTheme([0x14, 0x14, 0x14], [0x16, 0x16, 0x16], [0xe8, 0xe8, 0xe8], [0x91, 0xab, 0xc2]);

/** Read the live tokens from `el` (usually the viewer container). */
export function readEngineTheme(el: Element): EngineTheme {
  if (typeof getComputedStyle !== 'function') return FALLBACK;
  const cs = getComputedStyle(el);
  const read = (token: string): [number, number, number] | null => resolveCssColor(cs.getPropertyValue(token).trim());
  const bg = read(THEME_TOKENS.background) ?? read(THEME_TOKENS.surface), surface = read(THEME_TOKENS.surface), text = read(THEME_TOKENS.text), accent = read(THEME_TOKENS.accent);
  if (!bg || !surface || !text || !accent) return FALLBACK;
  return deriveTheme(bg, surface, text, accent);
}

/** Calls `onChange` when the theme attributes on `<html>` change (Light/Dark/System switches, imported themes). */
export function watchTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'style', 'class', 'data-theme-id']});
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener?.('change', onChange);
  return () => { observer.disconnect(); media?.removeEventListener?.('change', onChange); };
}
