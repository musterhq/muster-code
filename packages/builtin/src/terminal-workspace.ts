import * as vscode from "vscode";
import { boundedText, DEFAULT_TERMINAL_OUTPUT_BYTES, searchText, type OutputMatch } from "./terminal-state.js";

export type ManagedTerminalStatus = "running" | "exited" | "closed";

export interface ManagedTerminalSummary {
  id: string;
  kind: "managed-shell";
  name: string;
  taskId?: string;
  taskLabel?: string;
  cwd: string;
  status: ManagedTerminalStatus;
  processId?: number;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  lastCommand?: string;
  outputBytes: number;
  outputLines: number;
}

export interface TerminalOpenArgs { id?: string; name?: string; taskId?: string; taskLabel?: string; cwd?: string; reuse?: boolean; command?: string; execute?: boolean; preserveFocus?: boolean }
export interface TerminalOutput { terminal: ManagedTerminalSummary; text: string; truncated: boolean }

type ManagedRecord = Omit<ManagedTerminalSummary, "outputLines"> & { terminal: vscode.Terminal; output: string; outputBytes: number };

/**
 * Registry for real VS Code shell terminals owned by a task or operator.
 * Provider command output is intentionally not registered here: it remains
 * attached to its provider tool event and cannot be mistaken for shell output.
 */
export class TerminalWorkspace implements vscode.Disposable {
  private readonly records = new Map<string, ManagedRecord>();
  private readonly byTerminal = new Map<vscode.Terminal, ManagedRecord>();
  private readonly changes = new vscode.EventEmitter<ManagedTerminalSummary[]>();
  readonly onChange = this.changes.event;
  private counter = 0;
  private disposed = false;
  private readonly outputBytes: number;

  constructor(private readonly context: vscode.ExtensionContext, private readonly cwd: () => string, outputBytes?: () => number) {
    const configuredBytes = outputBytes?.() ?? DEFAULT_TERMINAL_OUTPUT_BYTES;
    this.outputBytes = Number.isFinite(configuredBytes) ? Math.max(4_096, Math.min(1_000_000, Math.floor(configuredBytes))) : DEFAULT_TERMINAL_OUTPUT_BYTES;
    const subscriptions: vscode.Disposable[] = [
      vscode.window.onDidCloseTerminal((terminal) => this.onClose(terminal)),
      vscode.window.onDidChangeTerminalState((terminal) => this.onState(terminal)),
    ];
    // terminalDataWriteEvent is a proposal and may be absent in older compatible hosts.
    const onDidWriteTerminalData = (vscode.window as typeof vscode.window & { onDidWriteTerminalData?: vscode.Event<(event: { terminal: vscode.Terminal; data: string }) => void> }).onDidWriteTerminalData;
    if (onDidWriteTerminalData) subscriptions.push(onDidWriteTerminalData((event) => this.onOutput(event.terminal, event.data)));
    context.subscriptions.push(...subscriptions);
  }

  list(includeClosed = true): ManagedTerminalSummary[] {
    return [...this.records.values()]
      .filter((record) => includeClosed || record.status === "running")
      .map((record) => this.summary(record));
  }

  get(id: string): ManagedTerminalSummary | undefined { const record = this.records.get(id); return record && this.summary(record); }

  async listInteractive(): Promise<ManagedTerminalSummary[]> {
    const rows = this.list();
    if (!rows.length) { void vscode.window.showInformationMessage("No managed shell terminals are open."); return rows; }
    const pick = await vscode.window.showQuickPick(rows.map((row) => ({ label: `$(terminal) ${row.name}`, description: `${row.status} · ${row.taskLabel || row.taskId || "Managed shell"} · ${row.cwd}`, detail: row.id, id: row.id })), { placeHolder: "Managed terminals" });
    if (pick) await this.reveal(pick.id);
    return rows;
  }

  async open(args: TerminalOpenArgs = {}): Promise<ManagedTerminalSummary> {
    this.ensureOpen();
    const cwd = this.normalizeCwd(args.cwd);
    const reuse = args.reuse !== false;
    const existing = args.id ? this.records.get(args.id) : this.findReusable(args.taskId, args.taskLabel, cwd, args.name, reuse);
    let record = existing && existing.status === "running" ? existing : undefined;
    if (!record) {
      const name = this.safeName(args.name || args.taskLabel || (args.taskId ? `Task ${args.taskId}` : "Muster task"));
      const terminal = vscode.window.createTerminal({ name, cwd });
      record = this.register(terminal, { ...(args.taskId ? { taskId: args.taskId } : {}), ...(args.taskLabel ? { taskLabel: args.taskLabel } : {}), cwd });
    } else if (args.taskId || args.taskLabel) {
      if (args.taskId && !record.taskId) record.taskId = args.taskId;
      if (args.taskLabel && !record.taskLabel) record.taskLabel = args.taskLabel;
    }
    record.terminal.show(!!args.preserveFocus);
    if (args.command?.trim()) this.send(record.id, args.command, args.execute === true);
    this.emit();
    return this.summary(record);
  }

  async openInteractive(defaults: TerminalOpenArgs = {}): Promise<ManagedTerminalSummary | undefined> {
    const rows = this.list(false);
    const pick = await vscode.window.showQuickPick([
      { label: "$(add) Create managed terminal", description: "Native shell terminal with task ownership", id: "create" },
      ...rows.map((row) => ({ label: `$(terminal) ${row.name}`, description: `${row.taskLabel || row.taskId || "Managed shell"} · ${row.cwd}`, id: row.id })),
    ], { placeHolder: "Open managed terminal" });
    if (!pick) return undefined;
    return pick.id === "create" ? this.open(defaults) : this.reveal(pick.id);
  }

  async revealInteractive(id?: string): Promise<ManagedTerminalSummary | undefined> {
    return id ? this.reveal(id) : this.pickRunning("Reveal managed terminal").then((record) => record ? this.reveal(record.id) : undefined);
  }

  async outputInteractive(id?: string, maxChars?: number): Promise<TerminalOutput | undefined> {
    const record = id ? this.requireRecord(id) : await this.pickAny("Inspect managed terminal output");
    if (!record) return undefined;
    const result = this.output(record.id, maxChars); const doc = await vscode.workspace.openTextDocument({ content: result.text || "(no captured output)", language: "log" });
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    return result;
  }

  async searchInteractive(id?: string, query?: string): Promise<{ terminal: ManagedTerminalSummary; matches: OutputMatch[] } | undefined> {
    const record = id ? this.requireRecord(id) : await this.pickAny("Search managed terminal output");
    if (!record) return undefined;
    const needle = query ?? await vscode.window.showInputBox({ prompt: `Search output in ${record.name}`, placeHolder: "Text to find" });
    if (!needle?.trim()) return undefined;
    const result = this.search(record.id, needle); const content = result.matches.length ? result.matches.map((match) => `${match.line}: ${match.text}`).join("\n") : `No matches for ${needle}`;
    const doc = await vscode.workspace.openTextDocument({ content, language: "log" }); await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    return result;
  }

  async sendInteractive(id?: string): Promise<ManagedTerminalSummary | undefined> {
    const record = id ? this.requireRecord(id) : await this.pickRunning("Write to managed terminal");
    if (!record) return undefined;
    const text = await vscode.window.showInputBox({ prompt: `Write to ${record.name}`, placeHolder: "Shell text (execution is a separate choice)" });
    if (!text?.trim()) return undefined;
    const choice = await vscode.window.showQuickPick([{ label: "Write only", description: "Leave the text at the shell prompt", execute: false }, { label: "Write and execute", description: "Send Enter to the native shell", execute: true }], { placeHolder: "Execute this text?" });
    if (!choice) return undefined;
    return this.send(record.id, text, choice.execute);
  }

  async closeInteractive(id?: string): Promise<ManagedTerminalSummary | undefined> {
    const record = id ? this.requireRecord(id) : await this.pickRunning("Close managed terminal");
    if (!record) return undefined;
    const confirm = await vscode.window.showWarningMessage(`Close managed terminal ${record.name}?`, { modal: true }, "Close");
    return confirm === "Close" ? this.close(record.id) : undefined;
  }

  async create(args: TerminalOpenArgs = {}): Promise<ManagedTerminalSummary> { return this.open({ ...args, reuse: false }); }

  async reveal(id: string): Promise<ManagedTerminalSummary> {
    const record = this.requireRecord(id); record.terminal.show(false); return this.summary(record);
  }

  output(id: string, maxChars = 12_000): TerminalOutput {
    const record = this.requireRecord(id);
    const limit = Number.isFinite(maxChars) ? Math.max(1, Math.min(100_000, Math.floor(maxChars))) : 12_000;
    const text = record.output.length > limit ? record.output.slice(-limit) : record.output;
    return { terminal: this.summary(record), text, truncated: text.length !== record.output.length };
  }

  search(id: string, query: string, options: { limit?: number; caseSensitive?: boolean } = {}): { terminal: ManagedTerminalSummary; matches: OutputMatch[] } {
    const record = this.requireRecord(id);
    return { terminal: this.summary(record), matches: searchText(record.output, query, options) };
  }

  /** Write to the native terminal. execute=false preserves the existing Cmd+K behavior. */
  send(id: string, text: string, execute = false): ManagedTerminalSummary {
    const record = this.requireRecord(id); if (record.status !== "running") throw new Error(`Terminal ${id} is ${record.status}.`);
    const command = text.trim(); if (!command) throw new Error("Terminal text cannot be empty.");
    record.lastCommand = command.slice(0, 2_000);
    record.terminal.sendText(text, execute);
    this.emit(); return this.summary(record);
  }

  close(id: string): ManagedTerminalSummary {
    const record = this.requireRecord(id); record.terminal.dispose(); return this.summary(record);
  }

  dispose(): void { this.disposed = true; this.changes.dispose(); this.records.clear(); this.byTerminal.clear(); }

  private register(terminal: vscode.Terminal, details: { taskId?: string; taskLabel?: string; cwd?: string }): ManagedRecord {
    const prior = this.byTerminal.get(terminal); if (prior) return prior;
    const now = Date.now(); const id = `mt-${++this.counter}-${now.toString(36)}`;
    const record: ManagedRecord = { id, kind: "managed-shell", name: terminal.name, ...(details.taskId ? { taskId: details.taskId } : {}), ...(details.taskLabel ? { taskLabel: details.taskLabel } : {}), cwd: details.cwd || this.cwd(), status: "running", startedAt: now, terminal, output: "", outputBytes: 0 };
    this.records.set(id, record); this.byTerminal.set(terminal, record);
    void Promise.resolve(terminal.processId).then((processId) => { if (this.records.has(id) && processId !== undefined) { record.processId = processId; this.emit(); } }, () => undefined);
    return record;
  }

  private findReusable(taskId?: string, taskLabel?: string, cwd?: string, name?: string, reuse = true): ManagedRecord | undefined {
    if (!reuse) return undefined;
    const managed = [...this.records.values()].find((record) => record.status === "running" && (taskId ? record.taskId === taskId : taskLabel ? record.taskLabel === taskLabel : name ? record.name === name : record.cwd === cwd));
    if (managed || !name) return managed;
    const native = vscode.window.terminals.find((terminal) => terminal.name === name);
    return native ? this.register(native, { ...(cwd ? { cwd } : {}) }) : undefined;
  }

  private onOutput(terminal: vscode.Terminal, data: string): void {
    const record = this.byTerminal.get(terminal); if (!record || record.status !== "running") return;
    record.output = boundedText(record.output + data, this.outputBytes); record.outputBytes = Buffer.byteLength(record.output, "utf8"); this.emit();
  }

  private onState(terminal: vscode.Terminal): void {
    const record = this.byTerminal.get(terminal); if (!record) return;
    if (record.status === "running" && terminal.exitStatus) { record.status = "exited"; record.endedAt = Date.now(); if (terminal.exitStatus.code !== undefined) record.exitCode = terminal.exitStatus.code; }
    this.emit();
  }

  private onClose(terminal: vscode.Terminal): void {
    const record = this.byTerminal.get(terminal); if (!record) return;
    record.status = "closed"; record.endedAt = Date.now(); if (terminal.exitStatus?.code !== undefined) record.exitCode = terminal.exitStatus.code; this.emit();
  }

  private summary(record: ManagedRecord): ManagedTerminalSummary { const { terminal: _terminal, output: _output, ...summary } = record; return { ...summary, outputLines: record.output ? record.output.split("\n").length : 0 }; }
  private requireRecord(id: string): ManagedRecord { const record = this.records.get(id); if (!record) throw new Error(`Unknown managed terminal ${id}; list terminals for current IDs.`); return record; }
  private async pickRunning(placeHolder: string): Promise<ManagedRecord | undefined> { return this.pickAny(placeHolder, false); }
  private async pickAny(placeHolder: string, includeClosed = true): Promise<ManagedRecord | undefined> {
    const records = [...this.records.values()].filter((record) => includeClosed || record.status === "running");
    if (!records.length) { void vscode.window.showInformationMessage("No matching managed shell terminals are available."); return undefined; }
    const pick = await vscode.window.showQuickPick(records.map((record) => ({ label: `$(terminal) ${record.name}`, description: `${record.status} · ${record.cwd}`, id: record.id })), { placeHolder });
    return pick ? this.records.get(pick.id) : undefined;
  }
  private ensureOpen(): void { if (this.disposed) throw new Error("Managed terminal workspace is disposed."); }
  private normalizeCwd(value?: string): string { const target = value?.trim() || this.cwd(); return target.startsWith("/") ? target : this.cwd(); }
  private safeName(value: string): string { return value.replace(/[\r\n]/g, " ").trim().slice(0, 80) || "Muster task"; }
  private emit(): void { if (!this.disposed) this.changes.fire(this.list()); }
}

export { boundedText, searchText } from "./terminal-state.js";
