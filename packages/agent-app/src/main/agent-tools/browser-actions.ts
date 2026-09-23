import type {KeyboardInputEvent, MouseInputEvent} from 'electron';
import type {BrowserConsoleEntry, BrowserState} from '../../shared/browser-protocol.ts';
import {AGENT_WORLD, BROWSER_TOOL_SPECS, CLICK_BODY, DOUBLE_CLICK_BODY, HOVER_BODY, SNAPSHOT_SCRIPT, argNumber, argString, electronKey, elementScript, focusBody, formatSnapshot, resolveScript, scrollBody, selectBody, textPresentScript, textResult, toolArgs, type McpToolResult} from './browser-tools.ts';

/** The narrow slice of WebContents the agent drives; tests pass a fake. */
export interface AgentContents {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: {code: string}[], userGesture?: boolean): Promise<unknown>;
  sendInputEvent(event: MouseInputEvent | KeyboardInputEvent): void;
  insertText(text: string): Promise<void>;
  isLoading(): boolean;
  getZoomFactor(): number;
}
export interface AgentPage { contents: AgentContents; attached: boolean; fill: boolean; state(): BrowserState }
/** One chat's agent browser tab as main exposes it to the bridge. */
export interface AgentBrowserHost {
  has(): boolean;
  open(url?: string): BrowserState;
  page(): AgentPage;
  back(): BrowserState;
  reload(): BrowserState;
  console(): BrowserConsoleEntry[];
  screenshot(): Promise<{dataUrl: string; width: number; height: number} | null>;
}
export interface ToolOutcome { result: McpToolResult; action: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function settle(page: AgentPage, maxMs: number): Promise<void> {
  await sleep(150);
  const end = Date.now() + maxMs;
  while (page.contents.isLoading() && Date.now() < end) await sleep(100);
}
const run = (page: AgentPage, code: string) => page.contents.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{code}], true);
async function snapshotText(page: AgentPage): Promise<string> {
  try { return formatSnapshot(await run(page, SNAPSHOT_SCRIPT)); }
  catch (error) { return `The page could not be read: ${error instanceof Error ? error.message : String(error)}`; }
}
const failed = (value: unknown): string | undefined => { const row = toolArgs(value); return typeof row.error === 'string' ? row.error : undefined; };
function key(page: AgentPage, name: string): void {
  const keyCode = electronKey(name);
  if (!keyCode) throw new Error(`Unknown key ${name}.`);
  page.contents.sendInputEvent({type: 'keyDown', keyCode});
  if (keyCode.length === 1 || keyCode === 'Enter') page.contents.sendInputEvent({type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode});
  page.contents.sendInputEvent({type: 'keyUp', keyCode});
}
/** Trusted input where the user can see the page; script events for a page that is not on screen. */
async function click(page: AgentPage, ref: string, selector: string, double: boolean): Promise<string | undefined> {
  if (page.attached && page.fill) {
    const point = toolArgs(await run(page, resolveScript(ref, selector)));
    if (typeof point.error === 'string') return point.error;
    const zoom = page.contents.getZoomFactor() || 1, x = Math.round(Number(point.x) * zoom), y = Math.round(Number(point.y) * zoom);
    page.contents.sendInputEvent({type: 'mouseMove', x, y});
    for (let count = 1; count <= (double ? 2 : 1); count++) {
      page.contents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: count});
      page.contents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: count});
    }
    return undefined;
  }
  return failed(await run(page, elementScript(ref, selector, double ? DOUBLE_CLICK_BODY : CLICK_BODY)));
}

/** Runs one tool call against the chat's browser. Read-only chats may look but not act. */
export async function runBrowserTool(host: AgentBrowserHost, tool: string, rawArgs: unknown, options: {readOnly: boolean}): Promise<ToolOutcome> {
  const spec = BROWSER_TOOL_SPECS.find(candidate => candidate.name === tool);
  if (!spec) return {result: textResult(`Unknown browser tool ${tool}.`, true), action: ''};
  if (spec.mutates && options.readOnly) return {result: textResult('This chat is read-only. Clicking, typing and form changes in the browser are not allowed.', true), action: ''};
  const args = toolArgs(rawArgs), ref = argString(args, 'ref', 32), selector = argString(args, 'selector', 1024), element = argString(args, 'element', 200) || ref || selector;
  if (tool === 'browser_navigate') {
    const url = argString(args, 'url');
    host.open(url);
    const page = host.page();
    await settle(page, 20_000);
    return {result: textResult(await snapshotText(page)), action: `Opened ${url}`};
  }
  if (!host.has()) {
    if (tool === 'browser_snapshot' || tool === 'browser_screenshot') host.open();
    else return {result: textResult('No page is open. Call browser_navigate first.', true), action: ''};
  }
  const page = host.page();
  switch (tool) {
    case 'browser_snapshot': return {result: textResult(await snapshotText(page)), action: 'Read the page'};
    case 'browser_screenshot': {
      const shot = await host.screenshot();
      if (!shot) return {result: textResult('The page could not be captured right now. Use browser_snapshot instead.', true), action: ''};
      const state = page.state();
      return {result: {content: [{type: 'image', data: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1), mimeType: shot.dataUrl.slice(5, shot.dataUrl.indexOf(';'))}, {type: 'text', text: `${state.title || '(untitled)'} — ${state.url} (${shot.width}×${shot.height})`}]}, action: 'Took a screenshot'};
    }
    case 'browser_click': {
      const error = await click(page, ref, selector, args.double === true);
      if (error) return {result: textResult(error, true), action: ''};
      await settle(page, 5000);
      return {result: textResult(await snapshotText(page)), action: `Clicked “${element}”`};
    }
    case 'browser_hover': {
      if (page.attached && page.fill) {
        const point = toolArgs(await run(page, resolveScript(ref, selector)));
        if (typeof point.error === 'string') return {result: textResult(point.error, true), action: ''};
        const zoom = page.contents.getZoomFactor() || 1;
        page.contents.sendInputEvent({type: 'mouseMove', x: Math.round(Number(point.x) * zoom), y: Math.round(Number(point.y) * zoom)});
      } else { const error = failed(await run(page, elementScript(ref, selector, HOVER_BODY))); if (error) return {result: textResult(error, true), action: ''}; }
      await sleep(200);
      return {result: textResult(await snapshotText(page)), action: `Hovered “${element}”`};
    }
    case 'browser_type': {
      const text = argString(args, 'text', 20_000);
      let secret = args.secret === true;
      if (ref || selector) {
        const focused = toolArgs(await run(page, elementScript(ref, selector, focusBody(args.clear === true))));
        if (typeof focused.error === 'string') return {result: textResult(focused.error, true), action: ''};
        secret ||= focused.password === true;
      }
      await page.contents.insertText(text);
      if (args.submit === true) key(page, 'Enter');
      await settle(page, args.submit === true ? 8000 : 1000);
      const shown = secret ? '••••••' : `“${text.slice(0, 40)}”`;
      return {result: textResult(await snapshotText(page)), action: `Typed ${shown}${element ? ` into “${element}”` : ''}`};
    }
    case 'browser_press_key': {
      const name = argString(args, 'key', 32);
      try { key(page, name); } catch (error) { return {result: textResult(error instanceof Error ? error.message : String(error), true), action: ''}; }
      await settle(page, 5000);
      return {result: textResult(await snapshotText(page)), action: `Pressed ${name}`};
    }
    case 'browser_select_option': {
      const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string').slice(0, 32).map(value => value.slice(0, 512)) : [];
      const error = failed(await run(page, elementScript(ref, selector, selectBody(values))));
      if (error) return {result: textResult(error, true), action: ''};
      await settle(page, 3000);
      return {result: textResult(await snapshotText(page)), action: `Selected ${values.join(', ')}`};
    }
    case 'browser_scroll': {
      const amount = argNumber(args, 'amount', 600, 1, 20_000), direction = argString(args, 'direction', 8) || 'down';
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0, dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      const error = failed(await run(page, elementScript(ref, selector, scrollBody(dx, dy))));
      if (error) return {result: textResult(error, true), action: ''};
      await sleep(200);
      return {result: textResult(await snapshotText(page)), action: `Scrolled ${direction}`};
    }
    case 'browser_go_back': host.back(); await settle(page, 10_000); return {result: textResult(await snapshotText(host.page())), action: 'Went back'};
    case 'browser_reload': host.reload(); await settle(page, 20_000); return {result: textResult(await snapshotText(host.page())), action: 'Reloaded the page'};
    case 'browser_wait_for': {
      const text = argString(args, 'text', 500), gone = argString(args, 'textGone', 500), end = Date.now() + argNumber(args, 'time', text || gone ? 30 : 1, 0, 30) * 1000;
      if (!text && !gone) { await sleep(end - Date.now()); return {result: textResult(await snapshotText(page)), action: 'Waited'}; }
      while (Date.now() < end) {
        const present = await run(page, textPresentScript(text || gone)).catch(() => false) === true;
        if (text ? present : !present) return {result: textResult(await snapshotText(page)), action: `Waited for “${text || gone}”`};
        await sleep(250);
      }
      return {result: textResult(`Timed out waiting for “${text || gone}” to ${text ? 'appear' : 'disappear'}.`, true), action: ''};
    }
    case 'browser_console_messages': {
      const entries = host.console().slice(-100);
      return {result: textResult(entries.length ? entries.map(entry => `[${entry.level}] ${entry.message}${entry.source ? ` (${entry.source}:${entry.line})` : ''}`).join('\n') : 'No console messages.'), action: 'Read the console'};
    }
  }
  return {result: textResult(`Unknown browser tool ${tool}.`, true), action: ''};
}
