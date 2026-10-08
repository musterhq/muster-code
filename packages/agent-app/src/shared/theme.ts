/** Themes (#324). A theme is a set of values for the colour tokens declared in renderer/styles.css.
 *  The two shipped appearances, "Muster Dark" and "Muster Light", carry NO overrides: they are the stylesheet itself,
 *  so choosing nothing changes nothing. Every other theme is applied as inline custom properties on :root.
 *  This module is pure (no DOM, no Node) so main, the renderer, the boot script and the tests all share it. */

export type ThemeBase = 'dark' | 'light';
type TokenKind = 'color' | 'triple' | 'percent';

/** Every themeable token and what a value for it must look like. */
export const TOKEN_KINDS = {
  'bg': 'color', 'bg-raised': 'color', 'bg-hover': 'color', 'bg-active': 'color', 'hairline': 'color',
  'nav-material': 'color', 'nav-solid': 'color', 'text': 'color', 'text-strong': 'color', 'text-dim': 'color', 'text-faint': 'color',
  'accent': 'color', 'link': 'color',
  'file-blue': 'color', 'file-yellow': 'color', 'file-green': 'color', 'file-red': 'color', 'file-purple': 'color', 'file-teal': 'color',
  'danger': 'color', 'ok': 'color', 'warn': 'color',
  'add-bg': 'color', 'del-bg': 'color', 'add-char': 'color', 'del-char': 'color',
  'fg-rgb': 'triple', 'bg-menu': 'color', 'selection': 'color', 'primary-bg': 'color', 'primary-fg': 'color',
  'on-accent': 'color', 'on-danger': 'color', 'info': 'color', 'violet': 'color', 'pink': 'color',
  'shadow-ink': 'color', 'scrim': 'color', 'bg-sunken': 'color', 'hue-l': 'percent',
} as const satisfies Record<string, TokenKind>;
export type TokenKey = keyof typeof TOKEN_KINDS;
export const TOKEN_KEYS = Object.keys(TOKEN_KINDS) as TokenKey[];
export type ThemeTokens = Partial<Record<TokenKey, string>>;

export interface Theme { id: string; name: string; base: ThemeBase; tokens: ThemeTokens }

/** The stylesheet's own values (styles.css :root and :root[data-theme='light']); tests/theme.test.ts keeps them in step.
 *  They are never applied: they exist so contrast can be computed, imports can fall back to the nearest base, and
 *  a custom theme can be exported complete. */
export const BASE_TOKENS: Record<ThemeBase, Record<TokenKey, string>> = {
  dark: {
    'bg': '#161616', 'bg-raised': '#1d1d1d', 'bg-hover': 'rgb(255 255 255 / 5.5%)', 'bg-active': 'rgb(255 255 255 / 8%)',
    'hairline': 'rgb(255 255 255 / 6%)', 'nav-material': 'rgb(19 19 19 / 46%)', 'nav-solid': '#1a1a1a',
    'text': '#e8e8e8', 'text-strong': '#ffffff', 'text-dim': 'rgb(232 232 232 / 72%)', 'text-faint': 'rgb(232 232 232 / 48%)',
    'accent': '#91abc2', 'link': '#7cb7ff',
    'file-blue': '#6aa8ff', 'file-yellow': '#e6c35c', 'file-green': '#8fd16a', 'file-red': '#f07a6b', 'file-purple': '#c79bf2', 'file-teal': '#5cc8c4',
    'danger': '#fc6b83', 'ok': '#80b898', 'warn': '#f1b467',
    'add-bg': 'rgba(128, 184, 152, 0.12)', 'del-bg': 'rgba(252, 107, 131, 0.12)', 'add-char': 'rgba(128, 184, 152, 0.28)', 'del-char': 'rgba(252, 107, 131, 0.28)',
    'fg-rgb': '255 255 255', 'bg-menu': '#252525', 'selection': '#404040', 'primary-bg': '#e6e6e6', 'primary-fg': '#171717',
    'on-accent': '#10161c', 'on-danger': '#1a0d10', 'info': '#9fc1df', 'violet': '#a8abea', 'pink': '#df8fc1',
    'shadow-ink': '#000', 'scrim': 'rgb(0 0 0 / 42%)', 'bg-sunken': 'color-mix(in srgb, var(--bg) 96%, #080909)', 'hue-l': '62%',
  },
  light: {
    'bg': '#fbfbfb', 'bg-raised': '#ffffff', 'bg-hover': 'rgb(0 0 0 / 4.5%)', 'bg-active': 'rgb(0 0 0 / 7%)',
    'hairline': 'rgb(0 0 0 / 9%)', 'nav-material': 'rgb(244 244 244 / 55%)', 'nav-solid': '#f2f2f2',
    'text': '#1d1d1f', 'text-strong': '#000000', 'text-dim': 'rgb(29 29 31 / 74%)', 'text-faint': 'rgb(29 29 31 / 52%)',
    'accent': '#3b6a93', 'link': '#0a64d6',
    'file-blue': '#1f6feb', 'file-yellow': '#a07800', 'file-green': '#2f8a18', 'file-red': '#c2412d', 'file-purple': '#8a4fd0', 'file-teal': '#13837f',
    'danger': '#c4314b', 'ok': '#2c7a4f', 'warn': '#9a5b07',
    'add-bg': 'rgba(44, 122, 79, 0.1)', 'del-bg': 'rgba(196, 49, 75, 0.09)', 'add-char': 'rgba(44, 122, 79, 0.22)', 'del-char': 'rgba(196, 49, 75, 0.2)',
    'fg-rgb': '0 0 0', 'bg-menu': '#ffffff', 'selection': '#cfe0f3', 'primary-bg': '#1d1d1f', 'primary-fg': '#fafafa',
    'on-accent': '#ffffff', 'on-danger': '#ffffff', 'info': '#2f6497', 'violet': '#5a5fc0', 'pink': '#a3346f',
    'shadow-ink': 'rgb(0 0 0 / 34%)', 'scrim': 'rgb(0 0 0 / 20%)', 'bg-sunken': '#f3f3f3', 'hue-l': '36%',
  },
};

/** The colours a theme author sees when picking: shown as swatches and used by the contrast test. */
export const SWATCH_TOKENS: readonly TokenKey[] = ['bg', 'bg-raised', 'nav-solid', 'text', 'accent'];

// ---- colour values --------------------------------------------------------------------------------------------

export interface Rgba { r: number; g: number; b: number; a: number }
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Digits, dots, percent signs, whitespace, commas, slashes, signs and the `deg` unit: nothing else can appear inside rgb()/hsl(). */
const FUNC = /^(rgba?|hsla?)\(([0-9.%\s,/+-]*(?:deg)?[0-9.%\s,/+-]*)\)$/i;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function channel(text: string): number | null {
  const m = /^([+-]?\d*\.?\d+)(%?)$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? clamp(n * 2.55, 0, 255) : clamp(n, 0, 255);
}
function fraction(text: string | undefined): number | null {
  if (text === undefined) return 1;
  const m = /^([+-]?\d*\.?\d+)(%?)$/.exec(text);
  if (!m) return null;
  return clamp(m[2] ? Number(m[1]) / 100 : Number(m[1]), 0, 1);
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** null when the text is not one of: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(). */
export function parseColor(text: unknown): Rgba | null {
  if (typeof text !== 'string' || text.length > 64) return null;
  const value = text.trim();
  if (HEX.test(value)) {
    let h = value.slice(1);
    if (h.length <= 4) h = [...h].map(c => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return {r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1};
  }
  const m = FUNC.exec(value);
  if (!m) return null;
  const parts = m[2].trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  if (m[1].toLowerCase().startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map(channel);
    const a = fraction(parts[3]);
    if (rgb.some(c => c === null) || a === null) return null;
    return {r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, a};
  }
  const hue = /^([+-]?\d*\.?\d+)(?:deg)?$/.exec(parts[0]);
  const s = fraction(parts[1]), l = fraction(parts[2]), a = fraction(parts[3]);
  if (!hue || s === null || l === null || a === null || !parts[1].endsWith('%') || !parts[2].endsWith('%')) return null;
  const [r, g, b] = hslToRgb(((Number(hue[1]) % 360) + 360) % 360, s, l);
  return {r, g, b, a};
}

/** The one gate for a token value: true only for a value that is safe to hand to style.setProperty. */
export function isSafeTokenValue(key: string, value: unknown): value is string {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(TOKEN_KINDS, key)) return false;
  const kind = TOKEN_KINDS[key as TokenKey];
  const v = value.trim();
  if (kind === 'triple') return /^(?:\d{1,3}) (?:\d{1,3}) (?:\d{1,3})$/.test(v) && v.split(' ').every(n => Number(n) <= 255);
  if (kind === 'percent') return /^\d{1,3}(?:\.\d+)?%$/.test(v) && Number.parseFloat(v) <= 100;
  return parseColor(v) !== null;
}

// ---- contrast ---------------------------------------------------------------------------------------------------

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = ({r, g, b}: Rgba) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** `top` painted over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  return {r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1};
}
/** WCAG 2.x contrast ratio of `fg` (alpha allowed) drawn on the opaque `bg`. */
export function contrastRatio(fg: string, bg: string): number {
  const b = parseColor(bg), f = parseColor(fg);
  if (!b || !f) return NaN;
  const lf = luminance(composite(f, composite(b, {r: 0, g: 0, b: 0, a: 1}))), lb = luminance(composite(b, {r: 0, g: 0, b: 0, a: 1}));
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text-on-surface pairs every theme is checked on (WCAG AA 4.5:1; `faint` is secondary text, held to 3:1 on the shipped themes). */
export const TEXT_PAIRS: ReadonlyArray<{fg: TokenKey; bg: TokenKey; min: number; strict: boolean}> = [
  {fg: 'text', bg: 'bg', min: 4.5, strict: true}, {fg: 'text-strong', bg: 'bg', min: 4.5, strict: true}, {fg: 'text', bg: 'bg-raised', min: 4.5, strict: true},
  {fg: 'text', bg: 'nav-solid', min: 4.5, strict: true}, {fg: 'text', bg: 'bg-menu', min: 4.5, strict: true},
  {fg: 'text-dim', bg: 'bg', min: 4.5, strict: true}, {fg: 'text-dim', bg: 'bg-raised', min: 4.5, strict: true},
  {fg: 'text-faint', bg: 'bg', min: 3, strict: false},
  {fg: 'link', bg: 'bg', min: 4.5, strict: true}, {fg: 'accent', bg: 'bg', min: 3, strict: false},
  {fg: 'danger', bg: 'bg', min: 4.5, strict: true}, {fg: 'ok', bg: 'bg', min: 4.5, strict: true}, {fg: 'warn', bg: 'bg', min: 4.5, strict: true},
  {fg: 'primary-fg', bg: 'primary-bg', min: 4.5, strict: true}, {fg: 'on-accent', bg: 'accent', min: 4.5, strict: true},
];

/** A theme's effective tokens: its own over its base's. */
export const effectiveTokens = (theme: Theme): Record<TokenKey, string> => ({...BASE_TOKENS[theme.base], ...theme.tokens});

export interface ContrastFailure { fg: TokenKey; bg: TokenKey; ratio: number; min: number }
export function contrastFailures(theme: Theme, pairs = TEXT_PAIRS): ContrastFailure[] {
  const t = effectiveTokens(theme);
  return pairs.flatMap(({fg, bg, min}) => {
    const ratio = contrastRatio(t[fg], t[bg]);
    return ratio >= min ? [] : [{fg, bg, ratio, min}];
  });
}

// ---- validation -------------------------------------------------------------------------------------------------

export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_CUSTOM_THEMES = 24;
/** Plain text only: control characters and markup characters are dropped, so a name can be rendered or exported verbatim. */
export const cleanThemeName = (name: unknown): string => (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f\u007f<>`"'\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Keeps only known tokens with safe values. Returns null for a non-object. */
export function sanitizeTokens(raw: unknown): ThemeTokens | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: ThemeTokens = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) if (isSafeTokenValue(key, value)) out[key as TokenKey] = (value as string).trim();
  return out;
}

/** A stored or exported theme, or null when it is not one. Unsafe token values are dropped, never passed on. */
export function parseTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = cleanThemeName(r.name);
  const tokens = sanitizeTokens(r.tokens);
  if (typeof r.id !== 'string' || !THEME_ID.test(r.id) || !name || (r.base !== 'dark' && r.base !== 'light') || !tokens) return null;
  return {id: r.id, name, base: r.base, tokens};
}
export function parseThemeList(raw: unknown): Theme[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CUSTOM_THEMES) return null;
  const themes = raw.map(parseTheme);
  const ids = new Set<string>();
  for (const theme of themes) { if (!theme || ids.has(theme.id) || BUILT_IN_THEMES.some(b => b.id === theme.id)) return null; ids.add(theme.id); }
  return themes as Theme[];
}

/** True only when nothing in the list would be altered by parseThemeList: used to reject (not silently clean) a stored list. */
export function isCleanThemeList(raw: unknown): raw is Theme[] {
  const parsed = parseThemeList(raw);
  if (!parsed) return false;
  return parsed.every((theme, i) => {
    const r = (raw as Array<{name: unknown; tokens: Record<string, unknown>}>)[i];
    return r.name === theme.name && Object.keys(r.tokens).length === Object.keys(theme.tokens).length;
  });
}

// ---- built-in themes ----------------------------------------------------------------------------------------------

interface Palette {
  bg: string; raised: string; nav: string; menu: string; text: string; accent: string; link: string; selection: string;
  danger: string; ok: string; warn: string; primary: string; primaryFg: string; onAccent: string;
  /** Overlay alphas: [hover, active, hairline, dim, faint] (percent of the text colour). */
  alpha: [number, number, number, number, number];
  files: [string, string, string, string, string, string];
  info: string; violet: string; pink: string; sunken: string; hueL: string;
  /** Emphasis text (bold, headings); defaults to white on dark and black on light. */
  strong?: string;
}
const hex = (h: string): [number, number, number] => { const c = parseColor(h)!; return [Math.round(c.r), Math.round(c.g), Math.round(c.b)]; };
const rgbAlpha = (h: string, pct: number) => { const [r, g, b] = hex(h); return `rgb(${r} ${g} ${b} / ${pct}%)`; };
const rgbaTint = (h: string, a: number) => { const [r, g, b] = hex(h); return `rgba(${r}, ${g}, ${b}, ${a})`; };

function make(id: string, name: string, base: ThemeBase, p: Palette, fgRgb: string, shadow: string, scrim: string): Theme {
  const [hover, active, hairline, dim, faint] = p.alpha;
  const overlay = (a: number) => `rgb(${fgRgb} / ${a}%)`;
  return {id, name, base, tokens: {
    'bg': p.bg, 'bg-raised': p.raised, 'bg-hover': overlay(hover), 'bg-active': overlay(active), 'hairline': overlay(hairline),
    'nav-material': rgbAlpha(p.nav, 55), 'nav-solid': p.nav, 'text': p.text, 'text-strong': p.strong ?? (base === 'dark' ? '#ffffff' : '#000000'), 'text-dim': rgbAlpha(p.text, dim), 'text-faint': rgbAlpha(p.text, faint),
    'accent': p.accent, 'link': p.link,
    'file-blue': p.files[0], 'file-yellow': p.files[1], 'file-green': p.files[2], 'file-red': p.files[3], 'file-purple': p.files[4], 'file-teal': p.files[5],
    'danger': p.danger, 'ok': p.ok, 'warn': p.warn,
    'add-bg': rgbaTint(p.ok, 0.14), 'del-bg': rgbaTint(p.danger, 0.14), 'add-char': rgbaTint(p.ok, 0.3), 'del-char': rgbaTint(p.danger, 0.3),
    'fg-rgb': fgRgb, 'bg-menu': p.menu, 'selection': p.selection, 'primary-bg': p.primary, 'primary-fg': p.primaryFg,
    'on-accent': p.onAccent, 'on-danger': base === 'dark' ? '#1a0d10' : '#ffffff', 'info': p.info, 'violet': p.violet, 'pink': p.pink,
    'shadow-ink': shadow, 'scrim': scrim, 'bg-sunken': p.sunken, 'hue-l': p.hueL,
  }};
}

export const MUSTER_DARK: Theme = {id: 'muster-dark', name: 'Muster Dark', base: 'dark', tokens: {}};
export const MUSTER_LIGHT: Theme = {id: 'muster-light', name: 'Muster Light', base: 'light', tokens: {}};

export const BUILT_IN_THEMES: readonly Theme[] = [
  MUSTER_LIGHT,
  MUSTER_DARK,
  make('high-contrast-dark', 'High Contrast Dark', 'dark', {
    bg: '#000000', raised: '#0a0a0a', nav: '#050505', menu: '#141414', text: '#ffffff', accent: '#6fc3ff', link: '#8fd0ff', selection: '#264f78',
    danger: '#ff8095', ok: '#6be39a', warn: '#ffc857', primary: '#ffffff', primaryFg: '#000000', onAccent: '#000000',
    alpha: [12, 20, 45, 88, 72], files: ['#7ab8ff', '#ffd75e', '#8fe36a', '#ff8a7a', '#d7a8ff', '#63e0da'],
    info: '#a9d4ff', violet: '#b9bcff', pink: '#ff9fd2', sunken: '#000000', hueL: '72%',
  }, '255 255 255', '#000', 'rgb(0 0 0 / 60%)'),
  make('high-contrast-light', 'High Contrast Light', 'light', {
    bg: '#ffffff', raised: '#ffffff', nav: '#f2f2f2', menu: '#ffffff', text: '#000000', accent: '#00478f', link: '#0033a0', selection: '#b3d4fc',
    danger: '#a4001f', ok: '#00561f', warn: '#6b3d00', primary: '#000000', primaryFg: '#ffffff', onAccent: '#ffffff',
    alpha: [8, 14, 55, 88, 72], files: ['#0b4fbf', '#6b5000', '#1d6b0c', '#a4261a', '#6a2fb0', '#005f5c'],
    info: '#00478f', violet: '#3f43a8', pink: '#8a1c58', sunken: '#f5f5f5', hueL: '30%',
  }, '0 0 0', 'rgb(0 0 0 / 45%)', 'rgb(0 0 0 / 35%)'),
  make('solarized-dark', 'Solarized Dark', 'dark', {
    bg: '#002b36', raised: '#073642', nav: '#00212b', menu: '#073642', text: '#eee8d5', accent: '#5fb0e8', link: '#6cb8ec', selection: '#0d4a5a',
    danger: '#ff7a73', ok: '#a3b800', warn: '#d9a21b', primary: '#eee8d5', primaryFg: '#002b36', onAccent: '#00212b',
    alpha: [6, 10, 14, 80, 62], files: ['#4aa3e5', '#d9a21b', '#9bb000', '#ee6a62', '#8f94e0', '#34b5a6'],
    info: '#7bbfe6', violet: '#9a9fe8', pink: '#e079b0', sunken: '#00252f', hueL: '62%', strong: '#fdf6e3',
  }, '238 232 213', '#000', 'rgb(0 20 26 / 55%)'),
  make('solarized-light', 'Solarized Light', 'light', {
    bg: '#fdf6e3', raised: '#fffbed', nav: '#eee8d5', menu: '#fffbed', text: '#3c4f56', accent: '#1f6fa8', link: '#1a62a0', selection: '#e3dcc2',
    danger: '#b9302a', ok: '#5c6b00', warn: '#8a5a00', primary: '#073642', primaryFg: '#fdf6e3', onAccent: '#ffffff',
    alpha: [5, 8, 12, 92, 84], files: ['#1f6fa8', '#8a6a00', '#4f6b00', '#b9302a', '#5f5fb0', '#13766c'],
    info: '#1f6fa8', violet: '#5a5fb0', pink: '#a83a78', sunken: '#f5eed9', hueL: '34%', strong: '#002b36',
  }, '7 54 66', 'rgb(7 54 66 / 28%)', 'rgb(7 54 66 / 22%)'),
  make('github-dark', 'GitHub Dark', 'dark', {
    bg: '#0d1117', raised: '#161b22', nav: '#010409', menu: '#161b22', text: '#e6edf3', accent: '#58a6ff', link: '#58a6ff', selection: '#1f3a5f',
    danger: '#ff7b72', ok: '#56d364', warn: '#e3b341', primary: '#238636', primaryFg: '#ffffff', onAccent: '#04101f',
    alpha: [6, 10, 14, 78, 62], files: ['#58a6ff', '#e3b341', '#56d364', '#ff7b72', '#d2a8ff', '#76e3ea'],
    info: '#79c0ff', violet: '#bc8cff', pink: '#f778ba', sunken: '#010409', hueL: '66%',
  }, '230 237 243', '#000', 'rgb(1 4 9 / 60%)'),
  make('sepia', 'Warm Sepia', 'light', {
    bg: '#f4ecd8', raised: '#fbf5e6', nav: '#ece2c8', menu: '#fbf5e6', text: '#3b2f20', accent: '#8a4f1a', link: '#7a4210', selection: '#e0d2ae',
    danger: '#a8302a', ok: '#3f6b2a', warn: '#85520a', primary: '#3b2f20', primaryFg: '#fbf5e6', onAccent: '#ffffff',
    alpha: [5, 8, 12, 92, 82], files: ['#2f62a8', '#85650a', '#3f6b2a', '#a8302a', '#6b43a0', '#1f7068'],
    info: '#2f62a8', violet: '#5f4fb0', pink: '#a03a6c', sunken: '#eee5cf', hueL: '34%', strong: '#1f1710',
  }, '59 47 32', 'rgb(59 47 32 / 30%)', 'rgb(59 47 32 / 24%)'),
];

export const DEFAULT_LIGHT_THEME_ID = MUSTER_LIGHT.id;
export const DEFAULT_DARK_THEME_ID = MUSTER_DARK.id;

export const findTheme = (id: string | undefined, custom: readonly Theme[] = []): Theme | undefined =>
  BUILT_IN_THEMES.find(t => t.id === id) ?? custom.find(t => t.id === id);

/** The theme painted for a resolved appearance. A missing or wrong-base id falls back to the stylesheet (no overrides). */
export function pickTheme(mode: ThemeBase, lightId: string | undefined, darkId: string | undefined, custom: readonly Theme[] = []): Theme {
  const found = findTheme(mode === 'light' ? lightId : darkId, custom);
  return found && found.base === mode ? found : mode === 'light' ? MUSTER_LIGHT : MUSTER_DARK;
}

// ---- applying -----------------------------------------------------------------------------------------------------

export interface StyleTarget { setAttribute(name: string, value: string): void; removeAttribute(name: string): void; style: {setProperty(name: string, value: string): void; removeProperty(name: string): string} }

/** Paints a theme with CSS custom properties on `root`. Clears every previously applied token first, so switching back
 *  to a stock theme leaves `root` exactly as the stylesheet alone would. Unsafe values are skipped, not applied. */
export function applyThemeTokens(root: StyleTarget, theme: Theme): void {
  for (const key of TOKEN_KEYS) root.style.removeProperty(`--${key}`);
  const builtinStock = theme.id === MUSTER_DARK.id || theme.id === MUSTER_LIGHT.id;
  for (const key of TOKEN_KEYS) {
    const value = theme.tokens[key];
    if (!builtinStock && value !== undefined && isSafeTokenValue(key, value)) root.style.setProperty(`--${key}`, value.trim());
  }
  if (builtinStock) root.removeAttribute('data-theme-id'); else root.setAttribute('data-theme-id', theme.id);
}

// ---- no-flash startup cache -------------------------------------------------------------------------------------------

export const BOOT_CACHE_KEY = 'muster.theme.boot';
export interface BootCache { preference: 'system' | 'dark' | 'light'; light: Theme | null; dark: Theme | null }

export function bootCacheFor(preference: BootCache['preference'], light: Theme, dark: Theme): BootCache {
  const own = (t: Theme) => (t.id === MUSTER_LIGHT.id || t.id === MUSTER_DARK.id ? null : t);
  return {preference, light: own(light), dark: own(dark)};
}
/** Re-validates everything: the cache is just localStorage text and must never reach the DOM unchecked. */
export function parseBootCache(text: string | null | undefined): BootCache | null {
  if (!text || text.length > 64_000) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const preference = raw.preference;
    if (preference !== 'system' && preference !== 'dark' && preference !== 'light') return null;
    const light = raw.light === null ? null : parseTheme(raw.light), dark = raw.dark === null ? null : parseTheme(raw.dark);
    if ((raw.light !== null && !light) || (raw.dark !== null && !dark)) return null;
    return {preference, light, dark};
  } catch { return null; }
}

// ---- VS Code colour themes ------------------------------------------------------------------------------------------------

export interface ImportResult { theme: Theme; warnings: string[] }
export class ThemeImportError extends Error {}

/** VS Code theme files are JSON with comments and trailing commas. Strips both, leaving string contents alone. */
export function stripJsonComments(source: string): string {
  let out = '', i = 0;
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && n === '/') { while (i < source.length && source[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; }
    else { out += c; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Which VS Code colour keys feed each token, first present wins. */
const VSCODE_SOURCES: Partial<Record<TokenKey, string[]>> = {
  'bg': ['editor.background'],
  'bg-raised': ['editorWidget.background', 'input.background', 'sideBarSectionHeader.background', 'tab.inactiveBackground'],
  'nav-solid': ['sideBar.background', 'activityBar.background'],
  'bg-menu': ['menu.background', 'quickInput.background', 'editorWidget.background', 'dropdown.background'],
  'bg-sunken': ['statusBar.background', 'terminal.background', 'panel.background'],
  'text': ['editor.foreground', 'foreground'],
  'accent': ['focusBorder', 'activityBarBadge.background', 'button.background', 'statusBar.background'],
  'link': ['textLink.foreground', 'editorLink.activeForeground'],
  'danger': ['errorForeground', 'editorError.foreground', 'terminal.ansiRed'],
  'ok': ['gitDecoration.addedResourceForeground', 'terminal.ansiGreen', 'editorGutter.addedBackground'],
  'warn': ['editorWarning.foreground', 'list.warningForeground', 'terminal.ansiYellow'],
  'selection': ['editor.selectionBackground', 'list.activeSelectionBackground'],
  'primary-bg': ['button.background'],
  'primary-fg': ['button.foreground'],
  'hairline': ['sideBar.border', 'panel.border', 'editorGroup.border', 'activityBar.border'],
  'file-blue': ['terminal.ansiBlue'], 'file-yellow': ['terminal.ansiYellow'], 'file-green': ['terminal.ansiGreen'],
  'file-red': ['terminal.ansiRed'], 'file-purple': ['terminal.ansiMagenta'], 'file-teal': ['terminal.ansiCyan'],
  'info': ['terminal.ansiBrightBlue', 'terminal.ansiBlue'], 'violet': ['terminal.ansiBrightMagenta', 'terminal.ansiMagenta'],
};
/** Every VS Code key above, so a bad value for any of them rejects the file. */
const VSCODE_KEYS = [...new Set(Object.values(VSCODE_SOURCES).flat() as string[])];

const toHex = (c: Rgba) => '#' + [c.r, c.g, c.b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
const overlayColor = (c: Rgba, a: number) => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${pct(a * 100)})`;

/** Maps a VS Code colour theme (JSON text) onto a Muster theme. Throws ThemeImportError with a sentence the user can act on.
 *  Only colour values in #hex / rgb() / hsl() form are accepted for the keys we read; everything else in the file is ignored. */
export function importVsCodeTheme(source: string, idHint = ''): ImportResult {
  if (typeof source !== 'string' || source.length > 2_000_000) throw new ThemeImportError('That file is too large to be a colour theme.');
  let doc: unknown;
  try { doc = JSON.parse(stripJsonComments(source)); } catch { throw new ThemeImportError('That file is not valid JSON.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ThemeImportError('That file is not a VS Code colour theme.');
  const d = doc as Record<string, unknown>;
  const colors = d.colors;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors) || !Object.keys(colors).length) throw new ThemeImportError('No "colors" section found: this is not a VS Code colour theme.');
  const c = colors as Record<string, unknown>;

  const bad = VSCODE_KEYS.filter(key => key in c && parseColor(c[key]) === null);
  if (bad.length) throw new ThemeImportError(`Rejected: ${bad.slice(0, 3).map(k => `"${k}"`).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''} ${bad.length === 1 ? 'is' : 'are'} not a #hex, rgb() or hsl() colour.`);

  const typeName = typeof d.type === 'string' ? d.type.toLowerCase() : '';
  const bgColor = parseColor(c['editor.background']);
  let base: ThemeBase = typeName === 'light' || typeName === 'hc-light' ? 'light' : typeName === 'dark' || typeName === 'hc' || typeName === 'hc-black' ? 'dark' : bgColor ? (luminance(bgColor) > 0.4 ? 'light' : 'dark') : 'dark';
  const fallback = BASE_TOKENS[base];
  const pick = (token: TokenKey): Rgba | null => {
    for (const key of VSCODE_SOURCES[token] ?? []) { const v = parseColor(c[key]); if (v) return v; }
    return null;
  };
  const warnings: string[] = [];
  const tokens: ThemeTokens = {};
  const opaque = (token: TokenKey, under: Rgba) => { const v = pick(token); if (v) tokens[token] = toHex(v.a < 1 ? composite(v, under) : v); return v; };

  const bg = parseColor(fallback.bg)!;
  const theBg = opaque('bg', bg) ? parseColor(tokens.bg)! : bg;
  for (const token of ['bg-raised', 'bg-menu', 'nav-solid', 'bg-sunken', 'selection'] as TokenKey[]) opaque(token, theBg);
  for (const token of ['text', 'accent', 'link', 'danger', 'ok', 'warn', 'primary-bg', 'primary-fg', 'file-blue', 'file-yellow', 'file-green', 'file-red', 'file-purple', 'file-teal', 'info', 'violet'] as TokenKey[]) opaque(token, theBg);

  if (tokens.text) {
    const t = parseColor(tokens.text)!;
    tokens['text-dim'] = overlayColor(t, 0.74); tokens['text-faint'] = overlayColor(t, 0.52);
    tokens['fg-rgb'] = base === 'dark' ? '255 255 255' : '0 0 0';
  }
  const border = pick('hairline');
  if (border) tokens.hairline = overlayColor(border, Math.max(0.06, Math.min(border.a, 0.6)));
  if (tokens['nav-solid']) tokens['nav-material'] = overlayColor(parseColor(tokens['nav-solid'])!, 0.55);
  if (tokens.ok) { const ok = parseColor(tokens.ok)!; tokens['add-bg'] = `rgba(${Math.round(ok.r)}, ${Math.round(ok.g)}, ${Math.round(ok.b)}, 0.12)`; tokens['add-char'] = `rgba(${Math.round(ok.r)}, ${Math.round(ok.g)}, ${Math.round(ok.b)}, 0.28)`; }
  if (tokens.danger) { const dg = parseColor(tokens.danger)!; tokens['del-bg'] = `rgba(${Math.round(dg.r)}, ${Math.round(dg.g)}, ${Math.round(dg.b)}, 0.12)`; tokens['del-char'] = `rgba(${Math.round(dg.r)}, ${Math.round(dg.g)}, ${Math.round(dg.b)}, 0.28)`; }
  if (tokens.accent) {
    const a = parseColor(tokens.accent)!;
    tokens['on-accent'] = luminance(a) > 0.4 ? '#10161c' : '#ffffff';
  }
  if (tokens['primary-bg'] && !tokens['primary-fg']) tokens['primary-fg'] = luminance(parseColor(tokens['primary-bg'])!) > 0.4 ? '#171717' : '#ffffff';

  const mapped = Object.keys(tokens).length;
  if (!tokens.bg && !tokens.text) throw new ThemeImportError('This theme sets neither editor.background nor editor.foreground, so there is nothing to map.');
  if (!tokens.bg) warnings.push('No editor.background: the stock background was kept.');
  if (!tokens.text) warnings.push('No editor.foreground: the stock text colour was kept.');
  warnings.push(`${mapped} tokens set from the file; the rest come from Muster ${base === 'dark' ? 'Dark' : 'Light'}. Syntax colours follow the app, not the file.`);

  const name = cleanThemeName(d.name) || 'Imported theme';
  const id = (idHint || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'imported';
  const theme: Theme = {id, name, base, tokens: sanitizeTokens({...tokens}) ?? {}};
  const failures = contrastFailures(theme, TEXT_PAIRS.filter(p => p.strict && p.bg === 'bg' && (p.fg === 'text' || p.fg === 'link')));
  for (const f of failures) warnings.push(`Low contrast: ${f.fg} on ${f.bg} is ${f.ratio.toFixed(1)}:1 (AA wants ${f.min}:1).`);
  return {theme, warnings};
}

/** A custom theme's export: complete, so it re-imports into any install unchanged. */
export function exportTheme(theme: Theme): string {
  return JSON.stringify({muster: 'theme', version: 1, id: theme.id, name: theme.name, base: theme.base, tokens: effectiveTokens(theme)}, null, 2) + '\n';
}
/** Reads either an export from exportTheme or a VS Code theme. */
export function importThemeFile(text: string, existingIds: readonly string[] = []): ImportResult {
  let native: Theme | null = null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw && raw.muster === 'theme') native = parseTheme(raw);
    if (raw && raw.muster === 'theme' && !native) throw new ThemeImportError('That Muster theme file is malformed.');
  } catch (error) { if (error instanceof ThemeImportError) throw error; }
  const result = native ? {theme: native, warnings: [] as string[]} : importVsCodeTheme(text);
  let id = result.theme.id, n = 2;
  const taken = (x: string) => existingIds.includes(x) || BUILT_IN_THEMES.some(t => t.id === x);
  while (taken(id)) id = `${result.theme.id.slice(0, 44)}-${n++}`;
  return {...result, theme: {...result.theme, id}};
}
