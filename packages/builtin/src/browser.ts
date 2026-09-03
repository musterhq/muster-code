// Browser tabs inside the Agent pane (Cursor: the browser is a tab of the side
// pane with its own URL bar and sections). The pane's webview draws the chrome
// and reports where the page area sits; the workbench places a main-process
// WebContentsView over it and streams page events (title, URL, console) back.
import * as vscode from "vscode";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PickedSource { file: string; line: number; col: number; via: string; component?: string }
export interface PickedElement { selector: string; tag: string; id: string; classes: string[]; text: string; html: string; rect: { x: number; y: number; w: number; h: number }; styles: Record<string, string>; source?: PickedSource | null; url: string; title: string }
export interface BrowserPick { readonly id: string; readonly picked: PickedElement | null; readonly imagePath: string | undefined; readonly url: string; readonly title: string }
export interface ConsoleEntry { level: string; message: string; line?: number; source?: string }
export interface BrowserState { id: string; url: string; title: string; console: ConsoleEntry[]; picked: PickedElement | null; picking: boolean }

export class BrowserController {
  private readonly tabs = new Map<string, BrowserState>();
  private counter = 0;
  private lastUrl: string;
  private readonly changes = new vscode.EventEmitter<BrowserState>();
  readonly onChange = this.changes.event;
  private readonly picks = new vscode.EventEmitter<BrowserPick>();
  readonly onPick = this.picks.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly cwd: () => string) {
    this.lastUrl = context.workspaceState.get<string>("muster.browser.lastUrl", "http://localhost:3000");
    context.subscriptions.push(vscode.commands.registerCommand("muster.browser.event", (args: { id: string; kind: string; title?: string; url?: string; level?: string; message?: string; line?: number; source?: string }) => {
      const tab = this.tabs.get(args.id);
      if (!tab) return;
      if (args.kind === "title" && args.title !== undefined) tab.title = args.title;
      if ((args.kind === "navigate" || args.kind === "title" || args.kind === "ready") && args.url) { tab.url = args.url; this.lastUrl = args.url; void context.workspaceState.update("muster.browser.lastUrl", args.url); }
      if (args.kind === "console" && args.message !== undefined) { tab.console.push({ level: args.level ?? "log", message: args.message, ...(args.line !== undefined ? { line: args.line } : {}), ...(args.source ? { source: args.source } : {}) }); if (tab.console.length > 300) tab.console.shift(); }
      this.changes.fire(tab);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("muster.browser.picked", (args: { id: string; picked: PickedElement | null; image: string | null; url?: string; title?: string }) => {
      const tab = this.tabs.get(args.id);
      let imagePath: string | undefined;
      if (args.image?.startsWith("data:image/png;base64,")) {
        const dir = join(this.cwd(), ".muster", "browser"); mkdirSync(dir, { recursive: true });
        imagePath = join(dir, `shot-${Date.now().toString(36)}.png`);
        writeFileSync(imagePath, Buffer.from(args.image.slice("data:image/png;base64,".length), "base64"));
      }
      if (tab) { tab.picking = false; if (args.picked) tab.picked = args.picked; this.changes.fire(tab); }
      this.picks.fire({ id: args.id, picked: args.picked, imagePath, url: args.picked?.url ?? args.url ?? tab?.url ?? "", title: args.picked?.title ?? args.title ?? tab?.title ?? "" });
      if (args.picked?.source?.file) void this.openSource(args.picked.source);
    }));
  }

  list(): BrowserState[] { return [...this.tabs.values()]; }
  get(id: string): BrowserState | undefined { return this.tabs.get(id); }
  defaultUrl(): string { return this.lastUrl; }

  /** A new browser tab: the host (pane webview or a browser editor tab) draws the chrome and reports the page area. */
  open(url?: string, host: "pane" | "editor" = "pane"): BrowserState {
    const id = `b${++this.counter}`;
    const tab: BrowserState = { id, url: url ?? this.lastUrl, title: "", console: [], picked: null, picking: false };
    this.tabs.set(id, tab);
    void vscode.commands.executeCommand("muster.browser.open", { id, url: tab.url, host });
    if (host === "editor") this.openEditor(tab);
    return tab;
  }

  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private groupColumn: vscode.ViewColumn | undefined;

  /** Cursor's browser editor: a tab in the editor area (beside the code), with the navbar and tools drawn by the tab itself. */
  private openEditor(tab: BrowserState): void {
    const column = this.groupColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel("muster.browserTab", `Browser ${tab.id}`, column, { enableScripts: true, retainContextWhenHidden: true });
    this.groupColumn = panel.viewColumn ?? column;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "muster.svg");
    panel.webview.html = browserEditorHtml(panel.webview.cspSource);
    this.panels.set(tab.id, panel);
    const push = () => void panel.webview.postMessage({ type: "state", state: this.tabs.get(tab.id) });
    const sub = this.onChange((state) => { if (state.id === tab.id) { push(); panel.title = `Browser ${tab.id} · ${(state.title || state.url).slice(0, 40)}`; } });
    panel.webview.onDidReceiveMessage((m: { type: string; url?: string; action?: "back" | "forward" | "reload" | "pick" | "screenshot"; rect?: { top: number; left: number; width: number; height: number }; visible?: boolean }) => {
      if (m.type === "ready") push();
      else if (m.type === "nav" && m.url !== undefined) this.navigate(tab.id, m.url);
      else if (m.type === "action" && m.action) this.action(tab.id, m.action);
      else if (m.type === "rect" && m.rect) this.place(tab.id, m.rect, !!m.visible && panel.visible, "editor");
    });
    panel.onDidChangeViewState(() => { void vscode.commands.executeCommand("setContext", "muster.browserActive", panel.active); if (!panel.visible) this.place(tab.id, { top: 0, left: 0, width: 0, height: 0 }, false, "editor"); else push(); });
    panel.onDidDispose(() => { sub.dispose(); this.panels.delete(tab.id); if (!this.panels.size) this.groupColumn = undefined; this.close(tab.id); void vscode.commands.executeCommand("setContext", "muster.browserActive", false); });
    void vscode.commands.executeCommand("setContext", "muster.browserActive", true);
  }

  activeEditorBrowser(): string | undefined { for (const [id, panel] of this.panels) if (panel.active) return id; return undefined; }

  close(id: string): void { this.tabs.delete(id); void vscode.commands.executeCommand("muster.browser.close", { id }); }
  navigate(id: string, url: string): void { let u = url.trim(); if (u && !/^[a-z]+:\/\//i.test(u)) u = /^(localhost|\d+\.\d+|[\w-]+:\d+)/.test(u) ? `http://${u}` : `https://${u}`; const tab = this.tabs.get(id); if (tab && u) { tab.url = u; this.changes.fire(tab); void vscode.commands.executeCommand("muster.browser.navigate", { id, url: u }); } }
  action(id: string, action: "back" | "forward" | "reload" | "pick" | "screenshot"): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (action === "pick") { tab.picking = true; this.changes.fire(tab); }
    void vscode.commands.executeCommand(`muster.browser.${action}`, { id });
  }
  /** Where the page area sits inside the pane's webview; the workbench adds the webview's own offset. */
  place(id: string, rect: { top: number; left: number; width: number; height: number }, visible: boolean, host: "pane" | "editor" = "pane"): void {
    void vscode.commands.executeCommand("muster.browser.place", { id, rel: rect, visible, host });
  }

  async openSource(source: PickedSource): Promise<void> {
    const cwd = this.cwd();
    const raw = source.file.replace(/^(webpack|file|vite):\/\/\/?/, "").replace(/^\/@fs\//, "/").split("?")[0] ?? "";
    let hit = [raw, join(cwd, raw), join(cwd, raw.replace(/^\.\//, ""))].find((p) => p.startsWith("/") && existsSync(p));
    if (!hit) { const name = raw.split("/").pop() ?? ""; if (name) { const found = await vscode.workspace.findFiles(`**/${name}`, "**/{node_modules,.git,dist,build,out}/**", 1); hit = found[0]?.fsPath; } }
    if (!hit || !hit.startsWith(cwd)) return;
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(hit), { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One });
    const line = Math.max(0, (source.line || 1) - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  }
}

function browserEditorHtml(csp: string): string {
  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp};">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
  .browser-navbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; height: 32px; box-sizing: border-box; border-bottom: 1px solid var(--vscode-panel-border); flex: 0 0 auto; }
  .nav-button { display: flex; align-items: center; justify-content: center; height: 24px; width: 26px; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-foreground); opacity: .5; cursor: pointer; font: inherit; font-size: 13px; }
  .nav-button:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .url-input-container { display: flex; align-items: center; flex: 1; min-width: 0; position: relative; }
  .url-input { flex: 1; height: 24px; box-sizing: border-box; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--vscode-input-foreground); font: inherit; font-size: 12px; outline: none; }
  .url-input:hover:not(:focus) { background: var(--vscode-input-background); }
  .url-input:focus { background: var(--vscode-input-background); border-color: var(--vscode-input-border, transparent); }
  .url-input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: .5; }
  .url-loading-bar { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: transparent; }
  .url-loading-bar-progress { height: 100%; width: 0; background: var(--vscode-progressBar-background); transition: width .3s ease; }
  .browser-tools { display: flex; gap: 2px; margin-left: auto; flex-shrink: 0; }
  .browser-tools::before { content: ""; align-self: center; width: 1px; height: 16px; margin: 0 4px; background: var(--vscode-panel-border); opacity: .5; }
  .browser-tools .nav-button.on { background: #D2943E; color: #1a1a1a; opacity: 1; }
  .browser-frame-container { flex: 1; min-height: 0; position: relative; background: var(--vscode-editor-background); }
  .browser-frame-container[data-loaded] { background: #fff; }
</style></head>
<body>
  <div class="browser-navbar">
    <button class="nav-button" data-act="back" title="Back">←</button><button class="nav-button" data-act="forward" title="Forward">→</button><button class="nav-button" data-act="reload" title="Reload">⟳</button>
    <div class="url-input-container"><input class="url-input" id="url" type="text" placeholder="Enter URL or search..." autocomplete="off"><div class="url-loading-bar"><div class="url-loading-bar-progress" id="progress"></div></div></div>
    <div class="browser-tools"><button class="nav-button" id="pick" data-act="pick" title="Select element">⌖</button><button class="nav-button" data-act="screenshot" title="Screenshot to chat">⧉</button></div>
  </div>
  <div class="browser-frame-container" id="host"></div>
<script>
  const vscode = acquireVsCodeApi();
  const host = document.getElementById("host"), url = document.getElementById("url");
  let st = null;
  function report() { const r = host.getBoundingClientRect(); vscode.postMessage({ type: "rect", rect: { top: r.top, left: r.left, width: r.width, height: r.height }, visible: r.width > 10 && r.height > 10 }); }
  setInterval(report, 400); window.addEventListener("resize", report);
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") vscode.postMessage({ type: "nav", url: url.value }); e.stopPropagation(); });
  document.querySelectorAll(".nav-button").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "action", action: b.dataset.act })));
  window.addEventListener("message", (e) => { const m = e.data; if (m.type === "state" && m.state) { st = m.state; if (document.activeElement !== url) url.value = st.url || ""; document.getElementById("pick").classList.toggle("on", !!st.picking); if (st.url) host.setAttribute("data-loaded", "1"); report(); } });
  vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
