/**
 * Visuals program: the active theme as concrete colours for libraries that cannot read CSS variables (Mermaid, Vega, a 3D
 * scene). Everything is read from the live tokens (styles.css :root, the stock Light/Dark, the six built-ins and imported
 * themes all set the same variables), never from literals: a theme change changes `richThemeSignature()`, and every rich
 * block re-renders from the new values.
 */
import {useSyncExternalStore} from 'react';

let probe: HTMLElement | null = null;
let canvas: CanvasRenderingContext2D | null | undefined;

function ensureProbe(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!probe || !probe.isConnected) {
    probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
  }
  return probe;
}

/** `#rrggbb` / `rgba(r, g, b, a)` for any CSS colour expression (`var(--accent)`, `color-mix(...)`, `rgb(... / 6%)`). */
export function resolveColor(expression: string, fallback = 'gray'): string {
  const element = ensureProbe();
  if (!element) return fallback;
  element.style.color = '';
  element.style.color = expression;
  if (!element.style.color) return fallback;
  const computed = getComputedStyle(element).color;
  if (!computed) return fallback;
  if (canvas === undefined) {
    try { canvas = document.createElement('canvas').getContext('2d', {willReadFrequently: true}); if (canvas) { canvas.canvas.width = 1; canvas.canvas.height = 1; } } catch { canvas = null; }
  }
  if (!canvas) return computed;
  // Any syntax the browser understands (`color(srgb ...)` from color-mix included) is read back as sRGB pixels that every
  // library parses.
  try {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = computed;
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data as unknown as [number, number, number, number];
    if (a === 0) return fallback;
    const hex = (value: number) => value.toString(16).padStart(2, '0');
    return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${r}, ${g}, ${b}, ${Math.round(a / 255 * 100) / 100})`;
  } catch { return computed; }
}

export const token = (name: string, fallback?: string): string => resolveColor(`var(--${name})`, fallback);
export const mix = (a: string, b: string, percent: number): string => resolveColor(`color-mix(in srgb, ${a} ${percent}%, ${b})`);

function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})/i.exec(color);
  if (hex) return [parseInt(hex[1]!.slice(0, 2), 16), parseInt(hex[1]!.slice(2, 4), 16), parseInt(hex[1]!.slice(4, 6), 16)];
  const rgb = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(color);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [128, 128, 128];
}
/** Relative luminance 0..1. */
export function luminance(color: string): number {
  const [r, g, b] = channels(color).map(value => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Black-ish or white-ish text, whichever reads better on `fill` (labels on a palette colour). */
export function readableOn(fill: string, dark: string, light: string): string { return luminance(fill) > 0.42 ? dark : light; }

/** Categorical series colours, in order: the accent first, then the theme's file hues. */
const PALETTE_TOKENS = ['accent', 'file-green', 'file-yellow', 'file-purple', 'file-teal', 'file-red', 'pink', 'file-blue', 'violet', 'warn', 'info', 'ok'] as const;

export interface RichTheme {
  dark: boolean;
  font: string;
  mono: string;
  surface: string;
  bg: string;
  text: string;
  textDim: string;
  textFaint: string;
  line: string;
  /** A quiet fill: nodes, bars' neighbours, table stripes. */
  fill: string;
  fillStrong: string;
  accent: string;
  danger: string;
  palette: string[];
  /** Text colour that reads on each palette colour. */
  onPalette: string[];
}

export function readRichTheme(): RichTheme {
  const root = typeof document !== 'undefined' ? document.documentElement : undefined;
  const dark = root?.dataset.theme !== 'light';
  const style = root ? getComputedStyle(root) : undefined;
  const font = style?.getPropertyValue('--ui').trim() || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const mono = style?.getPropertyValue('--mono').trim() || 'ui-monospace, Menlo, monospace';
  const surface = token('bg-raised');
  const bg = token('bg');
  const text = token('text');
  const accent = token('accent');
  const palette = PALETTE_TOKENS.map(name => token(name, accent));
  const ink = token('text-strong', text), paper = token('bg', bg);
  return {
    dark, font, mono, surface, bg, text,
    textDim: mix(text, surface, 72), textFaint: mix(text, surface, 48),
    line: mix(text, surface, 22),
    fill: mix(accent, surface, 14), fillStrong: mix(accent, surface, 28),
    accent, danger: token('danger'), palette,
    onPalette: palette.map(color => readableOn(color, dark ? paper : ink, dark ? ink : paper)),
  };
}

// ---- change signal ----------------------------------------------------------------------------------------------------

let signature = '';
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function computeSignature(): string {
  if (typeof document === 'undefined') return 'ssr';
  const root = document.documentElement;
  const style = getComputedStyle(root);
  // The attributes that select a theme plus the three tokens every theme sets; cheap, and any real theme change moves one of them.
  return [root.dataset.theme, root.dataset.themeId, style.getPropertyValue('--bg'), style.getPropertyValue('--text'), style.getPropertyValue('--accent'), style.getPropertyValue('--ui')].join('|');
}
function onMutation(): void {
  const next = computeSignature();
  if (next === signature) return;
  signature = next;
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  if (!listeners.size) {
    signature = computeSignature();
    observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-theme-id', 'style', 'class']});
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) { observer?.disconnect(); observer = undefined; } };
}
/** Changes whenever the active theme does (Light/Dark/System, a built-in or imported colour theme). Not a hot path: no polling. */
export function richThemeSignature(): string { return listeners.size ? signature : computeSignature(); }
export function useRichThemeSignature(): string { return useSyncExternalStore(subscribe, richThemeSignature, () => 'ssr'); }
