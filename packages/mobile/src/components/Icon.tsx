/** Icons from the v3 design (24 × 24, 2 pt strokes, round caps), drawn with react-native-svg. */
import {Circle, Path, Rect, Svg} from 'react-native-svg';

type Shape = ['path', string, boolean] | ['circle', number, number, number, boolean] | ['rect', number, number, number, number, number];
const ICONS = {
  chevL: [['path', 'm15 18-6-6 6-6', false]],
  chevR: [['path', 'm9 18 6-6-6-6', false]],
  chevD: [['path', 'm6 9 6 6 6-6', false]],
  chevU: [['path', 'm6 15 6-6 6 6', false]],
  plus: [['path', 'M12 5v14M5 12h14', false]],
  compose: [['path', 'M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5', false], ['path', 'M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6Z', false]],
  search: [['circle', 11, 11, 7, false], ['path', 'm20 20-3.6-3.6', false]],
  more: [['circle', 5.5, 12, 1.3, true], ['circle', 12, 12, 1.3, true], ['circle', 18.5, 12, 1.3, true]],
  chats: [['path', 'M20.5 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.4-4.4A8.5 8.5 0 1 1 20.5 11.5Z', false]],
  needs: [['path', 'M4 13.5 6.3 5.6A2 2 0 0 1 8.2 4h7.6a2 2 0 0 1 1.9 1.6L20 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', false], ['path', 'M4 13.5h4.5l1.2 2.5h4.6l1.2-2.5H20', false]],
  projects: [['rect', 3.5, 3.5, 7, 8, 2], ['rect', 13.5, 3.5, 7, 5, 2], ['rect', 13.5, 11.5, 7, 9, 2], ['rect', 3.5, 14.5, 7, 6, 2]],
  gear: [['circle', 12, 12, 3, false], ['path', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z', false]],
  mic: [['rect', 9, 3, 6, 11, 3], ['path', 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21', false]],
  up: [['path', 'M12 19V5M5.5 11.5 12 5l6.5 6.5', false]],
  stop: [['rect', 6.5, 6.5, 11, 11, 2.5]],
  clip: [['path', 'm20.5 11.5-8.4 8.4a5.3 5.3 0 0 1-7.5-7.5l8.4-8.4a3.5 3.5 0 0 1 5 5l-8.4 8.4a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8', false]],
  camera: [['path', 'M3.5 8.5a2 2 0 0 1 2-2h2.2l1.6-2h5.4l1.6 2h2.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z', false], ['circle', 12, 13, 3.5, false]],
  check: [['path', 'M20 6.5 9.5 17 4 11.5', false]],
  x: [['path', 'M18 6 6 18M6 6l12 12', false]],
  branch: [['circle', 6, 5.5, 2.2, false], ['circle', 6, 18.5, 2.2, false], ['circle', 18, 7.5, 2.2, false], ['path', 'M6 7.7v8.6M18 9.7c0 4-3 5.3-6 5.3H8.2', false]],
  term: [['rect', 3, 4, 18, 16, 3], ['path', 'm7.5 9.5 3 2.5-3 2.5M12.5 15h4', false]],
  file: [['path', 'M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z', false], ['path', 'M14 3.5v5h5', false]],
  folder: [['path', 'M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z', false]],
  diff: [['path', 'M8 4v10M3 9h10M14 20h7', false], ['path', 'M16 4h3a2 2 0 0 1 2 2v7', false]],
  laptop: [['rect', 4.5, 5, 15, 10.5, 1.6], ['path', 'M2.5 19h19', false]],
  desktop: [['rect', 3, 4, 18, 12, 2], ['path', 'M9 20h6M12 16v4', false]],
  lock: [['rect', 5, 10.5, 14, 10, 2.5], ['path', 'M8 10.5V7.5a4 4 0 0 1 8 0v3', false]],
  shield: [['path', 'M12 3 4.5 6v5.5c0 4.7 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.8 7.5-9.5V6Z', false], ['path', 'm8.8 12 2.2 2.2 4.3-4.4', false]],
  cloud: [['path', 'M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6 3.8 3.8 0 0 1-.6 7.4Z', false]],
  undo: [['path', 'M9 14.5 4 9.5l5-5', false], ['path', 'M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11', false]],
  refresh: [['path', 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5', false], ['path', 'M20.5 3.5v5h-5', false]],
  eye: [['path', 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z', false], ['circle', 12, 12, 3, false]],
  hand: [['path', 'M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7 6.5 6.5 0 0 1-5.4-2.9l-2.4-3.8a1.5 1.5 0 0 1 2.5-1.6L8 15', false]],
  alert: [['path', 'M10.3 4 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z', false], ['path', 'M12 9.5v4M12 17h.01', false]],
  clock: [['circle', 12, 12, 8.5, false], ['path', 'M12 7.5V12l3 2', false]],
  image: [['rect', 3.5, 4.5, 17, 15, 3], ['circle', 9, 10, 1.8, false], ['path', 'm20.5 15.5-4.8-4.8-9.2 8.8', false]],
  sidebar: [['rect', 3, 4, 18, 16, 3], ['path', 'M9.5 4v16', false]],
  split: [['rect', 3, 4, 18, 16, 3], ['path', 'M12 4v16', false]],
  list: [['path', 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01', false]],
  copy: [['rect', 8.5, 8.5, 12, 12, 2.5], ['path', 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5', false]],
  sparkle: [['path', 'M12 3.5 13.9 9l5.6 2-5.6 2L12 18.5 10.1 13l-5.6-2 5.6-2Z', false]],
  phone: [['rect', 6.5, 2.5, 11, 19, 2.5], ['path', 'M11 18.5h2', false]],
  wifi: [['path', 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0', false], ['circle', 12, 19.3, 1, true]],
  trash: [['path', 'M4 6.5h16M9.5 6.5V4.5h5v2M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5l1-13', false]],
  qr: [['rect', 3.5, 3.5, 7, 7, 1.5], ['rect', 13.5, 3.5, 7, 7, 1.5], ['rect', 3.5, 13.5, 7, 7, 1.5], ['path', 'M13.5 13.5h3v3M20.5 13.5v7h-7', false]],
  wrap: [['path', 'M3.5 6h17M3.5 12h14a3 3 0 0 1 0 6h-4M3.5 18h6', false], ['path', 'm15.5 16 -2 2 2 2', false]],
} satisfies Record<string, Shape[]>;
export type IconName = keyof typeof ICONS;

export function Icon({name, size = 24, color, stroke = 2}: {name: IconName; size?: number; color: string; stroke?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" accessible={false}>
      {(ICONS[name] as Shape[]).map((shape, index) => shape[0] === 'path' ? <Path key={index} d={shape[1]} {...(shape[2] ? {fill: color, stroke: 'none'} : {})} />
        : shape[0] === 'circle' ? <Circle key={index} cx={shape[1]} cy={shape[2]} r={shape[3]} {...(shape[4] ? {fill: color, stroke: 'none'} : {})} />
        : <Rect key={index} x={shape[1]} y={shape[2]} width={shape[3]} height={shape[4]} rx={shape[5]} />)}
    </Svg>
  );
}
