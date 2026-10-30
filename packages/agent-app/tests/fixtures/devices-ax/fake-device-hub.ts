/**
 * A fake device helper for #809 workflow tests: a real loopback HTTP server that answers the routes Muster uses with the
 * shapes expo-device-hub 0.15.3 serves, plus fake input sockets, all driving one small "Taskboard" sign-in app.
 *
 * - iOS /vendor/serve-sim/helper/<udid>/ax: the nested tree serve-sim's native axDescribe returns (idb describe-all
 *   style nodes: AXFrame, AXUniqueId, frame, role_description, AXLabel, AXValue, type, enabled, role, children).
 * - Android /vendor/serve-emu/api/accessibility: a real uiautomator XML dump of the same screen, turned into the hub's
 *   JSON by the same steps serve-emu takes (snapshotFromDump / parseAccessibilityXml).
 * - Input sockets: iOS HID packets (tag byte + JSON; text as HID key presses) and serve-emu's JSON messages.
 *
 * The app reacts like a real one: a tap on a field focuses it, typing fills the focused field, "Sign in" with both
 * fields filled moves to a welcome screen, without them shows an error. Nothing else is simulated.
 */
import http from 'node:http';
import {hidForChar} from '../../../src/main/devices/keys.ts';

type Box = [number, number, number, number];
interface Item {id: string; kind: 'heading' | 'text' | 'field' | 'secure' | 'button'; label: string; value?: string; box: Box}
export class TaskboardApp {
  screen: 'signin' | 'home' = 'signin';
  email = ''; password = ''; focused?: 'email' | 'password'; error = '';
  taps: {x: number; y: number}[] = [];
  items(): Item[] {
    if (this.screen === 'home') return [
      {id: 'welcome', kind: 'heading', label: `Welcome, ${this.email}`, box: [0.08, 0.14, 0.84, 0.05]},
      {id: 'tasks', kind: 'text', label: '3 tasks due today', box: [0.08, 0.21, 0.84, 0.03]},
      {id: 'sign-out', kind: 'button', label: 'Sign out', box: [0.08, 0.86, 0.84, 0.06]},
    ];
    return [
      {id: 'title', kind: 'heading', label: 'Sign in to Taskboard', box: [0.08, 0.14, 0.84, 0.05]},
      {id: 'email-caption', kind: 'text', label: 'Email', box: [0.08, 0.24, 0.3, 0.025]},
      {id: 'email', kind: 'field', label: 'Email', value: this.email, box: [0.08, 0.27, 0.84, 0.06]},
      {id: 'password-caption', kind: 'text', label: 'Password', box: [0.08, 0.36, 0.3, 0.025]},
      {id: 'password', kind: 'secure', label: 'Password', value: '•'.repeat(this.password.length), box: [0.08, 0.39, 0.84, 0.06]},
      ...(this.error ? [{id: 'error', kind: 'text' as const, label: this.error, box: [0.08, 0.46, 0.84, 0.03] as Box}] : []),
      {id: 'sign-in', kind: 'button', label: 'Sign in', box: [0.08, 0.50, 0.84, 0.065]},
      {id: 'forgot', kind: 'button', label: 'Forgot password?', box: [0.25, 0.59, 0.5, 0.04]},
    ];
  }
  tap(x: number, y: number): void {
    this.taps.push({x, y});
    const hit = this.items().find(item => x >= item.box[0] && x <= item.box[0] + item.box[2] && y >= item.box[1] && y <= item.box[1] + item.box[3]);
    if (hit?.id === 'email' || hit?.id === 'password') { this.focused = hit.id; return; }
    this.focused = undefined;
    if (hit?.id === 'sign-in') this.submit();
    if (hit?.id === 'sign-out') { this.screen = 'signin'; this.email = ''; this.password = ''; }
  }
  type(text: string): void {
    for (const char of text) {
      if (char === '\n') { this.submit(); continue; }
      if (this.focused === 'email') this.email += char; else if (this.focused === 'password') this.password += char;
    }
  }
  submit(): void {
    if (this.screen !== 'signin') return;
    if (this.email.includes('@') && this.password) { this.screen = 'home'; this.error = ''; this.focused = undefined; }
    else this.error = 'Enter your email and password.';
  }
}

// --- iOS: the tree serve-sim's axDescribe returns (points, iPhone 17 Pro) ----------------------------------------
export const IOS_SCREEN = {width: 402, height: 874};
const IOS_TYPES = {heading: 'Heading', text: 'StaticText', field: 'TextField', secure: 'SecureTextField', button: 'Button'} as const;
function iosNode(fields: {type: string; label?: string | null; value?: string | null; id?: string | null; frame: {x: number; y: number; width: number; height: number}; children?: unknown[]; role?: string; roleDescription?: string}) {
  const f = fields.frame;
  return {AXFrame: `{{${f.x}, ${f.y}}, {${f.width}, ${f.height}}}`, AXUniqueId: fields.id ?? null, frame: f, role_description: fields.roleDescription ?? fields.type.toLowerCase(), AXLabel: fields.label ?? null, content_required: false,
    type: fields.type, title: null, help: null, custom_actions: [], AXValue: fields.value ?? null, enabled: true, role: fields.role ?? `AX${fields.type}`, subrole: null, pid: 48213, children: fields.children ?? []};
}
export function iosTree(app: TaskboardApp): unknown[] {
  const {width, height} = IOS_SCREEN;
  const px = (box: Box) => ({x: Math.round(box[0] * width * 100) / 100, y: Math.round(box[1] * height * 100) / 100, width: Math.round(box[2] * width * 100) / 100, height: Math.round(box[3] * height * 100) / 100});
  const leaves = app.items().map(item => iosNode({type: IOS_TYPES[item.kind], label: item.label, value: item.kind === 'field' || item.kind === 'secure' ? item.value ?? '' : null,
    id: item.kind === 'field' || item.kind === 'secure' || item.kind === 'button' ? `${item.id}-${item.kind === 'button' ? 'button' : 'field'}` : null, frame: px(item.box),
    roleDescription: item.kind === 'field' ? 'text field' : item.kind === 'secure' ? 'secure text field' : item.kind === 'heading' ? 'heading' : item.kind === 'button' ? 'button' : 'text',
    // A SwiftUI button exposes its own title as a child with the same frame.
    children: item.kind === 'button' ? [iosNode({type: 'StaticText', label: item.label, frame: px(item.box)})] : []}));
  const form = iosNode({type: 'Other', frame: {x: 0, y: 59, width, height: height - 59 - 34}, roleDescription: 'group', role: 'AXGroup', children: leaves});
  const window = iosNode({type: 'Window', frame: {x: 0, y: 0, width, height}, roleDescription: 'window', children: [form]});
  return [iosNode({type: 'Application', label: 'Taskboard', frame: {x: 0, y: 0, width, height}, roleDescription: 'application', children: [window]})];
}

// --- Android: a uiautomator dump (pixels, Pixel 9) and the hub's JSON for it ---------------------------------------
export const ANDROID_SCREEN = {width: 1080, height: 2424};
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function androidDump(app: TaskboardApp): string {
  const {width, height} = ANDROID_SCREEN;
  const bounds = (box: Box) => `[${Math.round(box[0] * width)},${Math.round(box[1] * height)}][${Math.round((box[0] + box[2]) * width)},${Math.round((box[1] + box[3]) * height)}]`;
  const node = (attrs: Record<string, string>, inner = '') => `<node index="0" ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}${inner ? `>${inner}</node>` : ' />'}`;
  const base = {checkable: 'false', checked: 'false', focusable: 'false', focused: 'false', scrollable: 'false', 'long-clickable': 'false', password: 'false', selected: 'false', enabled: 'true', package: 'com.example.taskboard'};
  const leaves = app.items().map(item => {
    const field = item.kind === 'field' || item.kind === 'secure';
    return node({...base, text: field ? (item.kind === 'secure' ? '•'.repeat(app.password.length) : app.email) : item.label, 'resource-id': `com.example.taskboard:id/${item.id.replace(/-/g, '_')}`,
      class: field ? 'android.widget.EditText' : item.kind === 'button' ? 'android.widget.Button' : 'android.widget.TextView', 'content-desc': '',
      clickable: String(field || item.kind === 'button'), focusable: String(field || item.kind === 'button'), focused: String(app.focused === item.id), password: String(item.kind === 'secure'), bounds: bounds(item.box)});
  }).join('');
  const content = node({...base, text: '', 'resource-id': 'android:id/content', class: 'android.widget.FrameLayout', 'content-desc': '', clickable: 'false', bounds: `[0,0][${width},${height}]`},
    node({...base, text: '', 'resource-id': 'com.example.taskboard:id/form', class: 'android.widget.LinearLayout', 'content-desc': '', clickable: 'false', bounds: `[0,136][${width},${height - 63}]`}, leaves));
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${content}</hierarchy>`;
}
/** What serve-emu's /api/accessibility answers for a dump: the same parse its accessibility.js does. */
export function androidSnapshot(xml: string, capturedAt = '2026-10-30T10:00:00.000Z') {
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const nodes: unknown[] = [];
  let index = 0;
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[0].matchAll(/\s([a-zA-Z0-9_-]+)="([^"]*)"/g)) attrs[attr[1]!] = decode(attr[2] ?? '');
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    if (!b) continue;
    const bounds = {left: Number(b[1]), top: Number(b[2]), right: Number(b[3]), bottom: Number(b[4])};
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) continue;
    nodes.push({id: `${index++}`, text: attrs.text ?? '', contentDescription: attrs['content-desc'] ?? '', resourceId: attrs['resource-id'] ?? '', className: attrs.class ?? '', packageName: attrs.package ?? '',
      clickable: attrs.clickable === 'true', enabled: attrs.enabled === 'true', bounds});
  }
  return {ok: true, capturedAt, screen: ANDROID_SCREEN, nodes};
}

// --- The hub -------------------------------------------------------------------------------------------------------
const HID_TO_CHAR = new Map<string, string>();
for (let code = 32; code < 127; code++) { const char = String.fromCharCode(code), key = hidForChar(char); if (key) HID_TO_CHAR.set(`${key.usage}:${key.shift}`, char); }
HID_TO_CHAR.set('40:false', '\n');

export class FakeDeviceHub {
  readonly token = 'fake-hub-token-0123456789abcdef';
  readonly requests: {method: string; path: string; auth: string | null}[] = [];
  readonly apps = new Map<string, TaskboardApp>();
  /** Every input message a device received, decoded. */
  readonly inputs: {device: string; message: unknown}[] = [];
  private server?: http.Server;
  origin = '';
  app(device: string): TaskboardApp { let app = this.apps.get(device); if (!app) { app = new TaskboardApp(); this.apps.set(device, app); } return app; }
  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      this.requests.push({method: request.method ?? 'GET', path: `${url.pathname}${url.search}`, auth: request.headers.authorization ?? null});
      const json = (status: number, body: unknown) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
      if (url.pathname === '/readyz') return json(200, {ok: true});
      if (request.headers.authorization !== `Bearer ${this.token}`) return json(401, {error: 'unauthorized'});
      if (url.pathname === '/vendor/serve-sim/grid/api/start') return json(200, {ok: true});
      const sim = /^\/vendor\/serve-sim\/helper\/([^/]+)\/(ax|stream\.mjpeg)$/.exec(url.pathname);
      if (sim?.[2] === 'stream.mjpeg') { response.writeHead(200, {'content-type': 'multipart/x-mixed-replace; boundary=frame'}); response.end(); return; }
      // serve-sim answers with the native helper's JSON string as is.
      if (sim?.[2] === 'ax') return json(200, JSON.stringify(iosTree(this.app(decodeURIComponent(sim[1]!)))));
      if (url.pathname === '/vendor/serve-emu/api/accessibility') return json(200, androidSnapshot(androidDump(this.app(url.searchParams.get('device') ?? ''))));
      json(404, {error: 'not found'});
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server!.address() as {port: number}).port}`;
  }
  stop(): void { this.server?.close(); }
  /** The banner the real helper prints; the manager reads its port and token. */
  get banner(): string { return `\n  Local:   http://localhost:${new URL(this.origin).port}/?token=${this.token}\n`; }
  /** The manager's socket factory: an input socket for a device that feeds its app. */
  socket = (url: string, headers: Record<string, string>) => {
    const parsed = new URL(url), device = parsed.searchParams.get('device') ?? '', ios = parsed.pathname.includes('serve-sim');
    const hub = this, app = this.app(device);
    let shift = false;
    const socket = {
      binaryType: '', readyState: 0, url,
      onopen: null as ((event: unknown) => void) | null, onmessage: null as ((event: {data: unknown}) => void) | null, onclose: null as ((event: {code: number; reason: string}) => void) | null, onerror: null as ((event: unknown) => void) | null,
      send(data: unknown) {
        if (ios) {
          const bytes = Buffer.from(data as Uint8Array), tag = bytes[0], body = JSON.parse(bytes.subarray(1).toString('utf8')) as {type?: string; x?: number; y?: number; usage?: number};
          hub.inputs.push({device, message: {tag, ...body}});
          if (tag === 0x03 && body.type === 'end') app.tap(body.x!, body.y!);
          if (tag === 0x06 && body.usage === 0xe1) shift = body.type === 'down';
          else if (tag === 0x06 && body.type === 'down') { const char = HID_TO_CHAR.get(`${body.usage}:${shift}`); if (char) app.type(char); }
          return;
        }
        const message = JSON.parse(String(data)) as {type?: string; action?: string; x?: number; y?: number; text?: string; keycode?: number};
        hub.inputs.push({device, message});
        if (message.type === 'touch' && message.action === 'up') app.tap(message.x!, message.y!);
        if (message.type === 'text') app.type(message.text!);
        if (message.type === 'key' && message.keycode === 66) app.submit();
      },
      close() { this.readyState = 3; this.onclose?.({code: 1000, reason: ''}); },
    };
    if (headers.authorization !== `Bearer ${this.token}`) throw new Error('unauthorized socket');
    setTimeout(() => {
      socket.readyState = 1;
      socket.onopen?.({});
      if (ios) {
        const packet = (tag: number, body?: unknown) => { const json = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); const out = new Uint8Array(1 + json.length); out[0] = tag; out.set(json, 1); return out.buffer; };
        socket.onmessage?.({data: packet(0x82, {width: 1206, height: 2622, orientation: 'portrait'})});
        socket.onmessage?.({data: packet(0x83)});
      }
    }, 5);
    return socket as never;
  };
}
