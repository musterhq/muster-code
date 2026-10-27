/** The muster_computer MCP server (#721): newline-delimited JSON-RPC on stdio. It owns one native helper process
 *  (dist/main/muster-computer on macOS) and turns its JSON-lines protocol into a small, model-friendly tool set.
 *  Every action waits for the app to settle and answers with what changed, so the model reads state once per step
 *  instead of re-reading the whole tree. A read-only chat gets the read tools only. */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {McpToolResult} from './browser-tools.ts';

type Message = {jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>};
type Schema = Record<string, unknown>;
export interface ComputerToolSpec { name: string; description: string; mutates: boolean; inputSchema: Schema }
const obj = (properties: Schema, required: string[] = []): Schema => ({type: 'object', properties, required, additionalProperties: false});
const app = {app: {type: 'string', description: 'App name, bundle id, .app path or pid.'}};
const element = {element: {type: 'integer', description: 'Element number from the latest state of this app.'}};

export const COMPUTER_TOOL_SPECS: ComputerToolSpec[] = [
  {name: 'list_apps', mutates: false, description: 'Running apps with their names, bundle ids and pids.', inputSchema: obj({})},
  {name: 'get_app_state', mutates: false, description: 'The app\'s windows and accessibility tree as numbered lines ([N] Role "title"). Opens the app in the background if it is not running. screenshot:true adds an image of its front window.', inputSchema: obj({...app, screenshot: {type: 'boolean'}}, ['app'])},
  {name: 'click', mutates: true, description: 'Click an element by number (preferred) or at x,y screen points. Returns what changed.', inputSchema: obj({...app, ...element, x: {type: 'number'}, y: {type: 'number'}, button: {type: 'string', enum: ['left', 'right']}, clicks: {type: 'integer', minimum: 1, maximum: 3}}, ['app'])},
  {name: 'type_text', mutates: true, description: 'Type text into an element, or into the focused field when no element is given. A newline is typed as Return. Returns what changed.', inputSchema: obj({...app, ...element, text: {type: 'string'}}, ['app', 'text'])},
  {name: 'set_value', mutates: true, description: 'Set a text field\'s or control\'s value directly. Returns what changed.', inputSchema: obj({...app, ...element, value: {type: 'string'}}, ['app', 'element', 'value'])},
  {name: 'press_key', mutates: true, description: 'Press keys in the app, e.g. "Return", "cmd+s", "shift+tab". Goes to the app, not to global shortcuts. Returns what changed.', inputSchema: obj({...app, keys: {type: 'string'}}, ['app', 'keys'])},
  {name: 'perform_action', mutates: true, description: 'Run an accessibility action on an element, e.g. AXPress, AXShowMenu, AXIncrement. Returns what changed.', inputSchema: obj({...app, ...element, action: {type: 'string'}}, ['app', 'element', 'action'])},
  {name: 'scroll', mutates: false, description: 'Scroll an element or the front window. amount is in lines (default 5). Returns what changed.', inputSchema: obj({...app, ...element, direction: {type: 'string', enum: ['up', 'down', 'left', 'right']}, amount: {type: 'integer'}}, ['app'])},
  {name: 'screenshot', mutates: false, description: 'Image of the app\'s front window. Prefer get_app_state: it is cheaper and gives element numbers.', inputSchema: obj(app, ['app'])},
];
const ACTION_COMMAND: Record<string, string> = {click: 'click', type_text: 'type_text', set_value: 'set_value', press_key: 'press_key', perform_action: 'perform_action', scroll: 'scroll'};
export const COMPUTER_INSTRUCTIONS = 'Drives macOS apps through their accessibility tree; input goes to the target app, so the person keeps their pointer, focus and clipboard. Loop: get_app_state, act on [N] element numbers, read the changes each action returns. Element numbers belong to the latest state: after an action, use the numbers it returns. Never sleep; actions already wait for the app to settle. A sheet or dialog shows up in the changes: handle it before going on.';

/** What the helper answers: a JSON object, or an error message. */
export type HelperCall = (cmd: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface AppMemory { lines: string[]; state: number }

const elementNumber = (line: string) => /^\s*\[(\d+)\]/.exec(line)?.[1];
/** Line-level change set between two states of one app: kept lines are not repeated, and an element whose line changed
 *  (same [N], new value or title) is reported once, as its new line. */
export function stateDelta(before: readonly string[], after: readonly string[]): {changed: string[]; added: string[]; removed: string[]} {
  const old = new Map<string, number>(), next = new Map<string, number>();
  for (const line of before) old.set(line, (old.get(line) ?? 0) + 1);
  const fresh: string[] = [];
  for (const line of after) { const left = old.get(line) ?? 0; if (left > 0) old.set(line, left - 1); else fresh.push(line); next.set(line, (next.get(line) ?? 0) + 1); }
  const stale: string[] = [];
  for (const line of before) { const left = next.get(line) ?? 0; if (left > 0) next.set(line, left - 1); else stale.push(line); }
  const staleNumbers = new Set(stale.map(elementNumber).filter(Boolean)), freshNumbers = new Set(fresh.map(elementNumber).filter(Boolean));
  const same = (line: string, other: Set<string | undefined>) => { const number = elementNumber(line); return !!number && other.has(number); };
  return {changed: fresh.filter(line => same(line, staleNumbers)), added: fresh.filter(line => !same(line, staleNumbers)), removed: stale.filter(line => !same(line, freshNumbers))};
}

const SETTLE_MS = 250;
const text = (value: string, isError = false): McpToolResult => ({content: [{type: 'text', text: value}], ...(isError ? {isError: true} : {})});
const header = (row: Record<string, unknown>) => {
  const info = (row.app ?? {}) as Record<string, unknown>;
  const windows = Array.isArray(row.windows) ? row.windows.length : 0;
  return `${String(info.name ?? 'App')} · state ${String(row.state)} · ${windows} window${windows === 1 ? '' : 's'}${typeof row.focused === 'number' ? ` · focused [${row.focused}]` : ''}${row.busy ? ' · still loading' : ''}${row.truncated ? ' · tree truncated' : ''}`;
};

/** Holds the per-app memory that makes each action answer with a delta. Exported for tests. */
export class ComputerTools {
  private readonly memory = new Map<string, AppMemory>();
  /** The name the model used for an app, mapped to the pid its states are kept under. */
  private readonly aliases = new Map<string, string>();
  constructor(private readonly helper: HelperCall, private readonly readOnly = false) {}
  specs(): ComputerToolSpec[] { return this.readOnly ? COMPUTER_TOOL_SPECS.filter(spec => !spec.mutates) : COMPUTER_TOOL_SPECS; }

  async call(name: string, raw: unknown): Promise<McpToolResult> {
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? {...raw as Record<string, unknown>} : {};
    const spec = COMPUTER_TOOL_SPECS.find(row => row.name === name);
    if (!spec) return text(`Unknown tool ${name}.`, true);
    if (spec.mutates && this.readOnly) return text('This chat is read-only, so Muster does not click, type or change apps here.', true);
    try {
      if (name === 'list_apps') {
        const apps = ((await this.helper('list_apps', {})).apps ?? []) as Array<Record<string, unknown>>;
        return text(apps.map(row => `${String(row.name)}${row.bundleId ? ` (${String(row.bundleId)})` : ''} pid ${String(row.pid)}${row.active ? ' · front' : ''}`).join('\n') || 'No apps are running.');
      }
      if (name === 'screenshot') return this.image(await this.helper('screenshot', {app: args.app}));
      if (name === 'get_app_state') return await this.state(String(args.app ?? ''), args.screenshot === true, true);
      const target = this.describe(String(args.app ?? ''), args.element);
      const via = await this.helper(ACTION_COMMAND[name]!, args);
      const result = await this.state(String(args.app ?? ''), false, false);
      result.content.unshift({type: 'text', text: `Done (${String(via.via ?? 'ok')})${target ? ` · ${target}` : ''}`});
      return result;
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** `Button "Add one"` for an element number of the app's latest state; the transcript names the step with it. */
  private describe(appName: string, element: unknown): string {
    if (typeof element !== 'number') return '';
    const lines = this.memory.get(this.aliases.get(appName) ?? appName)?.lines ?? [];
    const line = lines.find(row => elementNumber(row) === String(element));
    const match = line && /^\s*\[\d+\]\s+(\S+)(?:\s+"([^"]*)")?/.exec(line);
    return match ? (match[2] ? `${match[1]} "${match[2]}"` : match[1]!) : '';
  }

  private image(row: Record<string, unknown>): McpToolResult {
    if (typeof row.png !== 'string') return text('No image came back.', true);
    return {content: [{type: 'image', data: row.png, mimeType: 'image/png'} as never, {type: 'text', text: `${String(row.width)}×${String(row.height)} px`}]};
  }

  private async state(appName: string, screenshot: boolean, full: boolean): Promise<McpToolResult> {
    const row = await this.helper('state', {app: appName, settleMs: SETTLE_MS, ...(screenshot ? {screenshot: true} : {})});
    const lines = Array.isArray(row.lines) ? row.lines.map(String) : [];
    const key = String((row.app as Record<string, unknown> | undefined)?.pid ?? appName);
    this.aliases.set(appName, key);
    const before = this.memory.get(key);
    this.memory.set(key, {lines, state: Number(row.state) || 0});
    const parts: string[] = [header(row)];
    if (typeof row.hint === 'string') parts.push(row.hint);
    if (full || !before) parts.push(lines.join('\n'));
    else {
      const {changed, added, removed} = stateDelta(before.lines, lines);
      const total = changed.length + added.length + removed.length;
      if (!total) parts.push('No visible change.');
      else if (total > Math.max(40, lines.length * 0.6)) parts.push('Most of the window changed:', lines.join('\n'));
      else parts.push(...(changed.length ? ['Changed:', ...changed] : []), ...(added.length ? ['Appeared:', ...added] : []), ...(removed.length ? ['Gone:', ...removed] : []));
    }
    const result = text(parts.join('\n'));
    if (screenshot && row.screenshot && typeof row.screenshot === 'object') result.content.push(...this.image(row.screenshot as Record<string, unknown>).content);
    else if (typeof row.screenshotError === 'string') result.content.push({type: 'text', text: row.screenshotError});
    return result;
  }
}

/** One JSON-RPC message in, zero or one response out. Exported for tests. */
export async function handleComputerMessage(message: Message, tools: ComputerTools, write: (line: string) => void): Promise<void> {
  const respond = (body: Record<string, unknown>) => { if (message.id !== undefined && message.id !== null) write(JSON.stringify({jsonrpc: '2.0', id: message.id, ...body})); };
  switch (message.method) {
    case 'initialize': respond({result: {protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18', capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'muster_computer', title: 'Muster computer use', version: '1.0.0'}, instructions: COMPUTER_INSTRUCTIONS}}); return;
    case 'ping': respond({result: {}}); return;
    case 'tools/list': respond({result: {tools: tools.specs().map(({name, description, inputSchema}) => ({name, description, inputSchema}))}}); return;
    case 'tools/call': respond({result: await tools.call(typeof message.params?.name === 'string' ? message.params.name : '', message.params?.arguments ?? {})}); return;
    default:
      if (message.method?.startsWith('notifications/')) return;
      respond({error: {code: -32601, message: `Method not found: ${String(message.method)}`}});
  }
}

/** The helper process, started on first use and restarted if it exits. Requests run one at a time, as the helper does. */
export function helperProcess(binary: string, env: NodeJS.ProcessEnv = process.env): HelperCall & {close(): void} {
  let child: ChildProcessWithoutNullStreams | undefined, buffer = '', next = 1;
  const waiting = new Map<number, {resolve(row: Record<string, unknown>): void; reject(error: Error): void}>();
  const start = () => {
    const proc = spawn(binary, [], {stdio: ['pipe', 'pipe', 'pipe'], env});
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let reply: {id?: number; ok?: boolean; result?: Record<string, unknown>; error?: string};
        try { reply = JSON.parse(line); } catch { continue; }
        const pending = typeof reply.id === 'number' ? waiting.get(reply.id) : undefined;
        if (!pending) continue;
        waiting.delete(reply.id!);
        if (reply.ok) pending.resolve(reply.result ?? {}); else pending.reject(new Error(reply.error || 'The computer-use helper failed.'));
      }
    });
    proc.stderr.resume();
    const fail = (why: string) => { if (child === proc) child = undefined; buffer = ''; for (const [id, pending] of waiting) { waiting.delete(id); pending.reject(new Error(why)); } };
    proc.on('exit', code => fail(`The computer-use helper stopped (${code ?? 'signal'}). Try again.`));
    proc.on('error', error => fail(`The computer-use helper could not start: ${error.message}`));
    child = proc;
    return proc;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const call = ((cmd, args) => {
    const run = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const proc = child ?? start(), id = next++;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${cmd} got no answer within 60 s.`)); }, 60_000);
      waiting.set(id, {resolve: row => { clearTimeout(timer); resolve(row); }, reject: error => { clearTimeout(timer); reject(error); }});
      proc.stdin.write(JSON.stringify({id, cmd, args}) + '\n');
    });
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  }) as HelperCall & {close(): void};
  call.close = () => { child?.kill(); child = undefined; };
  return call;
}

function main(binary: string): void {
  const helper = helperProcess(binary);
  const tools = new ComputerTools(helper, process.env.MUSTER_COMPUTER_READ_ONLY === '1');
  const write = (line: string) => { process.stdout.write(line + '\n'); };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) buffer = '';
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Message;
      try { message = JSON.parse(line); } catch { write(JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}})); continue; }
      void handleComputerMessage(message, tools, write);
    }
  });
  process.stdin.on('end', () => { helper.close(); process.exit(0); });
}
if (process.argv[1] && /computer-mcp\.(c?js|ts)$/.test(process.argv[1]) && process.argv[2]) main(process.argv[2]);
