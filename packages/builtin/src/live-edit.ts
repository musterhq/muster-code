// Live edits, the Cursor way: as Codex streams a file change, the target file
// opens as an INLINE diff (turn-start baseline vs the live buffer) and the
// streamed patch is rendered into the buffer as it arrives — words landing,
// green/red painting live. When the provider commits the write, the buffer
// reconciles to disk. Keep/Undo per file until the human decides.
import * as vscode from "vscode";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ApplyPatchStream, type PatchFile } from "./apply-patch.js";

const BASELINE_SCHEME = "muster-baseline";

interface LiveFile {
  readonly uri: vscode.Uri;
  readonly baseline: string;
  latest: string;
  opened: boolean;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export interface EditCard { readonly path: string; readonly adds: number; readonly dels: number; readonly status: "streaming" | "written" | "kept" | "undone" }

export class LiveEditController implements vscode.TextDocumentContentProvider {
  private readonly files = new Map<string, LiveFile>();
  private readonly streams = new Map<string, ApplyPatchStream>();
  private readonly baselineChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.baselineChanged.event;
  private readonly cards = new vscode.EventEmitter<EditCard>();
  readonly onCard = this.cards.event;

  constructor(private readonly cwd: () => string) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this));
    context.subscriptions.push(vscode.commands.registerCommand("muster.edit.keep", () => this.keepActive()));
    context.subscriptions.push(vscode.commands.registerCommand("muster.edit.undo", () => this.undoActive()));
    context.subscriptions.push(vscode.commands.registerCommand("muster.edit.keepAll", () => this.keepAll()));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.files.get(uri.path)?.baseline ?? "";
  }

  /** Wire into a turn: every raw app-server event flows through here. */
  onEvent(method: string, params: Record<string, unknown>): void {
    if (method === "item/fileChange/outputDelta") {
      const itemId = String(params.itemId ?? "");
      const delta = String(params.delta ?? "");
      let stream = this.streams.get(itemId);
      if (!stream) { stream = new ApplyPatchStream(); this.streams.set(itemId, stream); }
      for (const file of stream.push(delta)) this.paint(stream, file);
      return;
    }
    if (method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (item.type === "fileChange") {
        const changes = (item.changes ?? []) as { path?: string }[];
        for (const change of changes) if (change.path) this.reconcile(change.path);
        this.streams.delete(String(item.id ?? ""));
      }
    }
  }

  private paint(stream: ApplyPatchStream, file: PatchFile): void {
    if (file.op === "delete") return;
    const abs = resolve(this.cwd(), file.path);
    let live = this.files.get(abs);
    if (!live) {
      const baseline = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      live = { uri: vscode.Uri.file(abs), baseline, latest: baseline, opened: false };
      this.files.set(abs, live);
      void this.open(live);
    }
    const rendered = stream.render(file, live.baseline);
    live.latest = rendered;
    const adds = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "+").length, 0);
    const dels = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "-").length, 0);
    this.cards.fire({ path: file.path, adds, dels, status: "streaming" });
    // Coalesce paints to ~30fps: every token still lands, no frame is wasted.
    if (live.timer) return;
    live.timer = setTimeout(() => { live!.timer = undefined; void this.flush(live!); }, 33);
  }

  private async open(live: LiveFile): Promise<void> {
    const baseline = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: live.uri.fsPath });
    const name = live.uri.fsPath.split("/").pop() ?? "file";
    await vscode.commands.executeCommand("vscode.diff", baseline, live.uri, `${name} · Agent`, { preview: false, preserveFocus: true });
    live.opened = true;
    await vscode.commands.executeCommand("setContext", "muster.liveEdit", true);
  }

  private async flush(live: LiveFile): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(live.uri);
    if (doc.getText() === live.latest) return;
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(live.uri, full, live.latest);
    await vscode.workspace.applyEdit(edit);
  }

  /** The provider wrote the file: the buffer converges to disk, still painted against the baseline. */
  private reconcile(relPath: string): void {
    const abs = resolve(this.cwd(), relPath);
    const live = this.files.get(abs);
    if (!live) return;
    const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    live.latest = onDisk;
    void (async () => {
      const doc = await vscode.workspace.openTextDocument(live.uri);
      if (doc.getText() !== onDisk) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(live.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), onDisk);
        await vscode.workspace.applyEdit(edit);
      }
      if (doc.isDirty) await doc.save();
      const adds = onDisk.split("\n").length - live.baseline.split("\n").length;
      this.cards.fire({ path: relPath, adds: Math.max(0, adds), dels: Math.max(0, -adds), status: "written" });
    })();
  }

  private activeLive(): LiveFile | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) return undefined;
    return this.files.get(uri.fsPath) ?? this.files.get(uri.path);
  }

  private async keepActive(): Promise<void> {
    const live = this.activeLive();
    if (!live) return;
    await this.settle(live, "kept");
  }

  private async undoActive(): Promise<void> {
    const live = this.activeLive();
    if (!live) return;
    writeFileSync(live.uri.fsPath, live.baseline);
    const doc = await vscode.workspace.openTextDocument(live.uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(live.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), live.baseline);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await this.settle(live, "undone");
  }

  private async keepAll(): Promise<void> {
    for (const live of [...this.files.values()]) await this.settle(live, "kept");
  }

  private async settle(live: LiveFile, status: "kept" | "undone"): Promise<void> {
    this.files.delete(live.uri.fsPath);
    this.cards.fire({ path: vscode.workspace.asRelativePath(live.uri), adds: 0, dels: 0, status });
    // Swap the diff for the plain file so the editor reads as settled.
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.window.showTextDocument(live.uri, { preview: false });
    if (!this.files.size) await vscode.commands.executeCommand("setContext", "muster.liveEdit", false);
  }
}
