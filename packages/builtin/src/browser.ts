// The Browser tab (Cursor: Open Browser ⇧⌘B, a browser editor with a visual
// editor). The tab itself is a placeholder webview panel; the workbench
// contribution overlays a Chromium guest on it and reports back (title, URL,
// picked element, screenshots). Picks and screenshots land in the chat.
import * as vscode from "vscode";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PickedElement { selector: string; tag: string; id: string; classes: string[]; text: string; html: string; rect: { x: number; y: number; w: number; h: number }; styles: Record<string, string>; url: string; title: string }
export interface BrowserPick { readonly id: string; readonly picked: PickedElement | null; readonly imagePath: string | undefined; readonly url: string; readonly title: string }

export class BrowserTabs {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private counter = 0;
  private lastUrl: string;
  private readonly picks = new vscode.EventEmitter<BrowserPick>();
  readonly onPick = this.picks.event;
  private activeId: string | undefined;
  /** The editor group that is the browser pane (Cursor: browser tabs live in their own pane beside the code). */
  private groupColumn: vscode.ViewColumn | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly cwd: () => string) {
    this.lastUrl = context.workspaceState.get<string>("muster.browser.lastUrl", "http://localhost:3000");
    context.subscriptions.push(vscode.commands.registerCommand("muster.browser.event", (args: { id: string; kind: string; title?: string; url?: string }) => {
      const panel = this.panels.get(args.id);
      if (!panel) return;
      if (args.kind === "title" && args.title) panel.title = `Browser ${args.id} · ${args.title.slice(0, 40)}`;
      if (args.url) { this.lastUrl = args.url; void context.workspaceState.update("muster.browser.lastUrl", args.url); }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("muster.browser.picked", (args: { id: string; picked: PickedElement | null; image: string | null; url?: string; title?: string }) => {
      let imagePath: string | undefined;
      if (args.image?.startsWith("data:image/png;base64,")) {
        const dir = join(this.cwd(), ".muster", "browser"); mkdirSync(dir, { recursive: true });
        imagePath = join(dir, `shot-${Date.now().toString(36)}.png`);
        writeFileSync(imagePath, Buffer.from(args.image.slice("data:image/png;base64,".length), "base64"));
      }
      this.picks.fire({ id: args.id, picked: args.picked, imagePath, url: args.picked?.url ?? args.url ?? "", title: args.picked?.title ?? args.title ?? "" });
    }));
  }

  active(): string | undefined { return this.activeId; }

  async open(url?: string): Promise<string> {
    const target = url ?? (await vscode.window.showInputBox({ prompt: "Open Browser", value: this.lastUrl, placeHolder: "http://localhost:3000" }));
    if (!target) return "";
    const id = String(++this.counter);
    const column = this.groupColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel("muster.browserTab", `Browser ${id}`, column, { enableScripts: false, retainContextWhenHidden: true });
    this.groupColumn = panel.viewColumn ?? column;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "muster.svg");
    panel.webview.html = `<!doctype html><html><body style="margin:0;background:var(--vscode-editor-background)"></body></html>`;
    this.panels.set(id, panel);
    this.activeId = id;
    void vscode.commands.executeCommand("setContext", "muster.browserActive", true);
    panel.onDidChangeViewState(() => {
      if (panel.active) this.activeId = id;
      void vscode.commands.executeCommand("setContext", "muster.browserActive", panel.active);
      void vscode.commands.executeCommand("muster.browser.show", { id, visible: panel.visible });
    });
    panel.onDidDispose(() => { this.panels.delete(id); if (!this.panels.size) this.groupColumn = undefined; if (this.activeId === id) this.activeId = undefined; void vscode.commands.executeCommand("muster.browser.close", { id }); void vscode.commands.executeCommand("setContext", "muster.browserActive", false); });
    // Give the tab a frame to mount before the guest is laid over it.
    setTimeout(() => void vscode.commands.executeCommand("muster.browser.open", { id, url: target }), 150);
    return id;
  }
}
