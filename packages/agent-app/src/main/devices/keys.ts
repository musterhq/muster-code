/** Keyboard mapping for device input (#363): browser KeyboardEvent.code → USB HID usage (iOS), key → Android keycode,
 *  and US-layout characters → HID usage + Shift for typing text into a simulator. Pure tables. */
const HID_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, Delete: 0x4c,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, Home: 0x4a, End: 0x4d, PageUp: 0x4b, PageDown: 0x4e,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3, ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
};
export function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === 'Digit0') return 0x27;
  return HID_BY_CODE[code] ?? null;
}
const ANDROID_KEYCODES: Readonly<Record<string, number>> = {ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Tab: 61, Enter: 66, Backspace: 67, Delete: 112, Home: 122, End: 123, PageUp: 92, PageDown: 93};
export const androidKeycode = (key: string): number | null => ANDROID_KEYCODES[key] ?? null;

const SHIFTED: Readonly<Record<string, string>> = {'!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': '\'', '~': '`', '<': ',', '>': '.', '?': '/'};
const PLAIN: Readonly<Record<string, number>> = {' ': 0x2c, '\n': 0x28, '\t': 0x2b, '-': 0x2d, '=': 0x2e, '[': 0x2f, ']': 0x30, '\\': 0x31, ';': 0x33, '\'': 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38};
/** The HID key (and whether Shift is held) that types `char` on a US keyboard; null for anything else. */
export function hidForChar(char: string): {usage: number; shift: boolean} | null {
  if (/^[a-z]$/.test(char)) return {usage: 0x04 + char.charCodeAt(0) - 97, shift: false};
  if (/^[A-Z]$/.test(char)) return {usage: 0x04 + char.charCodeAt(0) - 65, shift: true};
  if (/^[1-9]$/.test(char)) return {usage: 0x1e + char.charCodeAt(0) - 49, shift: false};
  if (char === '0') return {usage: 0x27, shift: false};
  if (char in PLAIN) return {usage: PLAIN[char]!, shift: false};
  const base = SHIFTED[char];
  if (base) { const plain = hidForChar(base); return plain ? {usage: plain.usage, shift: true} : null; }
  return null;
}
