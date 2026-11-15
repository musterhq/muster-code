/** Colours and spacing from the desktop app's design tokens (packages/agent-app/src/renderer/styles.css), in the approved
 *  mobile concept's layout. The app follows the phone's light or dark setting (`useTheme`). Translucent desktop tokens are
 *  flattened onto their background, so contrast can be checked: body text and `muted` are at least 7:1, `faint` at least
 *  4.5:1, labels on `accentFill` at least 4.5:1 and `control` (button and field edges) at least 3:1 (MUS-SPEC-23-14B). */
import {Platform, useColorScheme} from 'react-native';

export interface Palette {
  scheme: 'dark' | 'light';
  background: string; surface: string; raised: string; menu: string; bubble: string; border: string; control: string;
  text: string; strong: string; muted: string; faint: string;
  accent: string; accentFill: string; onAccent: string; danger: string; success: string; warning: string;
  /** Diff and status tints behind added and removed lines. */
  addBg: string; delBg: string;
}
export const palettes: Record<'dark' | 'light', Palette> = {
  dark: {
    scheme: 'dark', background: '#0e0e0e', surface: '#161616', raised: '#1c1c1c', menu: '#1c1c1c', bubble: '#262626', border: '#1f1f1f', control: '#6b6b6b',
    text: '#e8e8e8', strong: '#ffffff', muted: '#ababab', faint: '#8c8c8c',
    accent: '#91abc2', accentFill: '#91abc2', onAccent: '#0e0e0e', danger: '#e5735f', success: '#5bb98c', warning: '#e0a84f',
    addBg: 'rgba(91,185,140,0.12)', delBg: 'rgba(229,115,95,0.12)',
  },
  light: {
    scheme: 'light', background: '#fbfbfb', surface: '#ffffff', raised: '#f2f2f4', menu: '#ffffff', bubble: '#ececef', border: '#e4e4e4', control: '#8a8a8e',
    text: '#1d1d1f', strong: '#000000', muted: '#575759', faint: '#6e6e70',
    accent: '#3b6a93', accentFill: '#3b6a93', onAccent: '#ffffff', danger: '#c4314b', success: '#2f8a18', warning: '#a07800',
    addBg: 'rgba(44,122,79,0.10)', delBg: 'rgba(196,49,75,0.09)',
  },
};
/** The dark palette, for code that runs outside React (tests, the status bar default). Screens use `useTheme`. */
export const colors = palettes.dark;
export const space = {xs: 4, s: 8, m: 12, l: 16, xl: 24};
export const radius = {s: 6, m: 10, l: 16};
export const font = {body: 15, small: 13, tiny: 11, title: 17, large: 22, mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace'};
/** The type scale (size / line height). */
export const type = {
  micro: {fontSize: 11, lineHeight: 14}, caption: {fontSize: 12, lineHeight: 16}, label: {fontSize: 13, lineHeight: 17}, footnote: {fontSize: 14, lineHeight: 19},
  body: {fontSize: 16, lineHeight: 23}, headline: {fontSize: 18, lineHeight: 23}, title: {fontSize: 21, lineHeight: 28}, largeTitle: {fontSize: 26, lineHeight: 32},
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
