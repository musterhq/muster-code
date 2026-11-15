import {palettes, type} from '../src/theme';
import {springs, springFor, CROSSFADE_MS} from '../src/motion';

/** WCAG relative luminance of a #rrggbb colour, with an rgba() colour laid over `under`. */
function rgb(color: string, under = '#000000'): [number, number, number] {
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (rgba) { const base = rgb(under); const a = Number(rgba[4]); return [0, 1, 2].map(i => Number(rgba[i + 1]) * a + base[i]! * (1 - a)) as [number, number, number]; }
  const hex = color.replace('#', '');
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
const luminance = ([r, g, b]: [number, number, number]) => [r, g, b].map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (fg: string, bg: string) => { const [a, b] = [luminance(rgb(fg, bg)), luminance(rgb(bg))]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

// Spec: MUS-SPEC-23-24A (docs/spec/clauses/23-mobile.md#mus-spec-23-24a)
test('the v3 palettes keep text readable, the type never goes under 12 and Reduce Motion turns springs into a crossfade', () => {
  expect(palettes.dark.background).toBe('#0e0e0e');
  expect(palettes.dark.surface).toBe('#1a1a1c');
  expect(palettes.dark.raised).toBe('#242426');
  expect(palettes.dark.fill).toBe('#2e2e31');
  expect(palettes.dark.bubble).toBe('#2a2c30');
  expect(palettes.light.background).toBe('#f2f2f7');
  expect(palettes.light.surface).toBe('#ffffff');
  for (const c of [palettes.dark, palettes.light]) {
    for (const surface of [c.background, c.surface, c.raised]) {
      expect(contrast(c.text, surface)).toBeGreaterThanOrEqual(7);
      expect(contrast(c.muted, surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(c.onAccent, c.accentFill)).toBeGreaterThanOrEqual(4.5);
    for (const hue of [c.accent, c.warning, c.success, c.danger]) expect(contrast(hue, c.background)).toBeGreaterThanOrEqual(3);
  }
  for (const style of Object.values(type)) expect(style.fontSize).toBeGreaterThanOrEqual(12);
  expect([type.prose.fontSize, type.prose.lineHeight]).toEqual([17, 26]);
  expect([type.code.fontSize, type.code.lineHeight]).toEqual([13, 21]);
  expect([type.largeTitle.fontSize, type.largeTitle.lineHeight]).toEqual([34, 41]);
  expect(springs.snappy).toMatchObject({damping: 26, mass: 0.7, stiffness: 330});
  expect(springs.gentle).toMatchObject({damping: 20, mass: 1, stiffness: 180});
  expect(springs.bouncy).toMatchObject({damping: 14, mass: 0.8, stiffness: 260});
  expect(springFor('gentle', false)).toEqual({kind: 'spring', config: springs.gentle});
  expect(springFor('bouncy', true)).toEqual({kind: 'fade', duration: CROSSFADE_MS});
  expect(CROSSFADE_MS).toBe(150);
});
