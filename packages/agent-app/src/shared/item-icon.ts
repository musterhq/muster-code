/** Deterministic icon fallbacks shared by the runtime (manifest scan) and the renderer (menus, chips). */
import type { ItemIcon } from './protocol.ts';

const HUES = [212, 12, 38, 152, 280, 330, 190];
/** Same hash and palette as the renderer's agentHue, so a name keeps its colour everywhere. */
export function nameHue(name: string): number { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; }
export const BRAND_COLOR = /^#[0-9a-f]{6}$/i;
export function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}
/** Relative luminance (0..1) of #RRGGBB. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(index => { const v = parseInt(hex.slice(index, index + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** "Google Drive" → "GD", "heygen" → "H"; at most two uppercase characters. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').split(/[\s_-]+/).filter(Boolean);
  const value = words.length > 1 ? words.slice(0, 2).map(word => [...word][0]).join('') : [...(words[0] ?? '?')][0] ?? '?';
  return value.toUpperCase();
}
/** Monogram hue follows the brand colour when there is one, else a stable hash of `seed`. */
export function monogram(name: string, seed: string, brandColor?: string): ItemIcon {
  const brand = brandColor && BRAND_COLOR.test(brandColor) && luminance(brandColor) > 0.02 && luminance(brandColor) < 0.9 ? brandColor : undefined;
  return { kind: 'monogram', text: initials(name), hue: brand ? hueOf(brand) : nameHue(seed) };
}
