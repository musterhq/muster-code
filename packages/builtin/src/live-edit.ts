// Live edits, the Cursor way: the file stays in its own editor while the
// streamed patch lands in it token by token. Painting is done by the
// workbench-side contribution (product/muster-inline-diff.js: added-line
// decorations, tokenized ghost rows for removed lines, per-hunk overlay
// widgets, the review bar); this side owns the state — baseline, hunks,
// accept/reject — and drives the painter through muster.inlineDiff.*.
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApplyPatchStream, type PatchFile } from "./apply-patch.js";
import { applyHunk, lineDiff, type LineHunk } from "./line-diff.js";
import { parseUnifiedDiff, reverseApply } from "./unified-diff.js";

export type EditStatus = "streaming" | "written" | "kept" | "undone";
export interface EditCard { readonly path: string; readonly adds: number; readonly dels: number; readonly status: EditStatus; readonly hunks: number; readonly diff?: string }

export const BASELINE_SCHEME = "muster-baseline";

interface LiveFile {
  /** Counts of hunks already kept, so a settled card still reads "+12 −3" (Cursor keeps the numbers after Keep). */
  kept?: { adds: number; dels: number };
  readonly uri: vscode.Uri;
  readonly abs: string;
  readonly rel: string;
  /** Turn-start content the streamed patch is rendered against (per patch item). */
  origin: string;
  originItem: string;
  /** What the hunks are computed against; advances as hunks are accepted. */
  baseline: string[];
  target: string;
  streaming: boolean;
  hunks: LineHunk[];
  status: EditStatus;
  timer?: ReturnType<typeof setTimeout> | undefined;
  busy: boolean;
  again: boolean;
  shown: boolean;
}

interface StreamState { readonly stream: ApplyPatchStream; readonly touched: Map<string, PatchFile> }
interface HunkArgs { uri: string; index: number; action: "accept" | "reject" }
interface FileArgs { uri: string; action: "accept" | "reject" }
interface GoArgs { uri: string; direction: 1 | -1 }

export type Checkpoint = Map<string, { readonly existed: boolean; readonly content: string }>;
export interface RestoreResult { readonly changed: number; readonly inverse: Checkpoint }

export class LiveEditController {
  private checkpoint: Checkpoint | undefined;
  private readonly files = new Map<string, LiveFile>();
  private readonly streams = new Map<string, StreamState>();
  private readonly cards = new vscode.EventEmitter<EditCard>();
  readonly onCard = this.cards.event;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onChange = this.changed.event;

  constructor(private readonly cwd: () => string, private readonly log: (line: string) => void = () => {}) {}

  register(context: vscode.ExtensionContext): void {
    const cmd = (id: string, run: (...args: never[]) => Promise<void> | void) => context.subscriptions.push(vscode.commands.registerCommand(id, run as (...args: unknown[]) => unknown));
    cmd("muster.edit.accept", () => this.onCurrent((file, editor) => this.acceptHunk(file, this.currentHunk(file, editor.selection.active.line))));
    cmd("muster.edit.reject", () => this.onCurrent((file, editor) => this.rejectHunk(file, this.currentHunk(file, editor.selection.active.line))));
    cmd("muster.edit.acceptFile", () => this.onCurrent((file) => this.acceptFile(file)));
    cmd("muster.edit.rejectFile", () => this.onCurrent((file) => this.rejectFile(file)));
    cmd("muster.edit.acceptAll", () => this.acceptAll());
    cmd("muster.edit.rejectAll", () => this.rejectAll());
    cmd("muster.edit.next", () => this.onCurrent((file, editor) => this.jump(file, editor, 1)));
    cmd("muster.edit.prev", () => this.onCurrent((file, editor) => this.jump(file, editor, -1)));
    cmd("muster.edit.nextFile", () => this.jumpFile(1));
    cmd("muster.edit.prevFile", () => this.jumpFile(-1));
    // Clicks from the workbench widgets arrive with the file spelled out.
    cmd("muster.edit.hunk", (args: HunkArgs) => {
      const file = this.fileFor(args.uri);
      if (!file) return;
      return args.action === "accept" ? this.acceptHunk(file, args.index) : this.rejectHunk(file, args.index);
    });
    cmd("muster.edit.file", (args: FileArgs) => {
      const file = this.fileFor(args.uri);
      if (!file) return;
      return args.action === "accept" ? this.acceptFile(file) : this.rejectFile(file);
    });
    cmd("muster.edit.go", (args: GoArgs) => {
      const file = this.fileFor(args.uri);
      const editor = file && this.editorsOf(file)[0];
      if (!file || !editor) return;
      return this.jump(file, editor, args.direction);
    });
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const file of this.files.values()) this.repaint(file);
    }));
    // Turn-start contents, for the multi-file Review Changes editor (vscode.changes).
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, { provideTextDocumentContent: (uri) => this.files.get(uri.path)?.origin ?? "" }));
    cmd("muster.review.open", () => this.openReview());
    // Review Changes editor (multi-diff): per-file Keep / Undo from the file header, layout toggle from the title.
    const byArg = (arg: unknown, fn: (file: LiveFile) => Promise<void>) => {
      const a = arg as { resource?: vscode.Uri; uri?: vscode.Uri; modifiedUri?: vscode.Uri } | vscode.Uri | undefined;
      const uri = a instanceof vscode.Uri ? a : a?.modifiedUri ?? a?.resource ?? a?.uri ?? vscode.window.activeTextEditor?.document.uri;
      const file = uri ? this.files.get(uri.fsPath) : undefined; return file ? fn(file) : undefined;
    };
    cmd("muster.review.keepFile", (arg: unknown) => byArg(arg, (f) => this.acceptFile(f)));
    cmd("muster.review.undoFile", (arg: unknown) => byArg(arg, (f) => this.rejectFile(f)));
    cmd("muster.review.toggleLayout", async () => { await vscode.commands.executeCommand("toggle.diff.renderSideBySide"); });
  }

  /** Cursor's "Review Changes" editor: every live file against its turn-start contents, in one multi-diff editor. */
  async openReview(): Promise<void> {
    const files = [...this.files.values()];
    if (!files.length) { vscode.window.setStatusBarMessage("No pending changes to review", 2000); return; }
    const resources = files.map((f) => [f.uri, vscode.Uri.from({ scheme: BASELINE_SCHEME, path: f.abs }), f.uri]);
    await vscode.commands.executeCommand("vscode.changes", "Review Changes", resources);
  }

  /** Every raw app-server event of a turn flows through here. */
  onEvent(method: string, params: Record<string, unknown>): void {
    if (method === "item/fileChange/outputDelta") {
      const itemId = String(params.itemId ?? "");
      let state = this.streams.get(itemId);
      if (!state) { state = { stream: new ApplyPatchStream(), touched: new Map() }; this.streams.set(itemId, state); }
      for (const file of state.stream.push(String(params.delta ?? ""))) {
        state.touched.set(file.path, file);
        this.paint(itemId, state.stream, file);
      }
      return;
    }
    if (method === "turn/diff/updated") { const diff = String(params.diff ?? ""); this.log(`turn/diff/updated: ${diff.length} chars, ${parseUnifiedDiff(diff).length} file(s)`); this.adoptTurnDiff(diff); return; }
    if (method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (item.type !== "fileChange") return;
      const itemId = String(item.id ?? "");
      const changes = (item.changes ?? []) as { path?: string }[];
      const paths = changes.map((c) => c.path).filter((p): p is string => !!p);
      const state = this.streams.get(itemId);
      for (const path of paths.length ? paths : [...(state?.touched.keys() ?? [])]) this.reconcile(path);
      this.streams.delete(itemId);
    }
  }

  /** Edits made by any means (shell, scripts): the turn's unified diff tells us which files changed; we rebuild their turn-start
   * contents and paint them with the same inline diff and review controls. */
  private adoptTurnDiff(diff: string): void {
    if (!diff.trim()) return;
    for (const file of parseUnifiedDiff(diff)) {
      const abs = resolve(this.cwd(), file.path);
      if (this.files.has(abs)) continue;
      const exists = existsSync(abs);
      const current = exists ? readFileSync(abs, "utf8") : "";
      const origin = file.oldPath === null ? "" : reverseApply(current, file);
      if (origin === current) { this.log(`turn diff: ${file.path} — reverse apply left the file unchanged, not adopted`); continue; }
      if (this.checkpoint && !this.checkpoint.has(abs)) this.checkpoint.set(abs, { existed: file.oldPath !== null, content: origin });
      const live: LiveFile = { uri: vscode.Uri.file(abs), abs, rel: file.path, origin, originItem: "turn-diff", baseline: origin.split("\n"), target: current, streaming: false, hunks: [], status: "written", busy: false, again: false, shown: false };
      this.files.set(abs, live);
      void vscode.commands.executeCommand("setContext", "muster.liveEdit", true);
      void (async () => { try { await this.flush(live); await this.clearDirty(live); this.repaint(live); } catch (error) { this.log(`turn diff adopt failed: ${error instanceof Error ? error.message : String(error)}`); } })();
    }
  }

  /** Dev harness: pretend the provider committed the streamed patch to disk. */
  simulateWrite(itemId: string): string[] {
    const state = this.streams.get(itemId);
    if (!state) return [];
    const paths: string[] = [];
    for (const [path, file] of state.touched) {
      const abs = resolve(this.cwd(), path);
      const live = this.files.get(abs);
      if (file.op === "delete") continue;
      const origin = live?.origin ?? (existsSync(abs) ? readFileSync(abs, "utf8") : "");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, state.stream.render(file, origin));
      paths.push(path);
    }
    this.onEvent("item/completed", { item: { type: "fileChange", id: itemId, changes: paths.map((path) => ({ path })) } });
    return paths;
  }

  /** Checkpoints: record what every touched file looked like when the turn began. */
  /** "review": per-hunk Accept/Reject widgets; "auto" (full access): edits stand, diff colours stay, only Keep all / Undo all. */
  reviewMode: "review" | "auto" = "review";
  setReviewMode(mode: "review" | "auto"): void { if (this.reviewMode !== mode) { this.reviewMode = mode; for (const file of this.files.values()) this.repaint(file); } }

  // ── turn watch: shell-made edits (no apply_patch, no turn/diff/updated) still get painted ──
  private watch: { dirty: Map<string, string>; untracked: Set<string>; cwd: string } | undefined;
  private git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve) => execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout))));
  }
  /** Snapshot the files that are already dirty (their pre-turn content is not in HEAD) and remember what is untracked. */
  async beginTurnWatch(cwd: string): Promise<void> {
    const dirty = new Map<string, string>();
    const changed = (await this.git(cwd, ["diff", "--name-only", "HEAD"])).split("\n").filter(Boolean);
    for (const rel of changed.slice(0, 300)) { const abs = resolve(cwd, rel); try { if (existsSync(abs) && statSync(abs).size < 2_000_000) dirty.set(abs, readFileSync(abs, "utf8")); } catch { /* unreadable */ } }
    const untracked = new Set((await this.git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean).map((rel) => resolve(cwd, rel)));
    this.watch = { dirty, untracked, cwd };
  }
  /** Adopt every file the working tree now shows changed that nothing painted yet (origin: the pre-turn snapshot, else HEAD, else empty for new files). */
  async syncTurnWatch(final = false): Promise<void> {
    const w = this.watch; if (!w) return;
    const status = (await this.git(w.cwd, ["status", "--porcelain", "--untracked-files=all"])).split("\n").filter(Boolean);
    for (const line of status) {
      const code = line.slice(0, 2); const rel = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
      if (code.includes("D") || /^(node_modules|dist|\.git)\//.test(rel)) continue;
      const abs = resolve(w.cwd, rel);
      if (this.files.has(abs) || !existsSync(abs)) continue;
      let current: string; try { if (statSync(abs).size > 2_000_000) continue; current = readFileSync(abs, "utf8"); } catch { continue; }
      let origin: string; let existed = true;
      if (w.dirty.has(abs)) origin = w.dirty.get(abs)!;
      else if (w.untracked.has(abs) || code.startsWith("??") || code.startsWith("A")) { origin = ""; existed = false; if (w.untracked.has(abs)) continue; }
      else origin = await this.git(w.cwd, ["show", `HEAD:${rel}`]);
      if (origin === current) continue;
      if (this.checkpoint && !this.checkpoint.has(abs)) this.checkpoint.set(abs, { existed, content: origin });
      const live: LiveFile = { uri: vscode.Uri.file(abs), abs, rel, origin, originItem: "turn-watch", baseline: origin.split("\n"), target: current, streaming: false, hunks: [], status: "written", busy: false, again: false, shown: false };
      this.files.set(abs, live);
      this.log(`turn watch: adopted ${rel} (${existed ? "modified" : "new"})`);
      void vscode.commands.executeCommand("setContext", "muster.liveEdit", true);
      try { await this.flush(live); await this.clearDirty(live); this.repaint(live); } catch (error) { this.log(`turn watch adopt failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (final) this.watch = undefined;
  }

  beginCheckpoint(): void { this.checkpoint = new Map(); }
  takeCheckpoint(): Checkpoint { const taken = this.checkpoint ?? new Map(); this.checkpoint = undefined; return taken; }

  /** Restore a checkpoint: files the agent created are removed, edited files get their turn-start contents back. */
  async restore(checkpoint: Checkpoint): Promise<RestoreResult> {
    let count = 0;
    const inverse: Checkpoint = new Map();
    for (const [abs, before] of checkpoint) {
      const existed = existsSync(abs);
      inverse.set(abs, { existed, content: existed ? readFileSync(abs, "utf8") : "" });
      const live = this.files.get(abs);
      if (live) { this.clearPaint(live); this.files.delete(abs); }
      if (!before.existed) { if (existsSync(abs)) { unlinkSync(abs); count++; } continue; }
      if (!existsSync(abs) || readFileSync(abs, "utf8") !== before.content) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, before.content); count++; }
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
      if (doc?.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert", doc.uri);
    }
    if (!this.files.size) await vscode.commands.executeCommand("setContext", "muster.liveEdit", false);
    this.changed.fire();
    return { changed: count, inverse };
  }

  review(): EditCard[] {
    return [...this.files.values()].map((file) => this.card(file));
  }
  /** Cards of files already kept or undone this session (their counts survive settling, as in Cursor). */
  private readonly settled = new Map<string, EditCard>();
  settledCards(): EditCard[] { return [...this.settled.values()]; }

  async acceptAll(): Promise<void> { for (const file of [...this.files.values()]) await this.acceptFile(file); }
  async rejectAll(): Promise<void> { for (const file of [...this.files.values()]) await this.rejectFile(file); }

  /** Open the file from a chat card; with ifClosed, only when no editor shows it yet (keeps the diff toggle a no-op otherwise). */
  async open(path: string, ifClosed = false): Promise<void> {
    const uri = vscode.Uri.file(resolve(this.cwd(), path));
    const shown = vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === uri.fsPath);
    if (ifClosed && shown) return;
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: ifClosed });
  }

  // ── streaming ──

  private paint(itemId: string, stream: ApplyPatchStream, file: PatchFile): void {
    if (file.op === "delete") return;
    const abs = resolve(this.cwd(), file.path);
    let live = this.files.get(abs);
    if (!live) {
      const exists = existsSync(abs);
      const origin = exists ? readFileSync(abs, "utf8") : "";
      if (!exists) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, ""); }
      if (this.checkpoint && !this.checkpoint.has(abs)) this.checkpoint.set(abs, { existed: exists, content: origin });
      live = { uri: vscode.Uri.file(abs), abs, rel: file.path, origin, originItem: itemId, baseline: origin.split("\n"), target: origin, streaming: true, hunks: [], status: "streaming", busy: false, again: false, shown: false };
      this.files.set(abs, live);
      void vscode.commands.executeCommand("setContext", "muster.liveEdit", true);
    } else if (live.originItem !== itemId) {
      // A later patch in the same turn builds on what the provider wrote since.
      live.origin = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      live.originItem = itemId;
    }
    live.streaming = true;
    live.status = "streaming";
    live.target = stream.render(file, live.origin);
    this.schedule(live);
  }

  private schedule(file: LiveFile): void {
    if (file.timer) return;
    file.timer = setTimeout(() => { file.timer = undefined; void this.runFlush(file); }, 33);
  }

  private async runFlush(file: LiveFile): Promise<void> {
    if (file.busy) { file.again = true; return; }
    file.busy = true;
    try {
      await this.flush(file);
    } catch (error) {
      this.log(`live edit flush failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      file.busy = false;
      if (file.again) { file.again = false; this.schedule(file); }
    }
  }

  private async flush(file: LiveFile): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(file.uri);
    if (!file.shown) {
      file.shown = true;
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Active });
    }
    const current = doc.getText();
    if (current !== file.target) {
      let prefix = 0;
      while (prefix < current.length && prefix < file.target.length && current[prefix] === file.target[prefix]) prefix++;
      let suffix = 0;
      while (suffix < current.length - prefix && suffix < file.target.length - prefix && current[current.length - 1 - suffix] === file.target[file.target.length - 1 - suffix]) suffix++;
      const range = new vscode.Range(doc.positionAt(prefix), doc.positionAt(current.length - suffix));
      const text = file.target.slice(prefix, file.target.length - suffix);
      const editor = this.editorsOf(file)[0];
      if (editor) await editor.edit((b) => b.replace(range, text), { undoStopBefore: false, undoStopAfter: false });
      else { const edit = new vscode.WorkspaceEdit(); edit.replace(file.uri, range, text); await vscode.workspace.applyEdit(edit); }
    }
    this.repaint(file);
    if (file.streaming) {
      const last = file.hunks.at(-1);
      if (last) {
        const line = Math.min(last.targetStart + Math.max(0, last.targetCount - 1), doc.lineCount - 1);
        for (const editor of this.editorsOf(file)) editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  /** The provider wrote the file: converge to disk, clear the dirty flag, keep painting against the baseline. */
  private reconcile(relPath: string): void {
    const abs = resolve(this.cwd(), relPath);
    const live = this.files.get(abs);
    if (!live) return;
    live.streaming = false;
    live.status = "written";
    live.target = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    void (async () => {
      try {
        await this.flush(live);
        await this.clearDirty(live);
        this.repaint(live);
      } catch (error) {
        this.log(`live edit reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  private async clearDirty(file: LiveFile): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
    if (doc?.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert", file.uri);
  }

  // ── painting (delegated to the workbench contribution) ──

  private repaint(file: LiveFile): void {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
    if (!doc) return;
    file.hunks = lineDiff(file.baseline, doc.getText().split("\n"));
    const lines = doc.getText().split("\n");
    void vscode.commands.executeCommand("muster.inlineDiff.render", {
      uri: file.uri.toString(),
      hunks: file.hunks.map((h) => ({ start: h.targetStart + 1, count: h.targetCount, removed: h.removed, inner: innerRanges(h.removed, lines.slice(h.targetStart, h.targetStart + h.targetCount)) })),
      streaming: file.streaming,
      files: this.files.size,
      widgets: this.reviewMode === "review",
    });
    this.cards.fire(this.card(file));
    this.changed.fire();
  }

  private clearPaint(file: LiveFile): void {
    void vscode.commands.executeCommand("muster.inlineDiff.clear", { uri: file.uri.toString() });
  }

  // ── deciding ──

  private fileFor(uri: string): LiveFile | undefined {
    return this.files.get(vscode.Uri.parse(uri).fsPath);
  }

  private async onCurrent(run: (file: LiveFile, editor: vscode.TextEditor) => Promise<void> | void): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const file = editor && this.files.get(editor.document.uri.fsPath);
    if (!editor || !file) return;
    await run(file, editor);
  }

  private currentHunk(file: LiveFile, line: number): number {
    const inside = file.hunks.findIndex((h) => (h.targetCount ? line >= h.targetStart && line < h.targetStart + h.targetCount : line === h.targetStart));
    if (inside >= 0) return inside;
    const after = file.hunks.findIndex((h) => h.targetStart > line);
    return after >= 0 ? after : 0;
  }

  /** ⌥L / ⌥H: the next or previous file with pending changes, revealed at its first hunk (Cursor's review navigation). */
  private async jumpFile(direction: 1 | -1): Promise<void> {
    const files = [...this.files.values()];
    if (!files.length) return;
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const at = files.findIndex((f) => f.abs === activePath);
    const next = files[((at < 0 ? (direction > 0 ? -1 : 0) : at) + direction + files.length) % files.length]!;
    const editor = await vscode.window.showTextDocument(next.uri, { preview: false });
    const first = next.hunks[0];
    if (first) { const position = new vscode.Position(first.targetStart, 0); editor.selection = new vscode.Selection(position, position); editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
  }

  private async jump(file: LiveFile, editor: vscode.TextEditor, direction: 1 | -1): Promise<void> {
    if (!file.hunks.length) return;
    const line = editor.selection.active.line;
    const current = this.currentHunk(file, line);
    const within = file.hunks[current]!;
    const on = within.targetCount ? line >= within.targetStart && line < within.targetStart + within.targetCount : line === within.targetStart;
    const index = (current + (on || direction < 0 ? direction : 0) + file.hunks.length) % file.hunks.length;
    const hunk = file.hunks[index]!;
    const position = new vscode.Position(hunk.targetStart, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async acceptHunk(file: LiveFile, index: number): Promise<void> {
    const hunk = file.hunks[index];
    if (!hunk) return;
    if (file.streaming && index === file.hunks.length - 1) { vscode.window.setStatusBarMessage("Still writing this change", 2000); return; }
    const doc = await vscode.workspace.openTextDocument(file.uri);
    file.kept = { adds: (file.kept?.adds ?? 0) + hunk.targetCount, dels: (file.kept?.dels ?? 0) + hunk.removed.length };
    file.baseline = applyHunk(file.baseline, doc.getText().split("\n"), hunk);
    this.repaint(file);
    if (!file.hunks.length) await this.settle(file);
  }

  private async rejectHunk(file: LiveFile, index: number): Promise<void> {
    const hunk = file.hunks[index];
    if (!hunk) return;
    if (file.streaming) { vscode.window.setStatusBarMessage("Wait for the edit to finish before rejecting", 2000); return; }
    const doc = await vscode.workspace.openTextDocument(file.uri);
    const start = new vscode.Position(hunk.targetStart, 0);
    const endLine = hunk.targetStart + hunk.targetCount;
    const range = endLine < doc.lineCount
      ? new vscode.Range(start, new vscode.Position(endLine, 0))
      : new vscode.Range(hunk.targetStart > 0 ? doc.lineAt(hunk.targetStart - 1).range.end : start, doc.lineAt(doc.lineCount - 1).range.end);
    const text = endLine < doc.lineCount
      ? hunk.removed.map((l) => `${l}\n`).join("")
      : (hunk.targetStart > 0 ? "\n" : "") + hunk.removed.join("\n");
    const editor = this.editorsOf(file)[0];
    if (editor) await editor.edit((b) => b.replace(range, text));
    else { const edit = new vscode.WorkspaceEdit(); edit.replace(file.uri, range, text); await vscode.workspace.applyEdit(edit); }
    this.repaint(file);
    if (!file.hunks.length) await this.settle(file);
  }

  private async acceptFile(file: LiveFile): Promise<void> {
    if (file.streaming) { vscode.window.setStatusBarMessage("Still writing this file", 2000); return; }
    const doc = await vscode.workspace.openTextDocument(file.uri);
    file.kept = { adds: (file.kept?.adds ?? 0) + file.hunks.reduce((n, h) => n + h.targetCount, 0), dels: (file.kept?.dels ?? 0) + file.hunks.reduce((n, h) => n + h.removed.length, 0) };
    file.baseline = doc.getText().split("\n");
    await this.settle(file);
  }

  private async rejectFile(file: LiveFile): Promise<void> {
    if (file.streaming) { vscode.window.setStatusBarMessage("Wait for the edit to finish before rejecting", 2000); return; }
    const doc = await vscode.workspace.openTextDocument(file.uri);
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const editor = this.editorsOf(file)[0];
    if (editor) await editor.edit((b) => b.replace(full, file.origin));
    else { const edit = new vscode.WorkspaceEdit(); edit.replace(file.uri, full, file.origin); await vscode.workspace.applyEdit(edit); }
    await this.settle(file);
  }

  /** Every hunk decided: the buffer is the truth, disk follows, the editor reads as a plain file again. */
  private async settle(file: LiveFile): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(file.uri);
    const text = doc.getText();
    const onDisk = existsSync(file.abs) ? readFileSync(file.abs, "utf8") : "";
    if (onDisk !== text) writeFileSync(file.abs, text);
    await this.clearDirty(file);
    file.status = text === file.origin ? "undone" : "kept";
    file.hunks = [];
    this.clearPaint(file);
    this.files.delete(file.abs);
    if (!this.files.size) await vscode.commands.executeCommand("setContext", "muster.liveEdit", false);
    this.settled.set(file.abs, this.card(file));
    this.cards.fire(this.card(file));
    this.changed.fire();
  }

  private editorsOf(file: LiveFile): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === file.uri.toString());
  }

  private card(file: LiveFile): EditCard {
    const adds = file.hunks.reduce((n, h) => n + h.targetCount, 0) + (file.kept?.adds ?? 0);
    const dels = file.hunks.reduce((n, h) => n + h.removed.length, 0) + (file.kept?.dels ?? 0);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.uri.toString());
    const lines = doc ? doc.getText().split("\n") : [];
    const out: string[] = [];
    for (const h of file.hunks) {
      if (out.length > 160) { out.push("…"); break; }
      out.push(`@@ ${h.targetStart + 1}`);
      for (const r of h.removed) out.push(`-${r}`);
      for (let i = 0; i < h.targetCount; i++) out.push(`+${lines[h.targetStart + i] ?? ""}`);
    }
    return { path: file.rel, adds, dels, status: file.status, hunks: file.hunks.length, ...(out.length ? { diff: out.join("\n") } : {}) };
  }
}

/** Cursor's inner-change highlights: for removed/added lines paired by position, the changed span after trimming
 * the common prefix and suffix (row = index within the hunk; columns are 0-based character offsets). */
export function innerRanges(removed: readonly string[], added: readonly string[]): { added: { row: number; start: number; end: number }[]; removed: { row: number; start: number; end: number }[] } {
  const out = { added: [] as { row: number; start: number; end: number }[], removed: [] as { row: number; start: number; end: number }[] };
  const pairs = Math.min(removed.length, added.length);
  for (let i = 0; i < pairs; i++) {
    const before = removed[i]!;
    const after = added[i]!;
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const changedBefore = before.length - prefix - suffix;
    const changedAfter = after.length - prefix - suffix;
    if (changedBefore <= 0 && changedAfter <= 0) continue;
    // Whole-line rewrites get no inner box (Cursor shows plain green/red for those).
    if (changedAfter > after.length * 0.8 && changedBefore > before.length * 0.8) continue;
    if (changedAfter > 0) out.added.push({ row: i, start: prefix, end: after.length - suffix });
    if (changedBefore > 0) out.removed.push({ row: i, start: prefix, end: before.length - suffix });
  }
  return out;
}
