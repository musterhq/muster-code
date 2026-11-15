/** The v3 design tokens (#326 phase 5; ~/.muster-work design v3, binding): tonal surfaces instead of outlines, the iOS type
 *  scale, 20 pt text margins and 16 pt card margins, capsule buttons and the glass material. The app follows the phone's light
 *  or dark setting (`useTheme`). Primary text is at least 7:1 on every surface, secondary at least 4.5:1, and `faint`
 *  (tertiary) is for decoration only (MUS-SPEC-23-24A). */
import {Platform, useColorScheme} from 'react-native';

export interface Palette {
  scheme: 'dark' | 'light';
  /** The canvas, a grouped cell, a raised cell (inside a cell, sheets), a control fill, a menu and the user's bubble. */
  background: string; surface: string; raised: string; fill: string; menu: string; bubble: string;
  /** Code wells and inline code. */
  code: string; inline: string;
  /** Separators, inside cells only. */
  border: string;
  /** Edges of fields and controls that need 3:1. */
  control: string;
  text: string; strong: string; muted: string; faint: string;
  accent: string; accentFill: string; onAccent: string; danger: string; success: string; warning: string;
  /** 16 % tints behind status glyphs and tinted buttons, and 26 % for emphasis. */
  accentTint: string; accentTint2: string; successTint: string; warningTint: string; dangerTint: string;
  /** Diff lines and their changed words. */
  addBg: string; delBg: string; addWord: string; delWord: string;
  /** The glass material: fill, the specular top edge, the hairline and the selected-tab fill. */
  glass: string; glassHighlight: string; glassEdge: string; glassSelected: string;
  /** The badge on the Needs you tab. */
  badge: string;
  scrim: string;
}
export const palettes: Record<'dark' | 'light', Palette> = {
  dark: {
    scheme: 'dark', background: '#0e0e0e', surface: '#1a1a1c', raised: '#242426', fill: '#2e2e31', menu: '#1f1f21', bubble: '#2a2c30',
    code: '#141416', inline: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.09)', control: '#6b6b70',
    text: '#f2f2f3', strong: '#ffffff', muted: '#a7a7ad', faint: '#7e7e85',
    accent: '#91abc2', accentFill: '#91abc2', onAccent: '#0b1118', danger: '#e5735f', success: '#5bb98c', warning: '#e0a84f',
    accentTint: 'rgba(145,171,194,0.16)', accentTint2: 'rgba(145,171,194,0.26)', successTint: 'rgba(91,185,140,0.16)', warningTint: 'rgba(224,168,79,0.16)', dangerTint: 'rgba(229,115,95,0.16)',
    addBg: 'rgba(91,185,140,0.13)', delBg: 'rgba(229,115,95,0.13)', addWord: 'rgba(91,185,140,0.34)', delWord: 'rgba(229,115,95,0.34)',
    glass: 'rgba(38,38,42,0.52)', glassHighlight: 'rgba(255,255,255,0.16)', glassEdge: 'rgba(255,255,255,0.10)', glassSelected: 'rgba(255,255,255,0.14)',
    badge: '#d48a00', scrim: 'rgba(0,0,0,0.52)',
  },
  light: {
    scheme: 'light', background: '#f2f2f7', surface: '#ffffff', raised: '#ececf0', fill: '#e3e3e8', menu: '#ffffff', bubble: '#e4e6ea',
    code: '#f6f6f8', inline: 'rgba(0,0,0,0.06)', border: 'rgba(60,60,67,0.13)', control: '#8a8a8e',
    text: '#111113', strong: '#000000', muted: '#5c5c63', faint: '#7d7d85',
    accent: '#3b6a93', accentFill: '#3b6a93', onAccent: '#ffffff', danger: '#c4314b', success: '#2f8a5a', warning: '#a46a00',
    accentTint: 'rgba(59,106,147,0.11)', accentTint2: 'rgba(59,106,147,0.2)', successTint: 'rgba(47,138,90,0.12)', warningTint: 'rgba(196,132,0,0.13)', dangerTint: 'rgba(196,49,75,0.1)',
    addBg: 'rgba(47,138,90,0.10)', delBg: 'rgba(196,49,75,0.09)', addWord: 'rgba(47,138,90,0.26)', delWord: 'rgba(196,49,75,0.24)',
    glass: 'rgba(255,255,255,0.62)', glassHighlight: 'rgba(255,255,255,0.9)', glassEdge: 'rgba(0,0,0,0.06)', glassSelected: 'rgba(0,0,0,0.07)',
    badge: '#d48a00', scrim: 'rgba(0,0,0,0.25)',
  },
};
/** The dark palette, for code that runs outside React (tests, the status bar default). Screens use `useTheme`. */
export const colors = palettes.dark;
/** Spacing. Text sits 20 pt from the screen edge (`margin`), cards 16 (`card`). */
export const space = {xs: 4, s: 8, m: 12, l: 16, xl: 24, margin: 20, card: 16} as const;
/** Shapes: a cell group 26, a card 24, a sheet 38, capsule buttons 25 (50 tall) and 18 (36 tall), a code well 16. */
export const radius = {s: 6, m: 10, well: 16, card: 24, group: 26, sheet: 38, capsule: 25, small: 18} as const;
export const size = {primary: 50, small: 36, glassCircle: 44, chatRow: 72, glyph: 36, tabBar: 62} as const;
export const font = {mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace'};
/** The type scale (size / line height). Nothing is under 12. */
export const type = {
  largeTitle: {fontSize: 34, lineHeight: 41, fontWeight: '700'},
  title1: {fontSize: 28, lineHeight: 34, fontWeight: '700'},
  title2: {fontSize: 22, lineHeight: 28, fontWeight: '700'},
  title3: {fontSize: 20, lineHeight: 25, fontWeight: '600'},
  headline: {fontSize: 17, lineHeight: 22, fontWeight: '600'},
  body: {fontSize: 17, lineHeight: 22},
  prose: {fontSize: 17, lineHeight: 26},
  callout: {fontSize: 16, lineHeight: 21},
  subhead: {fontSize: 15, lineHeight: 20},
  footnote: {fontSize: 13, lineHeight: 18},
  caption: {fontSize: 12, lineHeight: 16},
  code: {fontSize: 13, lineHeight: 21, fontFamily: font.mono},
  codeBlock: {fontSize: 14, lineHeight: 21, fontFamily: font.mono},
} as const;
/** The smallest comfortable touch target (iOS 44 pt; Android rounds to 48 dp with hitSlop). */
export const touch = 44;

/** The palette for the phone's current light or dark setting; re-renders when it changes. */
export function useTheme(): Palette {
  return useColorScheme() === 'light' ? palettes.light : palettes.dark;
}
/** Styles made once per palette: `const useStyles = themed(c => StyleSheet.create({...}))`, then `useStyles()` in a component. */
export function themed<T>(make: (c: Palette) => T): () => T {
  const made = new Map<Palette, T>();
  return function useStyles() {
    const c = useTheme();
    let styles = made.get(c);
    if (!styles) { styles = make(c); made.set(c, styles); }
    return styles;
  };
}
