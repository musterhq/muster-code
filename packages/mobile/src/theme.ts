/** Colors and spacing taken from the desktop app's design tokens (packages/agent-app, dark theme). Contrast on the dark
 *  backgrounds meets WCAG AA (MUS-SPEC-23-14B): `muted` text is at least 7:1, labels on `accentFill` at least 4.5:1, and
 *  `control` (button and field edges) at least 3:1. `accent` stays the link and status colour. */
export const colors = {
  background: '#141414', surface: '#1e1e1e', raised: '#262626', border: '#333333', control: '#7a7a7a',
  text: '#ededed', muted: '#b4b4b4', accent: '#5b8def', accentFill: '#3466cc', onAccent: '#ffffff', danger: '#e5484d', success: '#3fb950', warning: '#d29922',
};
export const space = {xs: 4, s: 8, m: 12, l: 16, xl: 24};
export const radius = {s: 6, m: 10, l: 16};
export const font = {body: 15, small: 13, title: 17, mono: 'Menlo'};
