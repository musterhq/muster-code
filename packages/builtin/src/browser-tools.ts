// Extension-host half of the browser tools: a unix-socket server the MCP shim
// (browser-mcp.ts) calls into. Tools run against the visible browser tab through
// the workbench's browser commands (eval/input/capture over the main process),
// show Cursor's "Agent is using the browser · Take control" lock while driving,
// and stop the moment the user takes control.
import * as vscode from "vscode";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserController, BrowserState } from "./browser.js";

type ToolResult = { text?: string; image?: string; isError?: boolean };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Playwright-style snapshot: visible roles with [ref=eN] handles kept on window.__mref for later clicks. */
const SNAPSHOT_JS = `(() => {
  const refs = []; const lines = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const name = (el) => String(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("title") || el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const role = (el) => { const t = el.tagName.toLowerCase(); const r = el.getAttribute("role"); if (r) return r; if (t === "a" && el.getAttribute("href")) return "link"; if (t === "button" || (t === "input" && /^(button|submit|reset)$/.test(el.type))) return "button"; if (t === "input") return /^(checkbox|radio)$/.test(el.type) ? el.type : "textbox"; if (t === "textarea") return "textbox"; if (t === "select") return "combobox"; if (/^h[1-6]$/.test(t)) return "heading"; if (t === "img") return "img"; if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox"; return null; };
  const leaf = /^(button|link|heading|textbox|combobox|checkbox|radio|img|option|menuitem|tab)$/;
  const textTags = /^(P|LI|TD|TH|SPAN|DIV|LABEL|STRONG|EM|CODE|PRE|SMALL|DT|DD|FIGCAPTION|BLOCKQUOTE)$/;
  const walk = (root, depth) => { for (const el of root.children) {
    if (lines.length > 400) return;
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|TEMPLATE)$/.test(el.tagName) || el.id === "__muster_lock") continue;
    const r = role(el); const pad = "  ".repeat(Math.min(depth, 6));
    if (r && vis(el)) {
      let line = pad + "- " + r + ' "' + name(el) + '"';
      if (!/^(heading|img)$/.test(r)) { refs.push(el); line += " [ref=e" + refs.length + "]"; }
      if (r === "heading") line += " [level=" + el.tagName[1] + "]";
      if (r === "link") line += " href=" + el.getAttribute("href");
      if (/^(textbox|combobox)$/.test(r) && el.value) line += ' value="' + String(el.value).slice(0, 60) + '"';
      if (/^(checkbox|radio)$/.test(r) && el.checked) line += " [checked]";
      if (el.disabled) line += " [disabled]";
      lines.push(line);
      if (leaf.test(r)) continue;
    } else if (vis(el) && !el.children.length && textTags.test(el.tagName)) { const t = String(el.innerText || "").replace(/\\s+/g, " ").trim(); if (t.length > 1) lines.push(pad + '- text "' + t.slice(0, 120) + '"'); continue; }
    walk(el, depth + 1); if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
  } };
  walk(document.body, 0); window.__mref = refs;
  return "Page: " + document.title + "\\nURL: " + location.href + "\\n" + lines.join("\\n") + (lines.length > 400 ? "\\n… (truncated)" : "");
})()`;


const KEYS: Record<string, string> = { enter: "Return", return: "Return", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", arrowdown: "Down", arrowup: "Up", arrowleft: "Left", arrowright: "Right", down: "Down", up: "Up", left: "Left", right: "Right", space: "Space", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };

export class BrowserToolServer implements vscode.Disposable {
  readonly socketPath = join(tmpdir(), `muster-browser-${process.pid}.sock`);
  private server: Server | undefined;
  private userControl = false;

  constructor(
    private readonly browser: BrowserController,
    /** The tab the user is looking at (pane tab or browser editor), else undefined. */
    private readonly visibleTab: () => string | undefined,
    /** Open a browser tab for the agent when none exists. */
    private readonly openTab: (url?: string) => BrowserState | undefined,
    private readonly log: (line: string) => void,
  ) {
    browser.onTakeControl((id) => { this.userControl = true; this.log(`browser: user took control of ${id}`); });
  }

  start(): void {
    if (existsSync(this.socketPath)) { try { unlinkSync(this.socketPath); } catch { /* stale */ } }
    this.server = createServer((conn) => {
      createInterface({ input: conn }).on("line", async (line) => {
        let m: { id: number; tool: string; args?: Record<string, unknown> };
        try { m = JSON.parse(line); } catch { return; }
        const started = Date.now();
        const result = await this.execute(m.tool, m.args ?? {}).catch((error: Error) => ({ text: `Error: ${error.message}`, isError: true }));
        this.log(`browser tool ${m.tool} ${JSON.stringify(m.args ?? {}).slice(0, 120)} → ${result.isError ? "error" : "ok"} in ${Date.now() - started}ms`);
        conn.write(`${JSON.stringify({ id: m.id, result })}\n`);
      });
    });
    this.server.listen(this.socketPath);
  }

  dispose(): void { this.server?.close(); try { unlinkSync(this.socketPath); } catch { /* gone */ } }
  turnStarted(): void { this.userControl = false; }
  turnEnded(): void { for (const t of this.browser.list()) if (t.driving) this.browser.setDriving(t.id, false); }

  private eval(id: string, js: string): Promise<unknown> { return Promise.resolve(vscode.commands.executeCommand("muster.browser.eval", { id, js })); }
  private input(id: string, event: Record<string, unknown>): Promise<unknown> { return Promise.resolve(vscode.commands.executeCommand("muster.browser.input", { id, event })); }
  private async waitReady(id: string, ms = 12_000): Promise<void> {
    await sleep(250);
    const until = Date.now() + ms;
    while (Date.now() < until) { const r = await this.eval(id, "document.readyState").catch(() => null); if (r === "complete" || r === "interactive") return; await sleep(150); }
  }
  private async key(id: string, key: string): Promise<void> {
    const code = KEYS[key.toLowerCase()] ?? key;
    await this.input(id, { type: "keyDown", keyCode: code });
    if (code.length === 1 || code === "Return" || code === "Space") await this.input(id, { type: "char", keyCode: code === "Return" ? "\r" : code === "Space" ? " " : code });
    await this.input(id, { type: "keyUp", keyCode: code });
  }
  /** Locate the element for ref/selector, scroll it into view and return its viewport centre. */
  private async locate(id: string, args: Record<string, unknown>): Promise<{ x: number; y: number; label: string }> {
    const ref = typeof args.ref === "string" ? args.ref.replace(/^e/, "") : "";
    const finder = ref ? `(window.__mref || [])[${Number(ref) - 1}]` : `document.querySelector(${JSON.stringify(String(args.selector ?? ""))})`;
    const r = await this.eval(id, `(() => { const el = ${finder}; if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, label: (el.tagName + " " + (el.innerText || el.value || el.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim().slice(0, 60) }; })()`);
    if (!r || typeof r !== "object" || (r as { error?: string }).error) throw new Error(`No element for ${ref ? `ref e${ref}` : `selector ${String(args.selector)}`}; take a fresh browser_snapshot.`);
    return r as { x: number; y: number; label: string };
  }
  private async snapshot(id: string): Promise<string> { const r = await this.eval(id, SNAPSHOT_JS); return typeof r === "string" ? r : `Snapshot failed: ${JSON.stringify(r)}`; }

  private target(args: Record<string, unknown>, url?: string): BrowserState {
    const wanted = typeof args.tab === "string" ? this.browser.get(args.tab) : undefined;
    const visible = this.visibleTab(); const tab = wanted ?? (visible ? this.browser.get(visible) : undefined) ?? this.browser.list()[0] ?? this.openTab(url);
    if (!tab) throw new Error("No browser tab could be opened.");
    return tab;
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (tool === "browser_tabs") return { text: this.browser.list().map((t) => `${t.id}: ${t.title || "(untitled)"} — ${t.url}${t.driving ? " (agent)" : ""}`).join("\n") || "No browser tabs are open; browser_navigate opens one." };
    if (this.userControl) return { text: "The user took control of the browser. Ask them before using it again.", isError: true };
    const tab = this.target(args, tool === "browser_navigate" ? String(args.url ?? "") : undefined);
    const id = tab.id;
    this.browser.setDriving(id, true);
    switch (tool) {
      case "browser_navigate": { this.browser.navigate(id, String(args.url ?? "")); await this.waitReady(id); this.browser.setDriving(id, true); return { text: await this.snapshot(id) }; }
      case "browser_snapshot": return { text: await this.snapshot(id) };
      case "browser_click": { const p = await this.locate(id, args); const clicks = args.double ? 2 : 1; await this.input(id, { type: "mouseMove", x: Math.round(p.x), y: Math.round(p.y) }); for (let i = 1; i <= clicks; i++) { await this.input(id, { type: "mouseDown", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: i }); await this.input(id, { type: "mouseUp", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: i }); } await sleep(400); await this.waitReady(id, 3000); this.browser.setDriving(id, true); return { text: `Clicked ${p.label}\n\n${await this.snapshot(id)}` }; }
      case "browser_hover": { const p = await this.locate(id, args); await this.input(id, { type: "mouseMove", x: Math.round(p.x), y: Math.round(p.y) }); await sleep(200); return { text: `Hovering ${p.label}` }; }
      case "browser_type": {
        const p = await this.locate(id, args); await this.input(id, { type: "mouseMove", x: Math.round(p.x), y: Math.round(p.y) }); await this.input(id, { type: "mouseDown", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: 1 }); await this.input(id, { type: "mouseUp", x: Math.round(p.x), y: Math.round(p.y), button: "left", clickCount: 1 });
        const ref = typeof args.ref === "string" ? args.ref.replace(/^e/, "") : ""; const finder = ref ? `(window.__mref || [])[${Number(ref) - 1}]` : `document.querySelector(${JSON.stringify(String(args.selector ?? ""))})`;
        await this.eval(id, `(() => { const el = ${finder}; if (!el) return false; el.focus(); const v = ${JSON.stringify(String(args.text ?? ""))}; if (el.isContentEditable) { el.textContent = v; } else { const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, "value"); if (set && set.set) set.set.call(el, v); else el.value = v; } el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
        if (args.submit) { await this.key(id, "Enter"); await sleep(300); await this.waitReady(id, 3000); this.browser.setDriving(id, true); }
        return { text: `Typed into ${p.label}${args.submit ? " and pressed Enter" : ""}\n\n${await this.snapshot(id)}` };
      }
      case "browser_press_key": { await this.key(id, String(args.key ?? "")); await sleep(250); return { text: `Pressed ${String(args.key)}\n\n${await this.snapshot(id)}` }; }
      case "browser_select_option": {
        const ref = typeof args.ref === "string" ? args.ref.replace(/^e/, "") : ""; const finder = ref ? `(window.__mref || [])[${Number(ref) - 1}]` : `document.querySelector(${JSON.stringify(String(args.selector ?? ""))})`;
        const r = await this.eval(id, `(() => { const el = ${finder}; if (!el || el.tagName !== "SELECT") return "not a select"; const want = ${JSON.stringify(String(args.value ?? ""))}; const opt = [...el.options].find((o) => o.value === want || o.label.trim() === want || o.textContent.trim() === want); if (!opt) return "no option " + want + " among " + [...el.options].map((o) => o.value).join(", "); el.value = opt.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "selected " + opt.label; })()`);
        return { text: String(r) + "\n\n" + (await this.snapshot(id)), ...(typeof r === "string" && !r.startsWith("selected") ? { isError: true } : {}) };
      }
      case "browser_screenshot": { const data = await vscode.commands.executeCommand<string | null>("muster.browser.capture", { id }); if (typeof data !== "string" || !data.startsWith("data:image/png;base64,")) return { text: "Screenshot failed (is the browser tab visible?)", isError: true }; return { text: `Screenshot of ${tab.url}`, image: data.slice("data:image/png;base64,".length) }; }
      case "browser_console_messages": { const list = tab.console.slice(-100); return { text: list.length ? list.map((c) => `[${c.level}] ${c.message}${c.source ? ` (${c.source.split("/").pop()}${c.line ? `:${c.line}` : ""})` : ""}`).join("\n") : "No console output." }; }
      case "browser_evaluate": { const r = await this.eval(id, `(() => { try { const v = (0, eval)(${JSON.stringify(String(args.expression ?? ""))}); return v === undefined ? "undefined" : JSON.stringify(v); } catch (e) { return "Error: " + (e && e.message || e); } })()`); const text = typeof r === "string" ? r : JSON.stringify(r); return { text: text.length > 20_000 ? `${text.slice(0, 20_000)}… (truncated)` : text, ...(typeof text === "string" && text.startsWith("Error:") ? { isError: true } : {}) }; }
      case "browser_wait_for": {
        const text = typeof args.text === "string" ? args.text : ""; const ms = Math.min(30_000, Number(args.timeMs) || (text ? 10_000 : 1000));
        if (!text) { await sleep(ms); return { text: `Waited ${ms}ms` }; }
        const until = Date.now() + ms; while (Date.now() < until) { if ((await this.eval(id, `document.body && document.body.innerText.includes(${JSON.stringify(text)})`)) === true) return { text: `Found "${text}"` }; await sleep(250); }
        return { text: `Did not see "${text}" within ${ms}ms`, isError: true };
      }
      case "browser_go_back": { this.browser.action(id, "back"); await this.waitReady(id); this.browser.setDriving(id, true); return { text: await this.snapshot(id) }; }
      case "browser_reload": { this.browser.action(id, "reload"); await this.waitReady(id); this.browser.setDriving(id, true); return { text: await this.snapshot(id) }; }
      default: return { text: `Unknown tool ${tool}`, isError: true };
    }
  }
}
