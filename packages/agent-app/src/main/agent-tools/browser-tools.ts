/** The in-app browser tools the agent sees through the muster_browser MCP server. Pure: no Electron. */
import {HTML_RENDER_LAYOUT_GUIDE, HTML_RENDER_NETWORK_GUIDE, HTML_RENDER_THEME_GUIDE} from '../../shared/html-render.ts';
export interface BrowserToolSpec { name: string; description: string; mutates: boolean; inputSchema: Record<string, unknown> }
/** #424: a sub-agent's own tab. Optional on every tool; without it the chat's main tab is used. */
const session = {session: {type: 'string', description: 'Optional short name (letters, digits, - or _) of your own browser tab, for a sub-agent working in parallel with others. Omit it to use the chat\'s tab.'}};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({type: 'object', properties: {...properties, ...session}, required, additionalProperties: false});
const target = {ref: {type: 'string', description: 'Element ref from browser_snapshot, e.g. e12'}, element: {type: 'string', description: 'Human-readable element description shown to the user'}, selector: {type: 'string', description: 'CSS selector, when no ref applies'}};
export const BROWSER_TOOL_SPECS: readonly BrowserToolSpec[] = [
  {name: 'browser_navigate', mutates: false, description: 'Open a URL in the in-app browser the user watches in the right pane. Returns a page snapshot.', inputSchema: obj({url: {type: 'string'}}, ['url'])},
  {name: 'browser_snapshot', mutates: false, description: 'Accessible outline of the current page with [ref=eN] handles for interactive elements.', inputSchema: obj({})},
  {name: 'browser_click', mutates: true, description: 'Click an element by ref (preferred) or selector.', inputSchema: obj({...target, double: {type: 'boolean'}})},
  {name: 'browser_type', mutates: true, description: 'Type text into an element. secret:true hides the text from the transcript.', inputSchema: obj({...target, text: {type: 'string'}, submit: {type: 'boolean'}, clear: {type: 'boolean'}, secret: {type: 'boolean'}}, ['text'])},
  {name: 'browser_press_key', mutates: true, description: 'Press a key in the page, e.g. Enter, Escape, ArrowDown, Tab.', inputSchema: obj({key: {type: 'string'}}, ['key'])},
  {name: 'browser_hover', mutates: false, description: 'Hover over an element.', inputSchema: obj(target)},
  {name: 'browser_select_option', mutates: true, description: 'Choose options in a <select>.', inputSchema: obj({...target, values: {type: 'array', items: {type: 'string'}}}, ['values'])},
  {name: 'browser_scroll', mutates: false, description: 'Scroll the page or an element.', inputSchema: obj({...target, direction: {type: 'string', enum: ['up', 'down', 'left', 'right']}, amount: {type: 'number', description: 'CSS pixels, default 600'}})},
  {name: 'browser_screenshot', mutates: false, description: 'Screenshot of the visible page.', inputSchema: obj({})},
  {name: 'browser_go_back', mutates: false, description: 'Go back in history.', inputSchema: obj({})},
  {name: 'browser_reload', mutates: false, description: 'Reload the page.', inputSchema: obj({})},
  {name: 'browser_wait_for', mutates: false, description: 'Wait for text to appear or disappear, or for a number of seconds (max 30).', inputSchema: obj({text: {type: 'string'}, textGone: {type: 'string'}, time: {type: 'number'}})},
  {name: 'browser_console_messages', mutates: false, description: 'Recent console and network errors of the page.', inputSchema: obj({})},
  // Previews and inline pages (#html-preview). Not browser actions: the bridge answers them itself.
  {name: 'render_html', mutates: false, description: `Show a finished HTML page (dashboard, chart, table, report, mockup) inline in the user's chat, above your reply; call it before writing that reply, and don't describe the page again in prose. It runs in a sandbox with no access to Muster, the user's files or (by default) the network. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE} ${HTML_RENDER_NETWORK_GUIDE}`, inputSchema: {type: 'object', properties: {html: {type: 'string', description: 'One complete, self-contained HTML document with inline <style> and <script>, at most 512 KB.'}, title: {type: 'string', description: 'Short name for the page, shown in its header.'}, network: {type: 'boolean', description: 'Ask the user to let this page load https resources (a CDN chart library, remote images). Default false.'}, image: {type: 'boolean', description: 'Also save a PNG of the page with the chat; the answer gives its path and the ![title](path) Markdown to attach it to your reply. Default false.'}}, required: ['html', 'title'], additionalProperties: false}},
  {name: 'preview_open', mutates: false, description: 'Show the user a preview of what you built: a local dev server or web URL (url, e.g. http://localhost:5173) opens in your browser tab with a live mini player in the chat, or a self-contained .html file in the workspace (file, a path) opens as a sandboxed page in the right pane. Start the dev server first (in the background) and pass the URL it prints. panel: true opens it straight in the right pane. Returns what loaded, or why it could not (for example, the server is not running).', inputSchema: obj({url: {type: 'string', description: 'http(s) URL, usually http://localhost:<port>'}, file: {type: 'string', description: 'Path of an .html file inside the workspace (absolute or relative to it)'}, panel: {type: 'boolean', description: 'Open in the right pane instead of the mini player'}})},
  {name: 'preview_close', mutates: false, description: 'Close the preview you opened with preview_open (your browser tab and its mini player).', inputSchema: obj({})},
];
/** The bridge answers these itself; they never reach a page. */
export const PREVIEW_TOOL_NAMES: ReadonlySet<string> = new Set(['render_html', 'preview_open', 'preview_close']);
export const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOL_SPECS.map(tool => tool.name));
export type McpContent = {type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string};
export interface McpToolResult { content: McpContent[]; isError?: boolean }
export const textResult = (text: string, isError = false): McpToolResult => ({content: [{type: 'text', text}], ...(isError ? {isError: true} : {})});

/** Isolated world shared by every agent script; refs live in its globals, never in the page's DOM. */
export const AGENT_WORLD = 1017;
/** Walks the visible page and assigns refs to interactive elements. Output is bounded. */
export const SNAPSHOT_SCRIPT = `(() => {
  const refs = new Map(); globalThis.__musterRefs = refs; let n = 0; const lines = []; const MAX = 400;
  const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const visible = el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const name = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const role = el => el.getAttribute('role') || ({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button'})[el.tagName] || (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button',range:'slider'})[el.type] || 'textbox' : el.isContentEditable ? 'textbox' : el.tagName.toLowerCase());
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el && n < MAX; el = walker.nextNode()) {
    if (/^H[1-3]$/.test(el.tagName) && visible(el)) { lines.push('- heading "' + name(el) + '"'); continue; }
    if (!el.matches(interactive) || !visible(el)) continue;
    const ref = 'e' + (++n); refs.set(ref, new WeakRef(el));
    let line = '- ' + role(el) + ' "' + name(el) + '" [ref=' + ref + ']';
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) line += el.checked ? ' [checked]' : '';
    else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) line += el.type === 'password' ? ' value="••••••"' : ' value="' + String(el.value).slice(0, 60) + '"';
    if (el.disabled) line += ' [disabled]';
    lines.push(line);
  }
  const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000);
  return {url: location.href, title: document.title, outline: lines.join('\\n'), truncated: n >= MAX, text};
})()`;
/** Resolves a ref or selector, scrolls it into view and returns its viewport centre in CSS pixels. */
export const resolveScript = (ref: string, selector: string) => `(() => {
  const ref = ${JSON.stringify(ref)}, selector = ${JSON.stringify(selector)};
  const el = ref ? globalThis.__musterRefs?.get(ref)?.deref() : selector ? document.querySelector(selector) : null;
  if (!el || !el.isConnected) return {error: ref ? 'Ref ' + ref + ' is stale or unknown. Take a new browser_snapshot.' : 'No element matches the selector.'};
  el.scrollIntoView({block: 'center', inline: 'center'});
  const r = el.getBoundingClientRect();
  return {x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, type: el.type || '', password: el.type === 'password'};
})()`;
/** Script-level action for pages the user cannot see (untrusted events, still honoured by most pages). */
export const elementScript = (ref: string, selector: string, body: string) => `(() => {
  const ref = ${JSON.stringify(ref)}, selector = ${JSON.stringify(selector)};
  const el = ref ? globalThis.__musterRefs?.get(ref)?.deref() : selector ? document.querySelector(selector) : document.scrollingElement;
  if (!el || !el.isConnected) return {error: 'The element is stale or unknown. Take a new browser_snapshot.'};
  ${body}
})()`;
export const CLICK_BODY = `el.scrollIntoView({block:'center'}); if (el.focus) el.focus(); el.click(); return {ok: true};`;
export const DOUBLE_CLICK_BODY = `el.scrollIntoView({block:'center'}); el.click(); el.click(); el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true})); return {ok: true};`;
export const HOVER_BODY = `for (const type of ['pointerover','mouseover','mouseenter','mousemove']) el.dispatchEvent(new MouseEvent(type, {bubbles: type !== 'mouseenter'})); return {ok: true};`;
export const focusBody = (clear: boolean) => `el.scrollIntoView({block:'center'}); el.focus(); ${clear ? `if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles: true})); } else if (el.isContentEditable) el.textContent = '';` : ''} return {ok: document.activeElement === el || el.contains(document.activeElement), password: el.type === 'password' || /pass|otp|token|secret/i.test(el.autocomplete || '')};`;
export const selectBody = (values: string[]) => `if (el.tagName !== 'SELECT') return {error: 'The element is not a <select>.'};
  const wanted = ${JSON.stringify(values)}; let matched = 0;
  for (const option of el.options) { option.selected = wanted.includes(option.value) || wanted.includes(option.label) || wanted.includes(option.text.trim()); if (option.selected) matched++; }
  el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true}));
  return matched ? {ok: true} : {error: 'None of the values match an option.'};`;
export const scrollBody = (dx: number, dy: number) => `(el === document.scrollingElement ? window : el).scrollBy({left: ${dx}, top: ${dy}, behavior: 'instant'}); return {ok: true};`;
export const textPresentScript = (text: string) => `(document.body?.innerText || '').includes(${JSON.stringify(text)})`;

/** Electron key names for sendInputEvent; single characters pass through. */
export function electronKey(key: string): string | undefined {
  const map: Record<string, string> = {enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown'};
  const trimmed = key.trim();
  if (trimmed.length === 1) return trimmed;
  return map[trimmed.toLowerCase()] ?? (/^F([1-9]|1[0-2])$/.test(trimmed) ? trimmed : undefined);
}
/** Arguments are untrusted model output: strings are bounded, numbers finite. */
export function toolArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const argString = (args: Record<string, unknown>, key: string, max = 8192) => typeof args[key] === 'string' ? (args[key] as string).slice(0, max) : '';
export const argNumber = (args: Record<string, unknown>, key: string, fallback: number, min: number, max: number) => typeof args[key] === 'number' && Number.isFinite(args[key]) ? Math.min(max, Math.max(min, args[key] as number)) : fallback;
export function formatSnapshot(value: unknown): string {
  const page = toolArgs(value);
  const outline = argString(page, 'outline', 60_000);
  return [`Page: ${argString(page, 'title', 300) || '(untitled)'} — ${argString(page, 'url', 2000)}`, outline ? `Interactive elements:\n${outline}${page.truncated ? '\n… (more elements omitted; scroll and snapshot again)' : ''}` : 'No interactive elements are visible.', argString(page, 'text', 3000) ? `Visible text (excerpt):\n${argString(page, 'text', 3000)}` : ''].filter(Boolean).join('\n\n');
}
