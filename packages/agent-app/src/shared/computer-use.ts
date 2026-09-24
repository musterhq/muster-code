/** Computer use: detection, action trace wording, elicitation policy and the input lease.
 * Ported from the Muster Code IDE (builtin/src/codex.ts HOST_COMPUTER_USE_MCP, agent-pane.ts
 * computerUseToolFromItem / elicitationText). Pure: shared by the runtime, main and renderer. */
import type {ChatPermissionMode} from './protocol.ts';

/** Bundled Codex computer-use MCP names. Muster never disables these on a turn. */
export const HOST_COMPUTER_USE_MCP = ['computer-use', 'unified-computer-use', 'visualize', 'cua_repl', 'node_repl'] as const;
export const BROWSER_MCP = 'muster_browser';
const COMPUTER_USE_SERVER = /computer-use|unified-computer-use|cua_repl|node_repl|^visualize$/i;
const COMPUTER_USE_TOOL = /^(listApps|list_apps|snapshot|getAppState|get_app_state|click|double_click|doubleClick|right_click|type|typeText|type_text|key|press_key|pressKey|scroll|drag|move|screenshot|open_app|openApp)$/i;
const BROWSER_SERVER = /^muster[_-]browser$/i;

export const BROWSER_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_hover', 'browser_select_option', 'browser_scroll', 'browser_screenshot', 'browser_go_back', 'browser_reload', 'browser_wait_for', 'browser_console_messages'] as const;
export const BROWSER_NOTE = `Muster has an in-app browser shown to the user in the right pane. For web pages prefer the ${BROWSER_MCP} MCP tools (${BROWSER_TOOLS.join(', ')}). When the user says "in-app browser", "the browser", "Muster's browser", "here" or "in the side pane", or asks to open, check or test a page or local app URL without naming another browser, use ${BROWSER_MCP}: not Safari or Chrome, not the computer-use plugin, and not curl. Flow: browser_navigate, browser_snapshot, act on [ref=eN], re-snapshot. The user watches this browser live and may take control; if a tool says the user has control, stop and wait for them.`;
export const COMPUTER_USE_NOTE = 'For macOS desktop apps (outside the in-app browser) use the signed-in Codex computer-use plugin (computer-use / unified-computer-use): listApps, snapshot, click, type, scroll, then confirm consequential actions. Use the visualize plugin to save screenshots and embed them as ![alt](path) in the reply. Do not invent a second computer-use path.';
export const READ_ONLY_NOTE = 'This chat is read-only: do not drive the computer or the browser beyond reading pages and taking screenshots.';

export type ComputerTarget = 'computer' | 'browser';
const str = (value: unknown) => typeof value === 'string' ? value : '';

/** 'browser' for the in-app browser bridge, 'computer' for Codex computer-use, else undefined. */
export function computerUseTarget(data: Record<string, unknown> | undefined): ComputerTarget | undefined {
  if (!data) return undefined;
  const type = str(data.type);
  if (type && type !== 'mcpToolCall' && type !== 'dynamicToolCall') return undefined;
  const server = str(data.server) || str(data.namespace) || str(data.mcpServer) || str(data.serverName) || str(data.plugin);
  const tool = str(data.tool) || str(data.toolName);
  if (BROWSER_SERVER.test(server) || (!server && /^browser_/.test(tool) && (BROWSER_TOOLS as readonly string[]).includes(tool))) return 'browser';
  if (COMPUTER_USE_SERVER.test(server) || COMPUTER_USE_SERVER.test(tool)) return 'computer';
  if (!server && COMPUTER_USE_TOOL.test(tool)) return 'computer';
  return undefined;
}

export function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

const SECRET_HINT = /pass(word|code|phrase)?|\bpin\b|otp|one[- ]time|2fa|mfa|token|secret|api[ _-]?key|credential|cvv|cvc|security code|card number|ssn/i;
/** True when typed text should never be echoed: an explicit flag or a secret-looking target. */
export function isSensitiveTyping(args: Record<string, unknown>): boolean {
  if (args.secret === true || args.sensitive === true || args.isSecret === true || args.mask === true) return true;
  const target = [args.element, args.label, args.field, args.name, args.description, args.target, args.selector, args.ref_label, args.inputType, args.type_hint].map(str).join(' ');
  return SECRET_HINT.test(target);
}
const MASK = '••••••';
const TEXT_KEYS = ['text', 'value', 'input', 'string', 'keys_text'];
/** Arguments with typed secrets replaced; everything else untouched. */
export function maskComputerArguments(args: Record<string, unknown>): Record<string, unknown> {
  if (!isSensitiveTyping(args)) return args;
  const masked = {...args};
  for (const key of TEXT_KEYS) if (typeof masked[key] === 'string') masked[key] = MASK;
  return masked;
}

export interface ComputerAction { target: ComputerTarget; verb: string; runningVerb: string; object: string; app: string; url: string; label: string }
const clip = (text: string, max = 48) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max - 1) + '…' : flat; };
const quote = (text: string) => text ? `“${clip(text)}”` : '';
const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };
function elementName(args: Record<string, unknown>): string {
  for (const key of ['element', 'label', 'name', 'title', 'description', 'target', 'text_label', 'accessibility_label']) { const value = str(args[key]); if (value) return value; }
  const ref = str(args.ref); if (ref) return ref;
  const selector = str(args.selector); if (selector) return selector;
  if (typeof args.x === 'number' && typeof args.y === 'number') return `${Math.round(args.x)}, ${Math.round(args.y)}`;
  return '';
}

/** "Clicked “Send” in Mail", "Typed •••••• in Safari", "Opened example.com": never raw JSON. */
export function computerAction(data: Record<string, unknown> | undefined): ComputerAction | undefined {
  const target = computerUseTarget(data);
  if (!target || !data) return undefined;
  const tool = (str(data.tool) || str(data.toolName) || str(data.name)).replace(/^browser_/, '');
  const args = parseArguments(data.arguments);
  const app = str(args.app) || str(args.app_name) || str(args.appName) || str(args.application) || str(args.bundle_id) || str(args.bundleId) || (target === 'browser' ? 'Browser' : '');
  const url = str(args.url);
  const where = target === 'browser' ? '' : app ? ` in ${app}` : '';
  const element = elementName(args);
  const typed = TEXT_KEYS.map(key => str(args[key])).find(Boolean) ?? '';
  const sensitive = isSensitiveTyping(args);
  const t = tool.toLowerCase().replace(/[-\s]/g, '_');
  const make = (verb: string, runningVerb: string, object: string): ComputerAction => ({target, verb, runningVerb, object, app, url, label: `${verb}${object ? ' ' + object : ''}${where}`.trim()});
  if (/^(click|left_click|tap)$/.test(t)) return make('Clicked', 'Clicking', quote(element));
  if (/^(double_click|doubleclick)$/.test(t)) return make('Double-clicked', 'Double-clicking', quote(element));
  if (/^(right_click|context_click)$/.test(t)) return make('Right-clicked', 'Right-clicking', quote(element));
  if (/^(type|typetext|type_text|fill|set_value|input_text)$/.test(t)) return make('Typed', 'Typing', `${sensitive ? MASK : quote(typed)}${element && !sensitive ? ` into ${quote(element)}` : ''}`.trim());
  if (/^(key|press_key|presskey|hotkey|keypress)$/.test(t)) return make('Pressed', 'Pressing', str(args.key) || str(args.keys) || (Array.isArray(args.keys) ? args.keys.map(String).join('+') : '') || 'a key');
  if (/^scroll/.test(t)) return make('Scrolled', 'Scrolling', [str(args.direction) || 'down', element ? `in ${quote(element)}` : ''].filter(Boolean).join(' '));
  if (/^(drag|drag_and_drop)$/.test(t)) return make('Dragged', 'Dragging', quote(element));
  if (/^(hover|move|mouse_move)$/.test(t)) return make('Hovered', 'Hovering over', quote(element));
  if (/^(select_option|select)$/.test(t)) return make('Selected', 'Selecting', quote(Array.isArray(args.values) ? args.values.map(String).join(', ') : str(args.value) || element));
  if (/^(navigate|open_url|goto)$/.test(t)) return make('Opened', 'Opening', hostOf(url) || 'a page');
  if (/^(go_back|back)$/.test(t)) return make('Went back', 'Going back', '');
  if (/^(reload|refresh)$/.test(t)) return make('Reloaded', 'Reloading', 'the page');
  if (/^(wait_for|wait)$/.test(t)) return make('Waited', 'Waiting', str(args.text) ? `for ${quote(str(args.text))}` : '');
  if (/^(console_messages)$/.test(t)) return make('Read', 'Reading', 'the console');
  if (/^(list_apps|listapps)$/.test(t)) return {target, verb: 'Listed apps', runningVerb: 'Listing apps', object: '', app, url, label: 'Listed apps'};
  if (/^(open_app|openapp|launch_app)$/.test(t)) return {target, verb: 'Opened', runningVerb: 'Opening', object: app, app, url, label: `Opened ${app || 'an app'}`};
  if (/^(snapshot|screenshot|get_app_state|getappstate|take_screenshot)$/.test(t)) return make(target === 'browser' && t === 'snapshot' ? 'Read' : 'Looked at', target === 'browser' && t === 'snapshot' ? 'Reading' : 'Looking at', target === 'browser' ? 'the page' : app ? '' : 'the screen');
  return make('Used', 'Using', tool ? tool.replace(/_/g, ' ') : 'computer');
}

/** Codex app-server methods that carry an MCP elicitation (Computer Use permission prompts). */
export function isElicitationRequest(method: string): boolean {
  return method === 'mcpServer/elicitation/request' || method.endsWith('/elicitation/request') || method === 'openai/form';
}
/** Elicitation prompt text from app-server or plugin payload shapes. */
export function elicitationText(params: Record<string, unknown>): string {
  const nested = params.elicitation ?? params.params ?? params.request;
  const row = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
  for (const value of [params.message, params.prompt, params.text, params.description, params.reason, params.title, row?.message, row?.prompt, row?.text, row?.description]) {
    if (typeof value === 'string' && value.trim()) return value.slice(0, 4096);
  }
  const schema = params.requestedSchema ?? row?.requestedSchema;
  if (schema && typeof schema === 'object') { try { return JSON.stringify(schema, null, 2).slice(0, 4096); } catch {} }
  return 'An MCP server asks for permission.';
}
export function elicitationServer(params: Record<string, unknown>): string {
  return (str(params.serverName) || str(params.server) || str(params.mcpServer)).slice(0, 128);
}
/** Full access answers for the user; workspace asks with an approval card; read-only declines. Muster's own in-app
 *  browser is first-party, shown live in the right pane and stops the moment the user takes control, so in workspace
 *  mode its steps run without a card (as Codex's built-in browser does). Desktop computer use still asks. */
export function elicitationPolicy(permissionMode: ChatPermissionMode | undefined, server = ''): 'accept' | 'ask' | 'decline' {
  if (permissionMode === 'full') return 'accept';
  if (permissionMode === 'workspace') return BROWSER_SERVER.test(server) ? 'accept' : 'ask';
  return 'decline';
}
export function elicitationResult(approved: boolean): Record<string, unknown> {
  return approved ? {action: 'accept', content: {}} : {action: 'decline', content: null};
}
