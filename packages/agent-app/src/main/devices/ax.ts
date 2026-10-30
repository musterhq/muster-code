/**
 * The device screen as elements (#809): the helper's accessibility tree, flattened into a short list an agent can act on
 * by ref ("e5 button \"Sign in\"") instead of guessing pixels from a screenshot.
 *
 * Sources (both served by the pinned helper, read by main with its bearer token):
 * - iOS: GET /vendor/serve-sim/helper/<udid>/ax, the simulator's tree as nested nodes
 *   {AXUniqueId, AXLabel, AXValue, type, role_description, enabled, frame{x,y,width,height}, children[]} in points.
 * - Android: GET /vendor/serve-emu/api/accessibility?device=<serial>, a uiautomator dump as
 *   {screen{width,height}, nodes[{id, text, contentDescription, resourceId, className, clickable, enabled, bounds}]} in pixels.
 *
 * The flattening follows T3 Code's device overlay parser (MIT, Copyright (c) 2026 T3 Tools Inc.,
 * apps/web/src/components/device/deviceHubApi.ts at fa4e4677c0ecc437aece2dcea39f76ef31414152): skip nodes that cover the
 * whole screen, cap the list at 500. Muster adds values, enabled state, one set of role names for both platforms, refs,
 * and drops unlabelled layout containers so a snapshot stays small.
 */
import type {DevicePlatform} from '../../shared/device-protocol.ts';

export interface AxFrame {x: number; y: number; w: number; h: number}
export interface AxElement {
  /** e1, e2, … in screen order, valid for the snapshot that produced it. */
  ref: string;
  /** What identifies the same element in a later snapshot: its accessibility id, else role and label. */
  key: string;
  role: string;
  label: string;
  value?: string;
  enabled: boolean;
  /** A text field: tapping it focuses it for typing. */
  editable: boolean;
  /** Something a tap does something to (a button, a field, a switch, a clickable row). */
  interactive: boolean;
  /** In screen units: points on iOS, pixels on Android. */
  frame: AxFrame;
}
export interface AxSnapshot {
  platform: DevicePlatform;
  screen: {width: number; height: number};
  unit: 'pt' | 'px';
  elements: AxElement[];
  /** More elements than the cap: the rest were left out. */
  truncated: boolean;
}
export const AX_ELEMENT_LIMIT = 500;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const str = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const IOS_ROLES: Record<string, string> = {Button: 'button', TextField: 'textfield', SecureTextField: 'securefield', SearchField: 'searchfield', TextView: 'textview', StaticText: 'text', Heading: 'heading', Image: 'image',
  Switch: 'switch', Toggle: 'switch', Slider: 'slider', Link: 'link', Cell: 'cell', Tab: 'tab', TabBar: 'tabbar', NavigationBar: 'navbar', SegmentedControl: 'segmented', Picker: 'picker', PickerWheel: 'picker',
  CheckBox: 'checkbox', MenuItem: 'menuitem', Stepper: 'stepper', ProgressIndicator: 'progress', ActivityIndicator: 'progress', Alert: 'alert', Keyboard: 'keyboard', Key: 'key', ScrollView: 'scroll', Table: 'list', CollectionView: 'list'};
const EDITABLE = new Set(['textfield', 'securefield', 'searchfield', 'textview']);
const INTERACTIVE = new Set([...EDITABLE, 'button', 'link', 'switch', 'slider', 'cell', 'tab', 'segmented', 'picker', 'checkbox', 'radio', 'menuitem', 'stepper', 'key']);

/** The iOS tree (an array of roots) as elements. Throws on anything that is not a tree. */
export function parseIosAx(payload: unknown): AxSnapshot {
  if (!Array.isArray(payload)) throw new Error(record(payload) && typeof payload.message === 'string' ? payload.message : 'The accessibility tree was not readable.');
  const rootFrame = record(payload[0]) && record(payload[0].frame) ? payload[0].frame : {};
  const screen = {width: Math.max(1, num(rootFrame.width, 1)), height: Math.max(1, num(rootFrame.height, 1))};
  const elements: AxElement[] = [];
  let truncated = false;
  const visit = (node: unknown, depth: number) => {
    if (!record(node) || depth > 64) return;
    const frame = record(node.frame) ? node.frame : {};
    const w = num(frame.width), h = num(frame.height);
    const covers = Math.abs(w - screen.width) < 0.5 && Math.abs(h - screen.height) < 0.5;
    const type = str(node.type), role = IOS_ROLES[type] ?? (type ? type.toLowerCase() : str(node.role_description).toLowerCase() || 'element');
    const label = str(node.AXLabel), value = str(node.AXValue);
    const interactive = INTERACTIVE.has(role);
    // Unlabelled groups and windows only lay things out; leaving them out keeps a snapshot small.
    if (!covers && w > 0 && h > 0 && (label || value || interactive)) {
      if (elements.length >= AX_ELEMENT_LIMIT) { truncated = true; return; }
      const id = str(node.AXUniqueId);
      elements.push({ref: '', key: id ? `id:${id}` : `${role}|${label}`, role, label, ...(value ? {value} : {}), enabled: node.enabled !== false, editable: EDITABLE.has(role), interactive,
        frame: {x: num(frame.x), y: num(frame.y), w, h}});
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of payload) visit(root, 0);
  return numbered({platform: 'ios', screen, unit: 'pt', elements, truncated});
}

const ANDROID_ROLES: Record<string, string> = {EditText: 'textfield', AutoCompleteTextView: 'textfield', TextInputEditText: 'textfield', Button: 'button', MaterialButton: 'button', ImageButton: 'button',
  TextView: 'text', ImageView: 'image', CheckBox: 'checkbox', Switch: 'switch', SwitchCompat: 'switch', SwitchMaterial: 'switch', ToggleButton: 'switch', RadioButton: 'radio', SeekBar: 'slider',
  Spinner: 'picker', ProgressBar: 'progress', WebView: 'web', RecyclerView: 'list', ListView: 'list', ScrollView: 'scroll', TabWidget: 'tabbar'};

/** The Android dump as elements. A text field's text is its value; its label is the content description or its view id. */
export function parseAndroidAx(payload: unknown): AxSnapshot {
  if (!record(payload) || !Array.isArray(payload.nodes)) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : 'The accessibility tree was not readable.');
  const nodes = payload.nodes.filter((node): node is Record<string, unknown> => record(node) && record(node.bounds));
  let width = record(payload.screen) ? num(payload.screen.width) : 0, height = record(payload.screen) ? num(payload.screen.height) : 0;
  if (!width || !height) for (const node of nodes) { const b = node.bounds as Record<string, unknown>; width = Math.max(width, num(b.right)); height = Math.max(height, num(b.bottom)); }
  const screen = {width: Math.max(1, width), height: Math.max(1, height)};
  const elements: AxElement[] = [];
  let truncated = false;
  for (const node of nodes) {
    const b = node.bounds as Record<string, unknown>;
    const x = num(b.left), y = num(b.top), w = num(b.right, x) - x, h = num(b.bottom, y) - y;
    if (w <= 0 || h <= 0 || (w / screen.width >= 0.95 && h / screen.height >= 0.9)) continue;
    const className = str(node.className), short = className.split('.').at(-1) ?? '';
    const role = ANDROID_ROLES[short] ?? (/EditText$/.test(short) ? 'textfield' : /Button$/.test(short) ? 'button' : short ? short.toLowerCase() : 'view');
    const editable = EDITABLE.has(role), clickable = node.clickable === true;
    const text = str(node.text), description = str(node.contentDescription), viewId = str(node.resourceId).split(':id/').at(-1)?.replace(/_/g, ' ') ?? '';
    const label = editable ? description || viewId : text || description;
    const value = editable ? text : '';
    if (!label && !value && !clickable && !editable) continue;
    if (elements.length >= AX_ELEMENT_LIMIT) { truncated = true; break; }
    const resource = str(node.resourceId);
    elements.push({ref: '', key: resource ? `id:${resource}` : `${role}|${label}`, role, label, ...(value ? {value} : {}), enabled: node.enabled !== false, editable, interactive: clickable || editable || INTERACTIVE.has(role), frame: {x, y, w, h}});
  }
  return numbered({platform: 'android', screen, unit: 'px', elements, truncated});
}

function numbered(snapshot: AxSnapshot): AxSnapshot {
  // Same id twice (a list of identical rows): the later ones are told apart by position.
  const seen = new Map<string, number>();
  snapshot.elements.forEach((element, index) => {
    element.ref = `e${index + 1}`;
    const count = seen.get(element.key) ?? 0;
    seen.set(element.key, count + 1);
    if (count) element.key = `${element.key}#${count}`;
  });
  return snapshot;
}

/** The point to tap, 0..1 across the screen as shown. */
export const centreOf = (snapshot: AxSnapshot, element: AxElement) => ({x: Math.min(1, Math.max(0, (element.frame.x + element.frame.w / 2) / snapshot.screen.width)), y: Math.min(1, Math.max(0, (element.frame.y + element.frame.h / 2) / snapshot.screen.height))});

const quote = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}…` : text);
export const describeElement = (element: AxElement) => `${element.ref} ${element.role} ${quote(element.label)}${element.value !== undefined ? ` value=${quote(element.value)}` : ''}`;
/** One line per element: `e5 button "Sign in" [32,437 338×57]`, bounded so a busy screen cannot flood the transcript. */
export function formatAx(snapshot: AxSnapshot, title: string, maxBytes = 30_000): string {
  const head = `${title} · ${Math.round(snapshot.screen.width)}×${Math.round(snapshot.screen.height)} ${snapshot.unit} · ${snapshot.elements.length} elements`;
  const lines: string[] = [];
  let size = head.length, cut = snapshot.truncated;
  for (const element of snapshot.elements) {
    const f = element.frame;
    const line = `${describeElement(element)} [${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}×${Math.round(f.h)}]${element.enabled ? '' : ' disabled'}`;
    if (size + line.length + 1 > maxBytes) { cut = true; break; }
    lines.push(line); size += line.length + 1;
  }
  if (!snapshot.elements.length) lines.push('(no labelled elements: the screen may be a game, a web view or a canvas; use device_screenshot and device_tap)');
  if (cut) lines.push(`… more elements were left out (${snapshot.elements.length - lines.length} not shown). Scroll, or use device_screenshot.`);
  return [head, ...lines].join('\n');
}

const norm = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export type AxMatch = {element: AxElement} | {error: string};
/**
 * The element a label names. Exact label (or value) first, then a label that contains it. For typing, a field wins over
 * its caption; when the label belongs to a caption with no field of that name, the field just below or beside it is used.
 * Several different matches are an error listing their refs, never a guess.
 */
export function findByLabel(snapshot: AxSnapshot, query: string, want: 'tap' | 'type'): AxMatch {
  const q = norm(query);
  if (!q) return {error: 'Pass the label to look for.'};
  const exact = snapshot.elements.filter(element => norm(element.label) === q || (!element.editable && norm(element.value) === q));
  let found = exact.length ? exact : snapshot.elements.filter(element => norm(element.label).includes(q));
  if (!found.length) return {error: `No element labelled ${quote(query)} is on screen. Call device_snapshot to see what is.`};
  if (want === 'type') {
    const fields = found.filter(element => element.editable);
    if (fields.length) found = fields;
    else {
      const field = fieldNear(snapshot, found[0]!);
      if (!field) return {error: `${describeElement(found[0]!)} is not a text field, and no field is next to it. Call device_snapshot and pass the field's ref.`};
      return {element: field};
    }
  } else {
    const active = found.filter(element => element.interactive);
    if (active.length) found = active;
  }
  // The same control reported twice (a button and its own text, same frame) is one target.
  const distinct = found.filter((element, index) => found.findIndex(other => sameFrame(other.frame, element.frame)) === index);
  if (distinct.length === 1) return {element: distinct[0]!};
  return {error: `${distinct.length} elements match ${quote(query)}: ${distinct.slice(0, 8).map(describeElement).join('; ')}. Pass the ref of the one you mean.`};
}
const sameFrame = (a: AxFrame, b: AxFrame) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
/** The text field a caption labels: the nearest one starting just below it, or on its row to the right. */
function fieldNear(snapshot: AxSnapshot, caption: AxElement): AxElement | undefined {
  const c = caption.frame, reach = Math.max(c.h * 4, snapshot.screen.height * 0.08);
  let best: {element: AxElement; distance: number} | undefined;
  for (const element of snapshot.elements) {
    if (!element.editable) continue;
    const f = element.frame;
    const below = f.y >= c.y + c.h * 0.5 && f.y - (c.y + c.h) <= reach && f.x < c.x + c.w && f.x + f.w > c.x;
    const beside = f.x >= c.x + c.w * 0.5 && Math.abs((f.y + f.h / 2) - (c.y + c.h / 2)) <= Math.max(c.h, f.h) / 2;
    if (!below && !beside) continue;
    const distance = Math.hypot(f.x - c.x, f.y - c.y);
    if (!best || distance < best.distance) best = {element, distance};
  }
  return best?.element;
}
/** The element with this ref in the snapshot it came from. */
export const byRef = (snapshot: AxSnapshot, ref: string) => snapshot.elements.find(element => element.ref === ref);
/** The same element in a newer snapshot, if it is there exactly once. */
export const sameElementIn = (snapshot: AxSnapshot, element: AxElement) => {
  const matches = snapshot.elements.filter(other => other.key === element.key && other.role === element.role);
  return matches.length === 1 ? matches[0] : undefined;
};
