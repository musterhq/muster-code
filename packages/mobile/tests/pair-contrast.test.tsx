/** The pair screen is readable on a phone in daylight: WCAG AA contrast for its text and the camera prompt, and 3:1 for the
 *  edges of its buttons (WCAG 1.4.11). Colours are read from the rendered styles, not from the theme file. */
import {render, screen} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import {PairScreen} from '../src/screens/PairScreen';
import {QrScanner} from '../src/components/QrScanner';
import {createPairingStore, memorySecureStore} from '../src/connection/store';
import {colors} from '../src/theme';

jest.mock('expo-camera', () => ({CameraView: () => null, useCameraPermissions: () => [{granted: false}, jest.fn()]}));

const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const style = (node: {props: {style?: unknown}}) => StyleSheet.flatten(node.props.style as never) as {color?: string; backgroundColor?: string; borderColor?: string};
/** The closest ancestor that paints a background. */
const backdrop = (node: any, fallback: string): string => { for (let at = node.parent; at; at = at.parent) { const bg = at.props?.style ? style(at).backgroundColor : undefined; if (bg) return bg; } return fallback; };
const button = (label: string) => { let node: any = screen.getByText(label); while (node && node.props.accessibilityRole !== 'button') node = node.parent; return node; };

// Spec: MUS-SPEC-23-14B (docs/spec/clauses/23-mobile.md#mus-spec-23-14b)
test('the pair screen text and the camera prompt meet WCAG AA contrast', async () => {
  await render(<PairScreen pairWith={jest.fn()} store={createPairingStore(memorySecureStore())} scanner={onScan => <QrScanner onScan={onScan} />} />);
  for (const text of [/On your computer, open Muster/, /Muster needs the camera/, /A new phone can read your chats/, 'Allow camera', 'Pair']) {
    const node = screen.getByText(text);
    const fg = style(node).color!, bg = backdrop(node, colors.background);
    expect([String(text), fg, bg, contrast(fg, bg) >= 4.5]).toEqual([String(text), fg, bg, true]);
  }
  for (const label of ['Allow camera', 'Pair']) {
    const node = button(label);
    const own = style(node), around = backdrop(node, colors.background);
    const edge = Math.max(own.backgroundColor ? contrast(own.backgroundColor, around) : 1, own.borderColor ? contrast(own.borderColor, around) : 1);
    expect([label, edge >= 3]).toEqual([label, true]);
  }
});
