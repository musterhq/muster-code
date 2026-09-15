import { activityId, boundedEventData, cancelQueuedMessages, cleanDraft, queueMessage, readUsage, type ActivityRecord, type ComposerDraft, type DurableRun, type RunState, type RunUsage, type UsageLedgerEntry } from "./conversation-state.js";
import { paneHtml } from "./agent-view.js";
import { assertSelectionChange, migrateProviderSelection, validateSelection, providerLabel, type ProviderId } from "./provider-routing.js";
import { bindConversationProvider } from "./codex.js";
import { AgentGraphAdapter, type AgentGraphSnapshot } from "./agent-orchestration.js";
import { isChildOfRoot } from "./agent-control.js";
import { activeDescendantCount, editLeaseActive as isEditLeaseActive, canCloseWithActiveDescendants } from "./edit-lease.js";
import { TaskRuntimeRegistry, type TaskRuntimeIdentity } from "./task-runtime-registry.js";
// The Agent pane — muster's own chat surface in the secondary sidebar, built to
// Cursor's chat (docs/cursor-parity-spec.md, docs/cursor-feature-atlas.md):
// thread tabs, history, modes (Agent / Plan / Ask / Kanban / custom), access
// modes and models discovered from the app-server, plan cards saved as
// .plan.md in the workspace, tool cards, edit cards, the review bar.
import * as vscode from "vscode";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { archiveThread, controlOwnedTurn, formatAge, formatSize, interruptTurn, isUnattendedAccess, lastRollbackError, listAccessModes, listModels, listSkills, listThreads, readHistory, readRules, revertThread, rollbackThread, runClaudeTurn, runTurn, setThreadName, steerTurn, threadsForWorkspace, type AccessMode, type CodexThread, type ModelInfo, type SkillInfo } from "./codex.js";
import { LiveEditController, type Checkpoint, type EditCard } from "./live-edit.js";
import { expandContext, listRules, rememberPick, saveBrowserPick, suggestMentions, suggestSlash, type ContextReference, type MenuData, type MenuSection } from "./context.js";
import type { BrowserPick, BrowserController, BrowserState } from "./browser.js";
import type { ThreadRead, ThreadRecord } from "./thread-catalog.js";

interface ModeInfo { readonly id: string; readonly name: string; readonly icon: string; readonly placeholder: string; readonly description?: string; readonly prompt?: string; readonly readOnly?: boolean; readonly plan?: boolean; readonly board?: boolean; readonly effort?: string; readonly autoFix?: boolean; readonly debug?: boolean; readonly parallel?: boolean; readonly spec?: boolean }
interface ThreadSettings { providerId?: ProviderId; mode: string; accessId: string; modelId: string; effortId: string; debugStage?: 0 | 1 | 2 }
interface PlanCard { title: string; summary: string; todos: { text: string; done: boolean }[]; path?: string; model?: string; modelId?: string }
type ToolMessage = { kind: "tool"; id: string; title: string; detail: string; output: string; status: string; tool?: "command" | "mcp" | "search" | "computer"; exitCode?: number | null; durationMs?: number; cwd?: string };
/** An approval the provider is waiting on, shown as a card in the chat (Cursor: Run ⏎ / Skip Esc). */
type ApprovalCard = { diff?: string; id: string; kind: "command" | "patch" | "elicitation"; command: string; cwd?: string; reason?: string; files?: string[] };
type PaneMessage =
  | { kind: "user"; text: string; checkpoint?: string; steer?: boolean; turnId?: string }
  | { kind: "assistant"; text: string; reasoning: string }
  | ToolMessage
  | { kind: "plan"; card: PlanCard };
interface RedoState { checkpoint: Checkpoint; messages: PaneMessage[] }
interface Tab { queueWaiters?: (() => void)[]; proposals?: Map<string, {path?: string; diff?: string}[]>; promptEstimate?: number; draft?: ComposerDraft; usage?: RunUsage; usageLedger?: UsageLedgerEntry[]; activity?: string; activityTimeline?: ActivityRecord[]; contextReferences?: ContextReference[]; agentGraph?: AgentGraphSnapshot; run?: DurableRun; startedAt?: number; edits?: EditCard[]; id: string; name: string; kind?: "chat" | "browser"; browserId?: string; thread?: CodexThread; messages: PaneMessage[]; settings: ThreadSettings; plan?: PlanCard; claudeSession?: string; running: boolean; inlineRunning?: boolean; checkpoints: Map<string, Checkpoint>; redo?: RedoState; autoFixed?: boolean; queue?: string[]; pendingRevert?: { turnId?: string; turns: number }; lastError?: string }
interface BoardTask { id: string; title: string; column: "backlog" | "progress" | "review" | "done"; threadId?: string; createdAt: number }

function isPaneMessage(value: unknown): value is PaneMessage {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  const row = value as Record<string, unknown>;
  if (kind === "user") return typeof row.text === "string";
  if (kind === "assistant") return typeof row.text === "string" && typeof row.reasoning === "string";
  if (kind === "tool") return typeof row.id === "string" && typeof row.title === "string" && typeof row.detail === "string" && typeof row.output === "string" && typeof row.status === "string";
  if (kind === "plan") { const card = row.card; return !!card && typeof card === "object" && typeof (card as Record<string, unknown>).title === "string" && typeof (card as Record<string, unknown>).summary === "string" && Array.isArray((card as Record<string, unknown>).todos); }
  return false;
}

type ToPane =
  | { type: "state"; appearance: { density: string; fontSize: number; accent: string; glass: boolean }; draft: ComposerDraft; usage?: RunUsage; usageLedger?: UsageLedgerEntry[]; activity?: string; activityTimeline?: ActivityRecord[]; contextReferences?: ContextReference[]; agentWorkspace?: AgentGraphSnapshot; taskWorkspace?: { version: 1; activeTaskId: string; tasks: readonly (TaskRuntimeIdentity & { name: string; status: string; capability: "isolated-worktree" | "shared-checkout-serialized"; activeTurnId?: string })[] }; run?: DurableRun; runState?: RunState; startedAt?: number; promptEstimate?: number; reviewMode: "auto" | "review"; queue?: string[]; currentFile?: string | undefined; tabs: { id: string; name: string; running: boolean; kind?: "chat" | "browser" }[]; activeId: string; view: "chat" | "history" | "board" | "browser"; modes: ModeInfo[]; access: AccessMode[]; models: ModelInfo[]; settings: ThreadSettings; loading: boolean; canRedo: boolean }
  | { type: "browser"; state: BrowserState }
  | { type: "messages"; messages: PaneMessage[]; edits?: EditCard[] }
  | { type: "telemetry"; activity: string; usage?: RunUsage; usageLedger?: UsageLedgerEntry[]; activityTimeline?: ActivityRecord[]; contextReferences?: ContextReference[]; agentWorkspace?: AgentGraphSnapshot; run?: DurableRun; runState?: RunState; startedAt?: number; promptEstimate?: number }
  | { type: "agentActionResult"; action: string; agentId: string; ok: boolean; reason?: string }
  | { type: "agentWorkspace"; data: AgentGraphSnapshot }
  | { type: "user"; text: string; checkpoint?: string; steer?: boolean }
  | { type: "approval"; approval: ApprovalCard } | { type: "approvalDone"; id: string; decision: string }
  | { type: "start" }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: ToolMessage }
  | { type: "plan"; card: PlanCard }
  | { type: "done"; ok: boolean; error?: string }
  | { type: "edit"; card: EditCard }
  | { type: "review"; files: EditCard[] }
  | { type: "threads"; items: { id: string; name: string; project: string; age: string; turns: number; size: string; live: boolean; pinned: boolean }[] }
  | { type: "board"; columns: { id: string; title: string; cards: { id: string; title: string; subtitle: string; running: boolean }[] }[] }
  | { type: "suggestions"; kind: "file" | "skill"; seq?: number; mode: string; title: string; sections: MenuSection[] }
  | { type: "validated"; ok: string[]; bad: string[] }
  | { type: "setInput"; text: string }
  | { type: "openModeMenu" } | { type: "openMenu"; kind: "model" | "context" | "access" } | { type: "dictation"; text?: string; on: boolean } | { type: "browserExtras"; bookmarks: { title: string; url: string }[]; cert?: { url: string; error: string } | null }
  | { type: "insert"; text: string }
  | { type: "imageResolved"; src: string; uri: string };
type FromPane =
  | { type: "draft"; id: string; draft: ComposerDraft }
  | { type: "ready" } | { type: "boot" } | { type: "clientError"; message: string } | { type: "send"; text: string } | { type: "stop" } | { type: "dropQueued"; index: number } | { type: "decide"; id: string; decision: string } | { type: "openPath"; path: string; line?: number; endLine?: number } | { type: "insertBlock"; code: string } | { type: "applyBlock"; path: string; code: string; lang?: string } | { type: "editMessage"; checkpoint: string; text: string } | { type: "resolveImage"; src: string }
  | { type: "acceptAll" } | { type: "rejectAll" } | { type: "open"; path: string; ifClosed?: boolean }
  | { type: "newAgent" } | { type: "openThread"; id: string } | { type: "closeTab"; id: string } | { type: "activateTab"; id: string } | { type: "renameThread"; id: string } | { type: "archiveThread"; id: string } | { type: "exportThread"; id: string } | { type: "dictate" } | { type: "browserBookmark"; id: string } | { type: "browserDevtools"; id: string } | { type: "browserTrust"; id: string }
  | { type: "view"; view: "chat" | "history" | "board" }
  | { type: "setMode"; id: string } | { type: "setAccess"; id: string } | { type: "setModel"; id: string } | { type: "setEffort"; id: string }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "viewPlan" } | { type: "buildPlan"; todos?: number[]; model?: string; newThread?: boolean }
  | { type: "suggest"; kind: "file" | "skill"; query: string; mode?: string; seq?: number } | { type: "slashAction"; id: string }
  | { type: "probed"; seq?: number; query?: string | null; mode?: string | null; cards?: string[]; value?: string; rows: { text: string; sel: boolean; icon: string }[]; chips: { t: string; bad: boolean }[]; marks: { t: string; bad: boolean }[]; title: string } | { type: "restore"; id: string } | { type: "attach" } | { type: "pasteImage"; mime: string; data: string; name?: string } | { type: "validate"; tokens: string[] } | { type: "command"; id: string } | { type: "redo" }
  | { type: "openReview" }
  | { type: "boardAdd"; title: string } | { type: "boardRun"; id: string } | { type: "boardMove"; id: string; column: BoardTask["column"] }
  | { type: "browserEdit"; id: string; kind: "text" | "style"; prop?: string; value: string } | { type: "browserRevert"; id: string; index: number } | { type: "browserApply"; id: string } | { type: "browserTakeControl"; id: string }
  | { type: "browserNav"; id: string; url: string } | { type: "browserAction"; id: string; action: "back" | "forward" | "reload" | "pick" | "screenshot" } | { type: "browserRect"; id: string; rect: { top: number; left: number; width: number; height: number }; visible: boolean } | { type: "browserToChat"; id: string } | { type: "newBrowser" }
  | { type: "agentAction"; action: "open" | "steer" | "interrupt" | "stop"; agentId: string; threadId?: string };

// Cursor 3.18's built-in modes (docs/cursor-feature-atlas.md §3), mapped onto Codex: plan/spec use the
// plan collaboration mode, ask/project are read-only, triage prefers the delegating effort, multitask is the board.
const DEBUG_STAGES = [
  { placeholder: "Enter additional context about the issue", prompt: "Debug mode, step 1 of 3: do NOT fix anything yet. Form hypotheses about the issue, add temporary instrumentation (logs/traces/assertions) at the points that will confirm or rule them out, then stop and ask me to reproduce the issue." },
  { placeholder: "Issue reproduced, please proceed", prompt: "Debug mode, step 2 of 3: I have reproduced the issue with your instrumentation in place. Read the captured logs/traces (run the relevant commands or tests if needed), identify the root cause, fix it, and confirm the fix with evidence. Keep the instrumentation for now." },
  { placeholder: "The issue has been fixed. Please clean up the instrumentation.", prompt: "Debug mode, step 3 of 3: the issue is fixed. Remove every piece of temporary instrumentation you added, keeping the fix, and summarise the root cause in two sentences." },
];

export const BUILTIN_MODES: ModeInfo[] = [
  { id: "agent", name: "Agent", icon: "∞", description: "Plan, search, make edits, run commands", placeholder: "Plan, search, build anything", autoFix: true },
  { id: "triage", name: "Triage", icon: "⇶", description: "Coordinate long-horizon tasks with delegated subagents", placeholder: "Describe the long-horizon task to coordinate", effort: "ultra", prompt: "Coordinate this as a long-horizon task: break it into sub-tasks, delegate what can run independently to subagents, integrate the results, and report what was done and what remains." },
  { id: "plan", name: "Plan", icon: "☰", description: "Create detailed plans for accomplishing tasks", placeholder: "Plan, Build, / for skills, @ for context", plan: true },
  { id: "spec", name: "Spec", icon: "☑", description: "Create structured plans with implementation steps", placeholder: "Describe what to specify", plan: true, spec: true, prompt: "Write a structured specification: goals, non-goals, architecture, data changes, then numbered implementation steps with acceptance criteria as a to-do list." },
  { id: "debug", name: "Debug", icon: "✱", description: "Systematically diagnose and fix bugs using runtime traces", placeholder: "Enter additional context about the issue", debug: true, autoFix: true },
  { id: "multitask", name: "Multitask", icon: "◎", description: "Run and coordinate multiple tasks in parallel", placeholder: "List the tasks to run in parallel (one per line)", parallel: true },
  { id: "chat", name: "Ask", icon: "◌", description: "Ask questions about your codebase", placeholder: "Ask, learn, brainstorm", readOnly: true },
  { id: "project", name: "Project", icon: "▣", description: "Special conversation mode for project-level discussions", placeholder: "Discuss the project", readOnly: true, prompt: "This is a project-level discussion: reason about architecture, scope and trade-offs across the whole repository; do not edit files." },
];

export class AgentPane implements vscode.WebviewViewProvider {
  static readonly viewId = "muster.agent.pane";
  private view: vscode.WebviewView | undefined;
  private tabs: Tab[] = [];
  private activeId = "";
  private paneView: "chat" | "history" | "board" | "browser" = "chat";
  browser: BrowserController | undefined;
  private models: ModelInfo[] = [];
  private access: AccessMode[] = [];
  private loading = true;
  private catalogLoaded = false;
  private lastChatId = "";
  private skills: SkillInfo[] | undefined;
  private readyCount = 0;
  private lastProbe: unknown = null;
  private readonly catalogChanged = new vscode.EventEmitter<void>();
  readonly onCatalog = this.catalogChanged.event;
  private readonly accountEvents = new vscode.EventEmitter<Record<string, unknown>>();
  readonly onAccountEvent = this.accountEvents.event;
  private readonly taskRuntimes = new TaskRuntimeRegistry<LiveEditController>();
  private readonly runtimeControllers = new Map<string, LiveEditController>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.LogOutputChannel, private readonly live: LiveEditController) {
    this.live.onCard((card) => { const tab = this.editOwner ?? this.active(); (tab.edits ??= []); const i = tab.edits.findIndex(e => e.path === card.path); if (i < 0) tab.edits.push(card); else tab.edits[i] = card; this.post({ type: "edit", card }, tab.id); });
    this.live.onChange(() => this.post({ type: "review", files: this.live.review() }));
    const saved = this.context.workspaceState.get<{ id: string; name: string; thread?: CodexThread; draft: ComposerDraft; settings: ThreadSettings; messages?: PaneMessage[]; usage?: RunUsage; usageLedger?: UsageLedgerEntry[]; activityTimeline?: ActivityRecord[]; contextReferences?: ContextReference[]; agentGraph?: AgentGraphSnapshot; run?: DurableRun; queue?: string[] }[]>("muster.openChats", []);
    for (const item of saved) {
      const run = item.run?.state === "preparing" || item.run?.state === "running" || item.run?.state === "waiting" ? { ...item.run, state: "disconnected" as const, endedAt: Date.now(), error: "Muster Code was reloaded while this run was active. It was not replayed." } : item.run;
      this.tabs.push({ ...item, settings: migrateProviderSelection(item.settings), draft: cleanDraft(item.draft), messages: Array.isArray(item.messages) ? item.messages.filter(isPaneMessage) : [], ...(Array.isArray(item.queue) ? { queue: item.queue.filter((value): value is string => typeof value === "string").slice(0, 100) } : {}), ...(item.usage ? { usage: readUsage(item.usage) } : {}), ...(item.usageLedger ? { usageLedger: item.usageLedger } : {}), ...(item.activityTimeline ? { activityTimeline: item.activityTimeline } : {}), ...(item.contextReferences ? { contextReferences: item.contextReferences } : {}), ...(item.agentGraph ? { agentGraph: AgentGraphAdapter.from(item.agentGraph).snapshot() } : {}), ...(run ? { run, ...(run.state === "disconnected" ? { activity: "Disconnected", lastError: run.error } : {}) } : {}), running: false, checkpoints: new Map() });
    }
    this.activeId = this.context.workspaceState.get<string>("muster.activeChat", "");
    for (const tab of this.tabs) if (tab.settings.providerId) bindConversationProvider(tab.id, tab.settings.providerId);
    if (!this.tabs.length) this.newTab();
    else if (!this.tabs.some(t => t.id === this.activeId)) this.activeId = this.tabs[0]!.id;
  }

  private editOwner: Tab | undefined;
  private restorePromise: Promise<void> | undefined;
  /** Memento writes are async; serialize snapshots so an older event cannot
   * resolve after a newer event and overwrite durable run state. */
  private saveChain: Promise<void> = Promise.resolve();
  private async restoreHistories(): Promise<void> {
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = Promise.allSettled(this.tabs.filter(t => t.thread && !t.messages.length).map(async t => {
      const history = await readHistory(t.thread!);
      t.messages = history.map((m, i) => m.role === "user" ? { kind: "user", text: m.text, checkpoint: `cp-h-${t.thread!.id}-${i}` } : { kind: "assistant", text: m.text, reasoning: "" });
    })).then(() => undefined);
    return this.restorePromise;
  }
  private compactMessages(messages: PaneMessage[]): PaneMessage[] {
    return messages.slice(-240).map((message) => message.kind === "tool" ? { ...message, output: message.output.slice(-24_000) } : message.kind === "assistant" ? { ...message, text: message.text.slice(-80_000), reasoning: message.reasoning.slice(-24_000) } : message);
  }
  private saveChats(): void {
    const chats = this.tabs.filter(t => t.kind !== "browser").map(t => ({ id: t.id, name: t.name, ...(t.thread ? { thread: t.thread } : {}), draft: t.draft ?? cleanDraft(null), settings: t.settings, messages: this.compactMessages(t.messages), ...(t.queue?.length ? { queue: t.queue.slice(0, 100) } : {}), ...(t.usage ? { usage: t.usage } : {}), ...(t.usageLedger?.length ? { usageLedger: t.usageLedger.slice(-100) } : {}), ...(t.activityTimeline?.length ? { activityTimeline: t.activityTimeline.slice(-300) } : {}), ...(t.contextReferences?.length ? { contextReferences: t.contextReferences.slice(-100) } : {}), ...(t.agentGraph ? { agentGraph: t.agentGraph } : {}), ...(t.run ? { run: t.run } : {}) }));
    const activeChat = this.activeId;
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      await this.context.workspaceState.update("muster.openChats", chats);
      await this.context.workspaceState.update("muster.activeChat", activeChat);
    }).catch((error) => this.output.appendLine(`state save failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private recordActivity(tab: Tab, method: string, params: Record<string, unknown>): void {
    const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : {};
    const sequence = (tab.activityTimeline?.length ?? 0) + 1;
    const data = boundedEventData(params);
    const record: ActivityRecord = { id: activityId(method, params, sequence), ts: Date.now(), method, ...(typeof item.type === "string" ? { itemType: item.type } : {}), ...(typeof item.id === "string" ? { itemId: item.id } : {}), ...(method === "item/commandExecution/outputDelta" ? { summary: String(params.delta ?? "").slice(0, 240) } : {}), ...(method.endsWith("/requestApproval") ? { summary: "Approval requested" } : {}), ...(method === "turn/completed" ? { summary: String((params.turn as Record<string, unknown> | undefined)?.status ?? "completed") } : {}), ...(data ? { data } : {}) };
    (tab.activityTimeline ??= []).push(record);
    if (tab.activityTimeline.length > 300) tab.activityTimeline.splice(0, tab.activityTimeline.length - 300);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { if (this.view?.visible) this.pushState(); }));
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("muster.modes") || e.affectsConfiguration("muster.ui")) this.pushState(); }));
    this.view = view;
    const appRoot = vscode.Uri.file(vscode.env.appRoot);
    const localResourceRoots = [this.context.extensionUri, appRoot, vscode.Uri.file("/tmp"), vscode.Uri.file(tmpdir()), vscode.Uri.file(homedir())];
    for (const folder of vscode.workspace.workspaceFolders ?? []) localResourceRoots.push(folder.uri);
    view.webview.options = { enableScripts: true, localResourceRoots };
    view.webview.html = paneHtml(view.webview.cspSource, view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "lucide.ttf")).toString());
    view.webview.onDidReceiveMessage((message: FromPane) => void this.onMessage(message).catch((error) => this.output.appendLine(`pane: ${error instanceof Error ? error.message : String(error)}`)));
  }

  // ── commands from the view title / keybindings ──

  newAgent(): void {
    this.newTab();
    this.paneView = "chat";
    this.pushState();
    this.post({ type: "messages", messages: [] });
    void vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
  }

  async openThread(thread: CodexThread): Promise<void> {
    let tab = this.tabs.find((t) => t.thread?.id === thread.id);
    if (!tab) {
      tab = this.newTab(thread.name, thread);
      const history = await readHistory(thread);
      tab.messages = history.map((m, i) => (m.role === "user" ? { kind: "user", text: m.text, checkpoint: `cp-h-${thread.id}-${i}` } : { kind: "assistant", text: m.text, reasoning: "" }));
    }
    this.activeId = tab.id;
    this.paneView = "chat";
    this.pushState();
    this.post({ type: "messages", messages: tab.messages });
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
  }

  async pickThread(): Promise<void> { await this.showHistory(); }

  async showHistory(): Promise<void> {
    this.paneView = "history";
    this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    const pinned = new Set(this.context.workspaceState.get<string[]>("muster.pinnedThreads", []));
    const threads = await this.visibleThreads();
    const items = threads.map((t) => ({ id: t.id, name: t.name, project: t.project, age: formatAge(t.lastActivityAt), turns: t.turnCount, size: formatSize(t.sizeBytes), live: t.live, pinned: pinned.has(t.id) }));
    items.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    this.post({ type: "threads", items });
  }

  async showBoard(): Promise<void> {
    this.paneView = "board";
    this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    this.pushBoard();
  }

  /** Cursor's keyboard surface for the chat pane (⌘I / ⌘L focus, ⌘T new, ⌘W close, ⌘[ ⌘] cycle, ⌘/ model, ⌘⌥P context). */
  async focus(): Promise<void> { await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`); }
  async closeActive(): Promise<void> { await this.onMessage({ type: "closeTab", id: this.activeId }); }
  async stepTab(delta: number): Promise<void> { const i = this.tabs.findIndex((t) => t.id === this.activeId); const next = this.tabs[(i + delta + this.tabs.length) % this.tabs.length]; if (next) await this.onMessage({ type: "activateTab", id: next.id }); }
  openMenu(kind: "model" | "context" | "access"): void { this.post({ type: "openMenu", kind }); }
  /** Cursor's "Investigate Error in Chat" (⌘⇧D): the diagnostics under the cursor go to the agent with the file range. */
  async fixErrorAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const line = editor.selection.active.line;
    const here = vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.range.start.line <= line && d.range.end.line >= line);
    if (!here.length) { void vscode.window.setStatusBarMessage("No problem on this line", 2000); return; }
    const rel = vscode.workspace.asRelativePath(editor.document.uri); const from = Math.max(1, line - 4); const to = Math.min(editor.document.lineCount, line + 6);
    await this.focus();
    await this.send(`Fix this problem in @${rel}:${from}-${to} (line ${line + 1}):\n${here.map((d) => `- ${d.message}${d.source ? ` (${d.source})` : ""}`).join("\n")}`);
  }
  /** Dictation: text arrives from the configured command and lands in the composer at the caret. */
  dictation(on: boolean, text?: string): void { this.post({ type: "dictation", on, ...(text !== undefined ? { text } : {}) }); }
  onDictate: (() => void) | undefined;

  /** ⌘. opens the mode menu in the composer, as Cursor's composer.openModeMenu does. */
  cycleMode(): void {
    this.post({ type: "openModeMenu" });
    void vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
  }

  /** ⌘K "Quick Question": ask about the selection in the pane, read-only. */
  async askSelection(editor: vscode.TextEditor, question: string): Promise<void> {
    const tab = this.active();
    tab.settings.mode = "chat";
    this.persist(tab);
    this.paneView = "chat";
    this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    const rel = relative(this.cwd(), editor.document.uri.fsPath);
    const sel = editor.selection.isEmpty ? undefined : editor.selection;
    const code = editor.document.getText(sel ? new vscode.Range(sel.start.line, 0, sel.end.line, Number.MAX_SAFE_INTEGER) : undefined);
    await this.send(`${question}\n\nAbout ${rel}${sel ? ` lines ${sel.start.line + 1}-${sel.end.line + 1}` : ""}:\n\`\`\`\n${code.slice(0, 12000)}\n\`\`\``);
  }

  /** Git review (Cursor's Agent Review): review the diff against a branch for issues, read-only. */
  async reviewAgainstBranch(): Promise<void> {
    const branch = await vscode.window.showInputBox({ prompt: "Review changes against branch", value: "main", placeHolder: "main" });
    if (!branch) return;
    const tab = this.active();
    tab.settings.mode = "chat";
    this.persist(tab);
    this.paneView = "chat";
    this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    await this.send(`Review the changes in this repository against the ${branch} branch for issues (bugs, regressions, missing tests, risky changes). Run \`git diff ${branch}\` (and \`git status\`) to see them; report findings with file:line references, most severe first, or say "No issues found".`);
  }

  /** Dev harness: run a real turn through the pane exactly as a user would, and report what happened. */
  async harness(input: { text: string; mode?: string; newTab?: boolean; access?: string; thread?: string; build?: number[]; buildModel?: string }): Promise<Record<string, unknown>> {
    if (input.build) { const t0 = Date.now(); await this.onMessage({ type: "buildPlan", todos: input.build, ...(input.buildModel ? { model: input.buildModel } : {}) }); const tab = this.active(); return { ms: Date.now() - t0, error: tab.lastError ?? null, thread: tab.thread?.id ?? null, review: this.live.review(), assistant: (tab.messages.filter((m) => m.kind === "assistant").pop() as { text?: string } | undefined)?.text?.slice(0, 600) ?? "" }; }
    if (input.thread) { const found = (await this.visibleThreads()).find((t) => t.id === input.thread); if (found) await this.openThread(found); }
    else if (input.newTab) { this.newTab(); this.paneView = "chat"; this.post({ type: "messages", messages: [] }); }
    const tab = this.active();
    if (input.mode) tab.settings.mode = input.mode;
    if (input.access) tab.settings.accessId = input.access;
    this.persist(tab);
    this.pushState();
    const before = tab.messages.length;
    const started = Date.now();
    await this.send(input.text);
    const after = tab.messages.slice(before);
    const assistant = after.filter((m): m is Extract<PaneMessage, { kind: "assistant" }> => m.kind === "assistant").map((m) => m.text).join("\n");
    return {
      ms: Date.now() - started,
      error: tab.lastError ?? null,
      thread: tab.thread?.id ?? null,
      name: tab.name,
      mode: tab.settings.mode,
      debugStage: tab.settings.debugStage ?? null,
      assistant: assistant.slice(0, 600),
      reasoningChars: after.filter((m): m is Extract<PaneMessage, { kind: "assistant" }> => m.kind === "assistant").reduce((n, m) => n + m.reasoning.length, 0),
      tools: after.filter((m) => m.kind === "tool").map((m) => (m as ToolMessage).title + " " + (m as ToolMessage).detail.slice(0, 80)),
      plan: tab.plan ? { title: tab.plan.title, todos: tab.plan.todos.length, path: tab.plan.path ?? null } : null,
      review: this.live.review(),
      tabs: this.tabs.length,
    };
  }

  /** Dev harness: what the pane believes about itself. */
  async debugThreads(): Promise<Record<string, unknown>> {
    const all = await listThreads();
    const visible = await this.visibleThreads();
    return { all: all.length, visible: visible.length, folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), sample: all.slice(0, 5).map((t) => ({ id: t.id.slice(0, 13), cwd: t.cwd, name: t.name, age: formatAge(t.lastActivityAt) })), tabs: this.tabs.map((t) => ({ name: t.name, thread: t.thread?.id ?? null, mode: t.settings.mode, error: t.lastError ?? null })) };
  }

  /** Harness: time the popover data path. */
  async debugSuggest(kind: "file" | "skill", query: string, mode = "all"): Promise<Record<string, unknown>> { const t0 = Date.now(); const data = await this.suggest(kind, query, mode); const items = data.sections.flatMap((sec) => sec.items); return { ms: Date.now() - t0, mode: data.mode, title: data.title, sections: data.sections.map((sec) => `${sec.title || "(untitled)"}: ${sec.items.length}`), count: items.length, items: items.slice(0, 10).map((it) => ({ label: it.label, detail: it.detail, insert: it.insert, nav: it.nav, action: it.action, icon: it.icon })) }; }

  /** Harness: send without waiting (so a second send can steer the running turn), stop, edit-and-resend. */
  debugSend(text: string): void { void this.onMessage({ type: "send", text }); }
  debugStop(): void { this.stop(); }
  debugEdit(checkpoint: string, text: string): void { void this.editMessage(checkpoint, text); }

  /** Harness: type into the composer; the webview reports the rendered menu rows, chips and marks (debugState().probe). */
  debugInput(text: string): void { this.lastProbe = null; this.post({ type: "setInput", text }); }

  debugState(): Record<string, unknown> {
    const active = this.active();
    return { probe: this.lastProbe, approvals: [...this.pending.keys()], running: active.running, queue: active.queue ?? [], messages: active.messages.map((m) => m.kind + ((m as { steer?: boolean }).steer ? "*" : "")), checkpoints: [...active.checkpoints.keys()], lastAssistant: [...active.messages].reverse().find((m) => m.kind === "assistant")?.text.slice(0, 160) ?? null, lastError: active.lastError ?? null, run: active.run ?? null, agentGraph: active.agentGraph ?? null, activityTimeline: active.activityTimeline?.length ?? 0, usageLedger: active.usageLedger ?? [], contextReferences: active.contextReferences ?? [], resolved: !!this.view, visible: this.view?.visible ?? null, ready: this.readyCount, models: this.models.length, access: this.access.length, loading: this.loading, tabs: this.tabs.length, view: this.paneView, activeMode: this.active().settings.mode };
  }

  /** Review a commit (Bugbot on commit): a read-only Ask turn over `git show <sha>` in the pane. */
  async reviewCommit(sha: string): Promise<void> {
    const tab = this.newTab(`Review ${sha.slice(0, 7)}`);
    tab.settings.mode = "chat";
    this.persist(tab);
    this.paneView = "chat";
    this.pushState();
    this.post({ type: "messages", messages: [] });
    await this.send(`Review commit ${sha} for issues (bugs, regressions, missing tests, risky changes). Run \`git show ${sha}\` to see it; report findings with file:line references, most severe first, or say "No issues found".`);
  }

  /** Codex plugins and MCP servers loaded for this folder — the same config the Codex app uses, nothing to migrate. */
  async showPlugins(): Promise<void> {
    const { listPlugins } = await import("./codex.js");
    const items = await listPlugins(this.cwd());
    if (!items.length) { void vscode.window.showInformationMessage("Codex reports no plugins or MCP servers for this folder."); return; }
    await vscode.window.showQuickPick(items.map((p) => ({ label: `$(${p.kind === "mcp" ? "server" : "extensions"}) ${p.name}`, description: p.kind === "mcp" ? "MCP server" : "plugin", detail: p.detail })), { placeHolder: "Codex plugins and MCP servers active in this folder", matchOnDetail: true });
  }

  /** A file reference in an answer (path, path:line, Codex citation) opens the file at that line. */
  private async openPath(path: string, line?: number, endLine?: number): Promise<void> {
    const cwd = this.cwd(); const raw = path.replace(/^["'\u3010]|["'\u3011]$/g, "");
    let abs = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw.startsWith("/") ? raw : join(cwd, raw);
    if (!existsSync(abs)) { const hit = (await vscode.workspace.findFiles(`**/${raw.split("/").pop()}`, "**/{node_modules,.git,dist,build,out}/**", 1))[0]; if (!hit) { void vscode.window.showInformationMessage(`Not found: ${raw}`); return; } abs = hit.fsPath; }
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true, viewColumn: vscode.ViewColumn.One });
    if (line) { const a = new vscode.Position(Math.max(0, line - 1), 0); const b = new vscode.Position(Math.max(0, (endLine ?? line) - 1), 0); editor.selection = new vscode.Selection(a, b.line > a.line ? editor.document.lineAt(b.line).range.end : a); editor.revealRange(new vscode.Range(a, b), vscode.TextEditorRevealType.InCenter); }
  }

  // ── approvals as chat cards ──
  private readonly pending = new Map<string, { resolve: (decision: string) => void; kind: ApprovalCard["kind"]; tabId: string; card: ApprovalCard; childThreadId?: string }>();
  private decide(id: string, decision: string): void {
    const p = this.pending.get(id); if (!p) return;
    this.pending.delete(id); p.resolve(decision);
    const tab = this.tabs.find((candidate) => candidate.id === p.tabId);
    if (!p.childThreadId && tab?.run?.state === "waiting") { tab.run = { ...tab.run, state: "running" }; this.saveChats(); }
    this.post({ type: "approvalDone", id, decision }, p.tabId);
  }
  /** Ask in the chat and wait for the click or the key (⏎ accept, ⇧⏎ accept for session, Esc decline). */
  private askInChat(card: ApprovalCard, tab: Tab = this.active(), childThreadId?: string): Promise<string> {
    // Provider item ids are only unique within a process. Namespace collisions
    // across pane tabs so one approval can never resolve another tab's request.
    const originalId = card.id;
    let id = originalId;
    while (this.pending.has(id)) id = `${originalId}-${tab.id.slice(-8)}`;
    const queued = id === originalId ? card : { ...card, id };
    return new Promise((resolve) => { this.pending.set(id, { resolve, kind: queued.kind, tabId: tab.id, card: queued, ...(childThreadId ? { childThreadId } : {}) }); if (tab.run && !childThreadId) { tab.run = { ...tab.run, state: "waiting" }; this.saveChats(); } this.post({ type: "approval", approval: queued }, tab.id); void vscode.commands.executeCommand(`${AgentPane.viewId}.focus`); });
  }
  /** A turn that ends (stopped, failed) must not leave a question hanging. */
  private settlePending(decision = "decline", tabId?: string, includeChild = false): void { for (const [id, p] of this.pending) if ((!tabId || p.tabId === tabId) && (includeChild || !p.childThreadId)) this.decide(id, decision); }
  debugDecide(id: string, decision: string): void { this.decide(id, decision); }
  /** Harness: raise the same server request the provider would (approval / elicitation) and return the answer. */
  debugRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> { return this.approve(method, params); }

  /** The file in the active editor, relative to the workspace (Cursor's dashed "current file" pill). */
  private currentFile(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri; if (!uri || uri.scheme !== "file") return undefined;
    const rel = vscode.workspace.asRelativePath(uri); return rel.startsWith("..") || rel === uri.fsPath ? undefined : rel;
  }

  stop(): void {
    const tab = this.active();
    if (tab.running || tab.inlineRunning) {
      if (tab.run) { tab.run = { ...tab.run, state: "interrupted", endedAt: Date.now(), error: "Interrupted by user." }; this.recordActivity(tab, "muster/run/interrupted", { runId: tab.run.id }); this.saveChats(); }
      void interruptTurn(tab.id).then((ok) => this.output.appendLine(`stop: ${ok ? "interrupted" : "nothing to interrupt"}`));
    }
  }

  /** Revert the workspace to the state before the user message at `at` (every later turn's checkpoint, newest first). */
  private async revertTo(tab: Tab, at: number): Promise<{ changed: number; inverse: Checkpoint }> {
    const inverse: Checkpoint = new Map(); let changed = 0;
    const ids = tab.messages.slice(at).filter((m): m is Extract<PaneMessage, { kind: "user" }> => m.kind === "user" && !!m.checkpoint).map((m) => m.checkpoint!).reverse();
    for (const id of ids) {
      const checkpoint = tab.checkpoints.get(id); if (!checkpoint) continue;
      const r = await this.runtimeFor(tab).restore(checkpoint); changed += r.changed;
      for (const [path, state] of r.inverse) if (!inverse.has(path)) inverse.set(path, state);
    }
    return { changed, inverse };
  }

  /** Make the provider forget the turn at `at` and everything after it: `thread/revert` (paginated threads) or `thread/rollback` (legacy). */
  private revertRecord(tab: Tab, at: number): { turnId?: string; turns: number } {
    const first = tab.messages[at]; const turns = tab.messages.slice(at).filter((m) => m.kind === "user" && !m.steer).length;
    return { ...(first?.kind === "user" && first.turnId ? { turnId: first.turnId } : {}), turns };
  }
  private async forgetTurns(tab: Tab, rec: { turnId?: string; turns: number }): Promise<void> {
    if (!tab.thread || !rec.turns) return;
    let ok = false; let how = "";
    if (rec.turnId) { ok = await revertThread(tab.id, tab.thread.id, rec.turnId, this.cwd()); how = `revert before ${rec.turnId.slice(0, 8)}`; }
    if (!ok) { ok = await rollbackThread(tab.id, tab.thread.id, rec.turns, this.cwd()); how += `${how ? ", then " : ""}rollback ${rec.turns}`; }
    this.output.appendLine(`thread history: ${how} → ${ok}${ok ? "" : ` (${lastRollbackError})`}`);
  }
  private forgetTurnsFrom(tab: Tab, at: number): Promise<void> { return this.forgetTurns(tab, this.revertRecord(tab, at)); }

  /** Cursor: edit a sent message → the workspace goes back to that point, the thread forgets the later turns, the text is resent. */
  private async editMessage(checkpointId: string, text: string): Promise<void> {
    const tab = this.active();
    const at = tab.messages.findIndex((m) => m.kind === "user" && m.checkpoint === checkpointId);
    if (at < 0) return;
    if (tab.running) { await interruptTurn(tab.id); await new Promise((r) => setTimeout(r, 300)); }
    const { changed } = await this.revertTo(tab, at);
    await this.forgetTurnsFrom(tab, at);
    tab.messages = tab.messages.slice(0, at); delete tab.redo; tab.queue = [];
    this.post({ type: "messages", messages: tab.messages }); this.pushState();
    void vscode.window.setStatusBarMessage(`Checkpoint restored · ${changed} file(s)`, 3000);
    if (text.trim()) await this.send(text); else this.post({ type: "insert", text: (tab.messages[at] as { text?: string } | undefined)?.text ?? "" });
  }

  // ── state ──

  /** Privacy: only this folder's threads exist as far as the pane is concerned. */
  private async visibleThreads(): Promise<CodexThread[]> {
    return threadsForWorkspace(await listThreads(), (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  }

  /** Plan editor toolbar: choose the model that will build (mirrors Cursor's "Model used to build this plan"). */
  async pickBuildModel(): Promise<string | undefined> {
    const tab = this.active();
    const pick = await vscode.window.showQuickPick(this.models.map((m) => ({ label: m.name, description: m.providerId ? providerLabel(m.providerId) : "Claude Code", detail: m.description, picked: m.id === tab.settings.modelId, id: m.id })), { placeHolder: "Model used to build this plan" });
    if (!pick) return undefined;
    if (!this.selectModel(tab, pick.id)) return undefined;
    const model = this.models.find((m) => m.id === pick.id);
    if (model && !model.efforts.some((e) => e.id === tab.settings.effortId)) tab.settings.effortId = model.defaultEffort;
    this.persist(tab);
    this.pushState();
    return pick.id;
  }

  /** "Build" from the plan editor: implement that plan (all, or the chosen to-dos) with the chosen model, here or in a new thread. */
  async buildFromFile(uri: vscode.Uri, options: { todos?: number[]; model?: string; newThread?: boolean } = {}): Promise<void> {
    const rel = relative(this.cwd(), uri.fsPath);
    const card = parsePlan(existsSync(uri.fsPath) ? readFileSync(uri.fsPath, "utf8") : "");
    const chosen = (options.todos ?? []).filter((i) => i >= 0 && i < card.todos.length);
    const scope = chosen.length && chosen.length < card.todos.length ? `Implement ONLY these to-dos from the plan (leave the others untouched):\n${chosen.map((i) => `- ${card.todos[i]!.text}`).join("\n")}` : "Work through the to-dos in order and keep them updated.";
    const tab = options.newThread ? this.newTab(`Build: ${card.title}`.slice(0, 40)) : this.active();
    if (options.newThread) { this.post({ type: "messages", messages: [] }); }
    tab.plan = { ...card, path: uri.fsPath };
    tab.settings.mode = "agent";
    if (options.model && !this.selectModel(tab, options.model)) return;
    this.persist(tab);
    this.paneView = "chat";
    this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    await this.send(`${options.newThread ? `@${rel} ` : ""}Implement the plan in ${rel}. ${scope}`);
  }

  /** What the plan editor needs from the pane. */
  catalog(): { models: { id: string; name: string; provider: string }[]; model: string | undefined } {
    return { models: this.models.map((m) => ({ id: m.id, name: m.providerId ? `${providerLabel(m.providerId)} · ${m.name}` : m.name, provider: m.providerId ?? m.provider })), model: this.active().settings.modelId };
  }

  /** ⌘K: edit the selection (or the whole file) in place; the result streams in as the inline diff. */
  async inlineEdit(editor: vscode.TextEditor, instruction: string): Promise<void> {
    const tab = this.active();
    const selectedModel = this.models.find(m => m.id === tab.settings.modelId);
    if (!selectedModel) { void vscode.window.showWarningMessage("Select an available provider and model before editing."); return; }
    if (selectedModel.provider !== "claude") validateSelection(tab.settings, tab.thread?.providerId);
    const cwd = this.cwd();
    const runtime = this.runtimeFor(tab);
    if (this.editOwner && (this.editOwner.running || this.editOwner.inlineRunning) && !this.runtimeCanStart(tab).ok) { void vscode.window.showInformationMessage("An agent is editing this workspace. Let it finish before starting an inline edit."); return; }
    const runtimeTurnId = `inline-${cryptoId()}`;
    const started = this.taskRuntimes.beginTurn(tab.id, runtimeTurnId);
    if (!started.ok) { void vscode.window.showInformationMessage(started.reason ?? "This task cannot start while its workspace is busy."); return; }
    const rel = relative(cwd, editor.document.uri.fsPath);
    const selection = editor.selection.isEmpty ? undefined : editor.selection;
    const start = selection ? selection.start.line + 1 : 1;
    const end = selection ? selection.end.line + 1 : editor.document.lineCount;
    const code = editor.document.getText(selection ? new vscode.Range(selection.start.line, 0, selection.end.line, Number.MAX_SAFE_INTEGER) : undefined);
    const prompt = `Edit ${rel}${selection ? ` lines ${start}-${end} only` : ""} as instructed. Change nothing else, do not explain, apply the change with apply_patch.\n\nInstruction: ${instruction}\n\nCurrent code:\n\`\`\`\n${code}\n\`\`\``;
    const model = this.models.find((m) => m.id === tab.settings.modelId);
    const access = this.access.find((a) => a.id === tab.settings.accessId);
    const status = vscode.window.setStatusBarMessage("$(sync~spin) Generating edit…");
    runtime.setReviewMode(isUnattendedAccess(access) ? "auto" : "review");
    this.editOwner = tab;
    tab.inlineRunning = true;
    runtime.beginCheckpoint();
    let inlineStatus: "completed" | "failed" = "completed";
    try {
      const result = await (selectedModel.provider === "claude" ? runClaudeTurn({ prompt, cwd, model: selectedModel.id.replace(/^claude:/, ""), effort: tab.settings.effortId, handlers: { onDelta: () => {}, onReasoning: () => {} } }) : runTurn({ prompt, cwd, model: selectedModel.id, ...(tab.settings.providerId ? { providerId: tab.settings.providerId } : {}), reasoning: tab.settings.effortId as "low" | "medium" | "high" | "xhigh" | "max" | "ultra", ...(access ? { access } : {}), rules: readRules(cwd), handlers: { onDelta: () => {}, onReasoning: () => {}, onEvent: (m, p) => { this.taskRuntimes.routeEvent({ taskId: tab.id, workspaceId: this.runtimeIdentity(tab).workspaceId, method: m, params: p, ...(typeof p.threadId === "string" ? { threadId: p.threadId } : {}), ...(typeof p.eventId === "string" ? { eventId: p.eventId } : {}), ...(typeof p.turnId === "string" ? { turnId: p.turnId } : {}) }); }, onRequest: (m, p) => this.approve(m, p, tab) } }));
      if (result.status === "failed") { inlineStatus = "failed"; void vscode.window.showWarningMessage(result.errorMessage ?? "The edit failed."); }
    } finally {
      status.dispose();
      tab.inlineRunning = false;
      this.taskRuntimes.finishTurn(tab.id, this.taskRuntimes.get(tab.id)?.activeTurnId ?? runtimeTurnId, inlineStatus);
      tab.checkpoints.set(`inline-${runtimeTurnId}`, runtime.takeCheckpoint());
      this.drainQueued(tab);
    }
  }

  private selectModel(tab: Tab, id: string): boolean {
    const model = this.models.find(candidate => candidate.id === id);
    if (!model) { void vscode.window.showWarningMessage("Selected model is unavailable."); return false; }
    try {
      assertSelectionChange(tab.settings, { modelId: id, ...(model.providerId ? { providerId: model.providerId } : {}) }, this.editLeaseActive(tab) || !!tab.queue?.length, !!tab.thread || !!tab.claudeSession);
      if (model.provider !== "claude") validateSelection({ modelId: id }, tab.thread?.providerId);
      tab.settings = { ...tab.settings, modelId: id };
      delete tab.settings.providerId;
      if (model.providerId) tab.settings.providerId = model.providerId;
      if (!model.efforts.some(e => e.id === tab.settings.effortId)) tab.settings.effortId = model.defaultEffort;
      this.persist(tab); return true;
    } catch (error) { void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error)); return false; }
  }

  private newTab(name = "New Agent", thread?: CodexThread): Tab {
    const id = thread?.id ?? `new-${cryptoId()}`;
    const saved = this.context.workspaceState.get<Record<string, ThreadSettings>>("muster.threadSettings", {})[id];
    const tab: Tab = { id, name, ...(thread ? { thread } : {}), messages: [], settings: saved ? migrateProviderSelection(saved) : this.defaultSettings(), running: false, checkpoints: new Map() };
    if (!saved && thread) tab.settings = migrateProviderSelection({ ...tab.settings, modelId: thread.model ?? (thread.providerId === "hybrow" ? "codex/gpt-5.6-terra" : thread.providerId === "openai-direct" ? "gpt-5.6-terra" : ""), ...(thread.providerId ? { providerId: thread.providerId } : {}) });
    this.tabs.push(tab);
    this.activeId = id;
    return tab;
  }

  private active(): Tab {
    return this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[0] ?? this.newTab();
  }

  private defaultSettings(): ThreadSettings {
    const config = vscode.workspace.getConfiguration("muster");
    const model = this.models.find((m) => m.id === config.get<string>("codex.model")) ?? this.models.find((m) => m.isDefault) ?? this.models[0];
    return { mode: "agent", accessId: this.access.find((a) => a.id === ":workspace")?.id ?? this.access[0]?.id ?? ":workspace", modelId: migrateProviderSelection({ modelId: config.get<string>("codex.model") || model?.id || "gpt-5.6-terra" }).modelId, effortId: config.get<string>("codex.effort") ?? model?.defaultEffort ?? "medium" };
  }

  private persist(tab: Tab): void {
    tab.settings = migrateProviderSelection(tab.settings);
    if (tab.settings.providerId) bindConversationProvider(tab.id, tab.settings.providerId);
    const all = { ...this.context.workspaceState.get<Record<string, ThreadSettings>>("muster.threadSettings", {}), [tab.id]: tab.settings, ...(tab.thread ? { [tab.thread.id]: tab.settings } : {}) };
    void this.context.workspaceState.update("muster.threadSettings", all);
  }

  private modes(): ModeInfo[] {
    const custom = vscode.workspace.getConfiguration("muster").get<Partial<ModeInfo>[]>("modes", []);
    // Every behaviour flag a built-in mode can have is available to a custom one (settings → Modes); they behave, not just look, the same.
    return [...BUILTIN_MODES, ...custom.filter((m) => m.id && m.name).map((m) => {
      const mode: Record<string, unknown> = { id: m.id!, name: m.name!, icon: m.icon ?? "◆", placeholder: m.placeholder ?? "Plan, search, build anything" };
      for (const k of ["description", "prompt", "effort"] as const) if (typeof m[k] === "string" && m[k]) mode[k] = m[k];
      for (const k of ["readOnly", "plan", "board", "autoFix", "debug", "parallel", "spec"] as const) if (m[k]) mode[k] = true;
      return mode as unknown as ModeInfo;
    })];
  }

  private async loadCatalog(): Promise<void> {
    if (this.catalogLoaded) return;
    this.catalogLoaded = true;
    const cwd = this.cwd();
    const claude = vscode.workspace.getConfiguration("muster").get<string[]>("claude.models", []);
    const [models, access] = await Promise.all([listModels(cwd, claude), listAccessModes(cwd).catch(() => [] as AccessMode[])]);
    this.models = models;
    this.access = access;
    this.loading = false;
    this.catalogChanged.fire();
    for (const tab of this.tabs) {
      tab.settings = migrateProviderSelection(tab.settings);
      if (tab.running || tab.inlineRunning) continue;
      if (!this.access.some((a) => a.id === tab.settings.accessId)) tab.settings.accessId = this.defaultSettings().accessId;
      const model = this.models.find((m) => m.id === tab.settings.modelId);
      if (model && !model.efforts.some((e) => e.id === tab.settings.effortId)) tab.settings.effortId = model.defaultEffort;
    }
    this.pushState();
  }

  private cwd(): string {
    return this.active().thread?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Resolve the task's provider cwd before any turn or file event is routed. */
  private runtimeIdentity(tab: Tab): TaskRuntimeIdentity {
    const cwd = tab.thread?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return { taskId: tab.id, workspaceId: cwd, cwd, ...(tab.thread?.id ? { threadId: tab.thread.id } : {}) };
  }

  /**
   * Keep a controller per task. Isolation is deliberately false until the
   * host has validated a real worktree and passes that proof; provider child
   * IDs and labels alone never enable parallel writes.
   */
  private runtimeFor(tab: Tab): LiveEditController {
    const identity = this.runtimeIdentity(tab);
    const known = this.taskRuntimes.get(tab.id);
    if (known && (known.cwd !== identity.cwd || known.workspaceId !== identity.workspaceId)) {
      this.taskRuntimes.unregister(tab.id);
      this.runtimeControllers.delete(tab.id);
    }
    else if (known && known.threadId !== identity.threadId) this.taskRuntimes.bindThread(tab.id, identity.threadId);
    let controller = this.runtimeControllers.get(tab.id);
    if (!controller) {
      const sourceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      controller = sourceRoot && resolvePath(sourceRoot) === resolvePath(identity.cwd) ? this.live : new LiveEditController(() => identity.cwd, (line) => this.output.appendLine(line));
      this.runtimeControllers.set(tab.id, controller);
      this.taskRuntimes.register(identity, controller, { isolated: false });
      if (controller !== this.live) {
        controller.onCard((card) => {
          const owner = this.tabs.find((candidate) => candidate.id === tab.id) ?? tab;
          (owner.edits ??= []);
          const index = owner.edits.findIndex((edit) => edit.path === card.path);
          if (index < 0) owner.edits.push(card); else owner.edits[index] = card;
          this.post({ type: "edit", card }, owner.id);
        });
        controller.onChange(() => this.post({ type: "review", files: controller!.review() }, tab.id));
      }
    }
    return controller;
  }

  private runtimeCanStart(tab: Tab): { readonly ok: boolean; readonly reason?: string } { this.runtimeFor(tab); return this.taskRuntimes.canStart(tab.id); }

  private post(message: ToPane, tabId?: string): void {
    if (tabId && tabId !== this.activeId) return;
    if (message.type === "messages") message = { ...message, edits: this.active().edits ?? [] };
    void this.view?.webview.postMessage(message);
    if (message.type === "messages") for (const p of this.pending.values()) if (p.tabId === this.activeId) void this.view?.webview.postMessage({ type: "approval", approval: p.card });
  }

  /** ⌘L: the selection (or file) becomes a mention in the composer, Cursor's "Add to Chat". */
  async addSelection(editor: vscode.TextEditor): Promise<void> {
    const rel = relative(this.cwd(), editor.document.uri.fsPath);
    const sel = editor.selection;
    const mention = sel.isEmpty ? `@${rel}` : `@${rel}:${sel.start.line + 1}-${sel.end.line + 1}`;
    this.paneView = "chat";
    this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    this.post({ type: "insert", text: `${mention} ` });
  }

  /** ⇧⌘B: a browser tab in this pane (Cursor's browser lives in the side pane). */
  openBrowserTab(url?: string): void {
    if (!this.browser) return;
    const state = this.browser.open(url);
    const tab: Tab = { id: `browser-${state.id}`, name: url ? url.replace(/^https?:\/\//, "").slice(0, 30) : "Browser", kind: "browser", browserId: state.id, messages: [], settings: this.defaultSettings(), running: false, checkpoints: new Map() };
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.paneView = "browser";
    this.pushState();
    this.post({ type: "browser", state });
    void vscode.commands.executeCommand("setContext", "muster.browserActive", true);
    void vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
  }

  activeBrowserId(): string | undefined { const tab = this.active(); return tab.kind === "browser" ? tab.browserId : undefined; }

  /** Stable ownership metadata for agent-owned terminal sessions. */
  terminalContext(): { taskId: string; taskLabel: string; cwd: string } {
    const tab = this.active();
    return { taskId: tab.id, taskLabel: tab.name, cwd: tab.thread?.cwd ?? this.cwd() };
  }

  /** Return the warm pane conversation that owns a provider thread or observed child. */
  conversationForThread(threadId: string): string | undefined {
    for (const tab of this.tabs) if (tab.thread?.id === threadId || tab.agentGraph?.nodes.some((node) => node.threadId === threadId)) return tab.id;
    return undefined;
  }

  /** Hydrate a real chat tab from a non-resuming catalog read; sending is the only dispatch path. */
  async openCatalogThread(record: ThreadRecord, read: ThreadRead, _mode: "open" | "continue"): Promise<void> {
    const nativeProvider = read.thread.modelProvider ?? record.raw.modelProvider;
    const providerId = nativeProvider === "hybrow" ? "hybrow" : nativeProvider === "openai" ? "openai-direct" : undefined;
    const thread = { ...catalogThread(record), ...(providerId ? { providerId: providerId as ProviderId } : {}), ...(typeof read.thread.model === "string" ? { model: read.thread.model } : {}) };
    let tab = this.tabs.find((candidate) => candidate.thread?.id === record.id);
    if (!tab) tab = this.newTab(record.name, thread);
    else { tab.thread = thread; tab.name = record.name; }
    if (!tab.messages.length) tab.messages = hydrateCatalogTurns((read.thread as { turns?: unknown }).turns);
    tab.agentGraph = replayCatalogGraph(record.id, (read.thread as { turns?: unknown }).turns);
    delete tab.lastError;
    this.activeId = tab.id; this.lastChatId = tab.id; this.paneView = "chat"; this.pushState();
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`); this.post({ type: "messages", messages: tab.messages });
  }

  private bookmarks(): { title: string; url: string }[] { return this.context.workspaceState.get<{ title: string; url: string }[]>("muster.browser.bookmarks", []); }
  private toggleBookmark(id: string): void {
    const st = this.browser?.get(id); if (!st?.url) return;
    const list = this.bookmarks(); const next = list.some((b) => b.url === st.url) ? list.filter((b) => b.url !== st.url) : [...list, { title: (st.title || st.url).slice(0, 40), url: st.url }];
    void this.context.workspaceState.update("muster.browser.bookmarks", next);
    this.post({ type: "browserExtras", bookmarks: next, cert: st.cert ?? null });
  }
  browserChanged(state: BrowserState): void {
    const tab = this.tabs.find((t) => t.browserId === state.id);
    if (!tab) return;
    tab.name = (state.title || state.url.replace(/^https?:\/\//, "") || "Browser").slice(0, 30);
    this.post({ type: "browser", state });
    this.post({ type: "browserExtras", bookmarks: this.bookmarks(), cert: state.cert ?? null });
    if (tab.id === this.activeId) this.pushState();
  }

  /** Switch to the last chat tab and put text in its composer (visual-editor changes, picks). */
  private async toChat(text: string): Promise<void> {
    const chat = this.tabs.find((t) => t.kind !== "browser" && t.id === this.lastChatId) ?? this.tabs.find((t) => t.kind !== "browser") ?? this.newTab();
    this.activeId = chat.id; this.paneView = "chat"; this.pushState();
    this.post({ type: "messages", messages: chat.messages });
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    this.post({ type: "insert", text });
  }

  /** Visual editor: a picked element or screenshot from the browser becomes context in the composer. */
  async addBrowserPick(pick: BrowserPick): Promise<void> {
    rememberPick(pick);
    const chat = this.tabs.find((t) => t.kind !== "browser" && t.id === this.lastChatId) ?? this.tabs.find((t) => t.kind !== "browser") ?? this.newTab();
    this.activeId = chat.id;
    this.paneView = "chat";
    this.pushState();
    this.post({ type: "messages", messages: chat.messages });
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    const parts = [saveBrowserPick(this.cwd(), pick)];
    if (pick.imagePath) parts.push(`@image:${encodeURI(pick.imagePath)}`);
    this.post({ type: "insert", text: `${parts.join(" ")} ` });
    if (pick.picked) void vscode.window.setStatusBarMessage(`Selected <${pick.picked.tag}> ${pick.picked.selector.slice(0, 60)}`, 4000);
  }

  activateTab(id: string): void { void this.onMessage({ type: "activateTab", id }); }
  closeTab(id: string): void { void this.onMessage({ type: "closeTab", id }); }

  private pushState(): void {
    const tab = this.active();
    // Cursor: the tab strip is the pane header. The workbench renders it in the sidebar's title row.
    void vscode.commands.executeCommand("muster.agentHeader.set", { tabs: this.tabs.map((t) => ({ id: t.id, name: t.name, running: t.running, kind: t.kind ?? "chat" })), activeId: tab.id });
    const modes = this.modes().map((m) => (m.debug ? { ...m, placeholder: DEBUG_STAGES[tab.settings.debugStage ?? 0]!.placeholder } : m));
    this.saveChats();
    const ui = vscode.workspace.getConfiguration("muster.ui");
    this.post({ type: "state", appearance: { density: ui.get("density", "comfortable"), fontSize: ui.get("fontSize", 13), accent: ui.get("accent", ""), glass: ui.get("glass", true) }, draft: tab.draft ?? cleanDraft(null), ...(tab.usage ? { usage: tab.usage } : {}), ...(tab.usageLedger?.length ? { usageLedger: tab.usageLedger } : {}), ...(tab.activity ? { activity: tab.activity } : {}), ...(tab.activityTimeline?.length ? { activityTimeline: tab.activityTimeline } : {}), ...(tab.contextReferences?.length ? { contextReferences: tab.contextReferences } : {}), ...(tab.agentGraph ? { agentWorkspace: tab.agentGraph } : {}), taskWorkspace: this.taskWorkspaceSnapshot(), ...(tab.run ? { run: tab.run, runState: tab.run.state } : {}), ...(tab.startedAt ? { startedAt: tab.startedAt } : {}), reviewMode: this.runtimeFor(tab).reviewMode, ...(tab.promptEstimate !== undefined ? { promptEstimate: tab.promptEstimate } : {}), queue: this.active().queue ?? [], ...(this.currentFile() ? { currentFile: this.currentFile() } : {}), tabs: this.tabs.map((t) => ({ id: t.id, name: t.name, running: t.running, ...(t.kind ? { kind: t.kind } : {}) })), activeId: tab.id, view: this.paneView, modes, access: this.access, models: this.models, settings: tab.settings, loading: this.loading, canRedo: !!tab.redo });
  }

  private taskWorkspaceSnapshot(): { version: 1; activeTaskId: string; tasks: readonly (TaskRuntimeIdentity & { name: string; status: string; capability: "isolated-worktree" | "shared-checkout-serialized"; activeTurnId?: string })[] } {
    const tasks = this.tabs.filter((candidate) => candidate.kind !== "browser").map((candidate) => {
      this.runtimeFor(candidate);
      const runtime = this.taskRuntimes.get(candidate.id)!;
      return { taskId: runtime.taskId, workspaceId: runtime.workspaceId, cwd: runtime.cwd, ...(runtime.threadId ? { threadId: runtime.threadId } : {}), name: candidate.name, status: runtime.status, capability: runtime.capability, ...(runtime.activeTurnId ? { activeTurnId: runtime.activeTurnId } : {}) };
    });
    return { version: 1, activeTaskId: this.activeId, tasks };
  }

  private pushBoard(): void {
    const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []);
    const running = new Set(this.tabs.filter((t) => t.running).map((t) => t.thread?.id ?? t.id));
    const column = (id: BoardTask["column"], title: string) => ({ id, title, cards: tasks.filter((t) => t.column === id).map((t) => ({ id: t.id, title: t.title, subtitle: t.threadId ? "thread" : "not started", running: !!t.threadId && running.has(t.threadId) })) });
    this.post({ type: "board", columns: [column("backlog", "Backlog"), column("progress", "In progress"), column("review", "Review"), column("done", "Done")] });
  }

  // ── messages from the webview ──

  private resolveImagePath(raw: string): string | undefined {
    const cwd = this.cwd();
    let s = String(raw || "").trim().replace(/^["']|["']$/g, "");
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    if (/^file:\/\//i.test(s)) { try { s = vscode.Uri.parse(s).fsPath; } catch { return undefined; } }
    const candidates = [
      s,
      s.startsWith("~/") ? join(homedir(), s.slice(2)) : s,
      s.startsWith("/") ? s : join(cwd, s),
      join(cwd, String(raw || "").trim().replace(/^["']|["']$/g, "")),
    ];
    for (const abs of candidates) { if (abs && existsSync(abs)) return abs; }
    return undefined;
  }

  private async onMessage(message: FromPane): Promise<void> {
    switch (message.type) {
      case "boot": this.output.appendLine("pane webview booted"); return;
      case "clientError": this.output.appendLine(`pane webview error: ${message.message}`); return;
      case "draft": { const tab = this.tabs.find(t => t.id === message.id); if (tab) { const draft = cleanDraft(message.draft); const same = tab.draft?.text === draft.text && JSON.stringify(tab.draft?.context ?? []) === JSON.stringify(draft.context); if (!same) { tab.draft = draft; this.saveChats(); } } return; }
      case "ready": this.readyCount++; await this.restoreHistories(); this.pushState(); this.post({ type: "messages", messages: this.active().messages }); void this.loadCatalog(); return;
      case "stop": this.stop(); return;
      case "decide": this.decide(message.id, message.decision); return;
      case "openPath": await this.openPath(message.path, message.line, message.endLine); return;
      case "resolveImage": {
        const abs = this.resolveImagePath(message.src);
        if (!this.view || !abs) return;
        const uri = this.view.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
        this.post({ type: "imageResolved", src: message.src, uri });
        return;
      }
      case "insertBlock": { const editor = vscode.window.activeTextEditor; if (!editor) { void vscode.window.showInformationMessage("Open a file to insert into."); return; } await editor.edit((b) => b.insert(editor.selection.active, message.code)); return; }
      case "applyBlock": await this.send(`Apply this ${message.lang ?? ""} code block to ${message.path} exactly as written, keeping the rest of the file as is:\n\n\`\`\`${message.lang ?? ""}\n${message.code}\n\`\`\``); return;
      case "dropQueued": { const tab = this.active(); this.taskRuntimes.cancelQueuedAt(tab.id, message.index); tab.queue?.splice(message.index, 1); tab.queueWaiters?.splice(message.index, 1)[0]?.(); this.pushState(); return; }
      case "editMessage": await this.editMessage(message.checkpoint, message.text); return;
      case "acceptAll": await this.runtimeFor(this.active()).acceptAll(); return;
      case "rejectAll": await this.runtimeFor(this.active()).rejectAll(); return;
      case "open": await this.runtimeFor(this.active()).open(message.path, message.ifClosed === true); return;
      case "openReview": await this.runtimeFor(this.active()).openReview(); return;
      case "command": await vscode.commands.executeCommand(message.id); return;
      case "newAgent": this.newAgent(); return;
      case "activateTab": { const tab = this.tabs.find((t) => t.id === message.id); if (tab) { this.activeId = tab.id; if (tab.kind === "browser") { this.paneView = "browser"; this.pushState(); const st = tab.browserId ? this.browser?.get(tab.browserId) : undefined; if (st) this.post({ type: "browser", state: st }); } else { this.lastChatId = tab.id; this.paneView = "chat"; this.pushState(); this.post({ type: "messages", messages: tab.messages }); } void vscode.commands.executeCommand("setContext", "muster.browserActive", tab.kind === "browser"); } return; }
      case "closeTab": { const closing = this.tabs.find((t) => t.id === message.id); if (closing && !this.canCloseTab(closing)) return; if (closing) { this.settlePending("decline", closing.id, true); this.taskRuntimes.cancel(closing.id); cancelQueuedMessages(closing.queue ??= [], closing.queueWaiters ??= []); if (closing.running || closing.inlineRunning) await interruptTurn(closing.id); this.taskRuntimes.unregister(closing.id); this.runtimeControllers.delete(closing.id); } if (closing?.kind === "browser" && closing.browserId) this.browser?.close(closing.browserId); this.tabs = this.tabs.filter((t) => t.id !== message.id); if (!this.tabs.length) this.newTab(); if (!this.tabs.some((t) => t.id === this.activeId)) this.activeId = this.tabs[this.tabs.length - 1]!.id; const now = this.active(); this.paneView = now.kind === "browser" ? "browser" : "chat"; this.pushState(); if (now.kind === "browser" && now.browserId) { const st = this.browser?.get(now.browserId); if (st) this.post({ type: "browser", state: st }); } else this.post({ type: "messages", messages: now.messages }); void vscode.commands.executeCommand("setContext", "muster.browserActive", now.kind === "browser"); return; }
      case "openThread": { const thread = (await this.visibleThreads()).find((t) => t.id === message.id); if (thread) await this.openThread(thread); else void vscode.window.showWarningMessage("That thread belongs to another folder."); return; }
      case "suggest": { const data = await this.suggest(message.kind, message.query, message.mode ?? "all"); this.post({ type: "suggestions", kind: message.kind, ...(message.seq !== undefined ? { seq: message.seq } : {}), mode: data.mode, title: data.title, sections: data.sections }); return; }
      case "slashAction": await this.slashAction(message.id); return;
      case "agentAction": await this.agentAction(message); return;
      case "probed": this.lastProbe = { seq: message.seq, query: message.query, mode: message.mode, cards: message.cards ?? [], value: message.value ?? "", rows: message.rows, chips: message.chips, marks: message.marks, title: message.title }; return;
      case "validate": { const ok: string[] = []; const bad: string[] = []; for (const t of message.tokens) ((await this.tokenResolves(t)) ? ok : bad).push(t); this.post({ type: "validated", ok, bad }); return; }
      case "attach": {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] }, openLabel: "Attach" });
        for (const uri of picked ?? []) this.post({ type: "insert", text: `@image:${encodeURI(uri.fsPath)} ` });
        return;
      }
      case "pasteImage": {
        const mime = message.mime || "image/png";
        if (!/^image\/(png|jpe?g|gif|webp)$/i.test(mime)) return;
        let buf: Buffer;
        try { buf = Buffer.from(message.data, "base64"); } catch { return; }
        if (!buf.length || buf.length > 8_000_000) { void vscode.window.showWarningMessage("That image is too large to attach."); return; }
        const ext = /jpe?g/i.test(mime) ? "jpg" : /gif/i.test(mime) ? "gif" : /webp/i.test(mime) ? "webp" : "png";
        const dir = join(tmpdir(), "muster-chat-images");
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
        writeFileSync(dest, buf);
        this.post({ type: "insert", text: `@image:${encodeURI(dest)} ` });
        return;
      }
      case "restore": {
        const tab = this.active();
        if (!tab.checkpoints.get(message.id)) return;
        const messages = tab.messages.slice();
        const at = tab.messages.findIndex((m) => m.kind === "user" && m.checkpoint === message.id);
        if (tab.running) { await interruptTurn(tab.id); await new Promise((r) => setTimeout(r, 300)); }
        const { changed, inverse } = await this.revertTo(tab, at < 0 ? tab.messages.length : at);
        if (!tab.redo) tab.redo = { checkpoint: inverse, messages };
        else for (const [path, state] of inverse) if (!tab.redo.checkpoint.has(path)) tab.redo.checkpoint.set(path, state);
        // The provider forgets these turns only when the next message is sent, so "Redo checkpoint" can bring them back intact.
        if (at >= 0) tab.pendingRevert = this.revertRecord(tab, at);
        if (at >= 0) tab.messages = tab.messages.slice(0, at);
        tab.queue = [];
        this.post({ type: "messages", messages: tab.messages });
        this.pushState();
        void vscode.window.setStatusBarMessage(`Checkpoint restored · ${changed} file(s)`, 3000);
        return;
      }
      case "redo": {
        const tab = this.active();
        if (!tab.redo || tab.running) return;
        const redo = tab.redo;
        const { changed } = await this.runtimeFor(tab).restore(redo.checkpoint);
        tab.messages = redo.messages;
        delete tab.redo; delete tab.pendingRevert;
        this.post({ type: "messages", messages: tab.messages });
        this.pushState();
        void vscode.window.setStatusBarMessage(`Checkpoint redone · ${changed} file(s)`, 3000);
        return;
      }
      case "view": { if (message.view === "history") await this.showHistory(); else if (message.view === "board") await this.showBoard(); else { this.paneView = "chat"; this.pushState(); this.post({ type: "messages", messages: this.active().messages }); } return; }
      case "setMode": { const tab = this.active(); tab.settings.mode = message.id; const mode = this.modes().find((m) => m.id === message.id); if (mode?.effort && this.models.find((m) => m.id === tab.settings.modelId)?.efforts.some((e) => e.id === mode.effort)) tab.settings.effortId = mode.effort; this.persist(tab); this.pushState(); if (mode?.board) await this.showBoard(); return; }
      case "setAccess": { const tab = this.active(); if (!this.access.some(a => a.id === message.id)) return; tab.settings.accessId = message.id; this.runtimeFor(tab).setReviewMode(isUnattendedAccess(this.access.find(a => a.id === message.id)) ? "auto" : "review"); this.persist(tab); this.pushState(); return; }
      case "setModel": { this.selectModel(this.active(), message.id); this.pushState(); return; }
      case "setEffort": { const tab = this.active(); if (this.editLeaseActive(tab)) { void vscode.window.showWarningMessage("Wait for this task to finish before changing effort."); return; } tab.settings.effortId = message.id; this.persist(tab); this.pushState(); return; }
      case "dictate": this.onDictate?.(); return;
      case "renameThread": {
        const thread = (await this.visibleThreads()).find((t) => t.id === message.id); if (!thread) return;
        const name = await vscode.window.showInputBox({ prompt: "Thread name", value: thread.name }); if (!name || name === thread.name) return;
        const tab = this.tabs.find((t) => t.thread?.id === thread.id);
        const ok = await setThreadName(tab?.id, thread.id, name, this.cwd()); if (tab && ok) { tab.name = name.slice(0, 40); tab.thread = { ...thread, name }; }
        if (!ok) void vscode.window.showWarningMessage(`Could not rename: ${lastRollbackError}`);
        await this.showHistory(); return;
      }
      case "archiveThread": {
        const thread = (await this.visibleThreads()).find((t) => t.id === message.id); if (!thread) return;
        const tab = this.tabs.find((t) => t.thread?.id === thread.id); if (tab?.running) { void vscode.window.showWarningMessage("Stop the running turn first."); return; }
        const ok = await archiveThread(tab?.id, thread.id, this.cwd());
        if (ok && tab) await this.onMessage({ type: "closeTab", id: tab.id });
        if (!ok) void vscode.window.showWarningMessage(`Could not archive: ${lastRollbackError}`);
        await this.showHistory(); return;
      }
      case "exportThread": {
        const thread = (await this.visibleThreads()).find((t) => t.id === message.id); if (!thread) return;
        const history = await readHistory(thread);
        const md = [`# ${thread.name}`, "", `Thread ${thread.id} · ${thread.project} · ${thread.turnCount} turns`, "", ...history.flatMap((m) => [`## ${m.role === "user" ? "You" : "Agent"}`, "", m.text, ""])].join("\n");
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(this.cwd(), ".muster", "exports", `${thread.name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "thread"}.md`)), filters: { Markdown: ["md"] } });
        if (!target) return;
        mkdirSync(dirname(target.fsPath), { recursive: true }); writeFileSync(target.fsPath, md); await vscode.window.showTextDocument(target); return;
      }
      case "browserBookmark": { this.toggleBookmark(message.id); return; }
      case "browserDevtools": { void vscode.commands.executeCommand("muster.browser.devtools", { id: message.id }); return; }
      case "browserTrust": { const st = this.browser?.get(message.id); if (st) { void vscode.commands.executeCommand("muster.browser.trust", { id: message.id, url: st.url }); this.browser?.action(message.id, "reload"); } return; }
      case "pin": { const pinned = new Set(this.context.workspaceState.get<string[]>("muster.pinnedThreads", [])); if (message.pinned) pinned.add(message.id); else pinned.delete(message.id); await this.context.workspaceState.update("muster.pinnedThreads", [...pinned]); await this.showHistory(); return; }
      case "viewPlan": { const plan = this.active().plan; if (plan?.path) await this.openPlan(plan.path); return; }
      case "buildPlan": {
        const source = this.active();
        const plan = source.plan;
        if (!plan) return;
        const chosen = (message.todos ?? []).filter((i) => i >= 0 && i < plan.todos.length);
        const scope = chosen.length && chosen.length < plan.todos.length ? `Implement ONLY these to-dos from the plan (leave the others untouched):\n${chosen.map((i) => `- ${plan.todos[i]!.text}`).join("\n")}` : "Work through the to-dos in order and keep them updated.";
        const rel = plan.path ? relative(this.cwd(), plan.path) : "";
        const tab = message.newThread ? this.newTab(`Build: ${plan.title}`.slice(0, 40)) : source;
        if (message.newThread) { tab.plan = plan; this.paneView = "chat"; this.post({ type: "messages", messages: [] }); }
        tab.settings.mode = "agent";
        if (message.model && !this.selectModel(tab, message.model)) return;
        this.persist(tab);
        this.pushState();
        await this.send(`${message.newThread && rel ? `@${rel} ` : ""}Implement the plan${rel ? ` in ${rel}` : ""}. ${scope}`);
        return;
      }
      case "boardAdd": { const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []); tasks.push({ id: `task-${Date.now().toString(36)}`, title: message.title, column: "backlog", createdAt: Date.now() }); await this.context.workspaceState.update("muster.board", tasks); this.pushBoard(); return; }
      case "boardMove": { const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []); const task = tasks.find((t) => t.id === message.id); if (task) { task.column = message.column; await this.context.workspaceState.update("muster.board", tasks); } this.pushBoard(); return; }
      case "boardRun": {
        const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []);
        const task = tasks.find((t) => t.id === message.id);
        if (!task) return;
        if (task.threadId) { const thread = (await this.visibleThreads()).find((t) => t.id === task.threadId); if (thread) { await this.openThread(thread); return; } }
        const tab = this.newTab(task.title);
        tab.settings.mode = "agent";
        task.column = "progress";
        await this.context.workspaceState.update("muster.board", tasks);
        this.paneView = "chat";
        this.pushState();
        this.post({ type: "messages", messages: [] });
        await this.send(task.title);
        if (tab.thread) task.threadId = tab.thread.id;
        task.column = "review";
        await this.context.workspaceState.update("muster.board", tasks);
        return;
      }
      case "send": await this.send(message.text); return;
      case "newBrowser": this.openBrowserTab(); return;
      case "browserNav": this.browser?.navigate(message.id, message.url); return;
      case "browserEdit": this.browser?.applyEdit(message.id, { kind: message.kind, ...(message.prop ? { prop: message.prop } : {}), value: message.value }); return;
      case "browserRevert": this.browser?.revertEdit(message.id, message.index); return;
      case "browserTakeControl": this.browser?.takeControl(message.id); return;
      case "browserApply": { const text = this.browser?.changesPrompt(message.id); if (text) await this.toChat(text); return; }
      case "browserAction": this.browser?.action(message.id, message.action); return;
      case "browserRect": this.browser?.place(message.id, message.rect, message.visible && this.paneView === "browser" && this.active().browserId === message.id && (this.view?.visible ?? false)); return;
      case "browserToChat": { const st = this.browser?.get(message.id); if (st?.picked) await this.addBrowserPick({ id: message.id, picked: st.picked, imagePath: undefined, url: st.url, title: st.title }); return; }
    }
  }

  // ── running a turn ──

  private enqueueTab(tab: Tab, text: string): Promise<void> {
    const queued = this.taskRuntimes.enqueue(tab.id, text);
    if (!queued.id) return queued.promise.then(() => undefined);
    return new Promise<void>((resolve) => {
      queueMessage(tab.queue ??= [], tab.queueWaiters ??= [], text, () => { this.taskRuntimes.settleQueue(tab.id, queued.id!, { accepted: true }); resolve(); });
    });
  }

  private async send(text: string, tab: Tab = this.active()): Promise<void> {
    const post = (message: ToPane) => this.post(message, tab.id);
    if (!text.trim() || !this.tabs.includes(tab)) return;
    this.runtimeFor(tab);
    const runtimeBlocked = !this.runtimeCanStart(tab).ok;
    if (tab.inlineRunning || runtimeBlocked) {
      await this.enqueueTab(tab, text); this.pushState(); return;
    }
    if (tab.running) {
      // Typing mid-turn (Codex app / Claude Code): the message joins the running turn; if the provider cannot take it, it is queued for right after.
      const trimmed = text.trim();
      if (await steerTurn(trimmed, tab.id)) { tab.messages.push({ kind: "user", text: trimmed, steer: true }); post({ type: "user", text: trimmed, steer: true }); this.output.appendLine("steered the running turn"); }
      else { void this.enqueueTab(tab, trimmed); this.pushState(); }
      return;
    }
    delete tab.redo;
    if (tab.pendingRevert) { await this.forgetTurns(tab, tab.pendingRevert); delete tab.pendingRevert; }
    // Full access (Cursor auto-apply): edits stand as they land, the diff colours stay for review, nothing asks Accept/Reject per hunk.
    const runtime = this.runtimeFor(tab);
    runtime.setReviewMode(isUnattendedAccess(this.access.find((a) => a.id === tab.settings.accessId)) ? "auto" : "review");
    this.pushState();
    const mode = this.modes().find((m) => m.id === tab.settings.mode) ?? BUILTIN_MODES[0]!;
    if (mode.board) { await this.onMessage({ type: "boardAdd", title: text.trim() }); await this.showBoard(); return; }
    if (mode.parallel) { await this.runParallel(text); return; }
    if (mode.spec && tab.plan?.path) {
      // Cursor: "Spin up a new thread with this plan as context".
      const rel = relative(this.cwd(), tab.plan.path);
      const next = this.newTab(`Build: ${tab.plan.title}`.slice(0, 40));
      next.settings.mode = "agent";
      this.persist(next);
      this.paneView = "chat";
      this.pushState();
      post({ type: "messages", messages: [] });
      await this.send(`@${rel} ${text}`);
      return;
    }
    const cwd = tab.thread?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const runId = `run-${Date.now().toString(36)}-${cryptoId().slice(0, 8)}`;
    const runtimeStart = this.taskRuntimes.beginTurn(tab.id, runId);
    if (!runtimeStart.ok) { tab.lastError = runtimeStart.reason ?? "This task cannot start while its workspace is busy."; post({ type: "done", ok: false, error: tab.lastError }); return; }
    this.editOwner = tab;
    tab.running = true;
    tab.startedAt = Date.now(); tab.activity = "Preparing context"; delete tab.usage; tab.contextReferences = [];
    const checkpointId = `cp-${Date.now().toString(36)}`;
    tab.run = { id: runId, state: "preparing", startedAt: tab.startedAt, ...(tab.thread ? { threadId: tab.thread.id } : {}), dispatched: false };
    tab.activityTimeline ??= [];
    this.recordActivity(tab, "muster/run/preparing", { runId, checkpointId });
    this.saveChats();
    runtime.beginCheckpoint();

    tab.messages.push({ kind: "user", text, checkpoint: checkpointId });
    post({ type: "user", text, checkpoint: checkpointId });
    post({ type: "start" });
    this.pushState();
    const assistant: Extract<PaneMessage, { kind: "assistant" }> = { kind: "assistant", text: "", reasoning: "" };
    tab.messages.push(assistant);
    const tools = new Map<string, ToolMessage>();
    let planText = "";
    const graph = AgentGraphAdapter.from(tab.agentGraph ?? { rootThreadId: tab.thread?.id });
    const handlers = {
      onDelta: (delta: string) => { assistant.text += delta; post({ type: "delta", text: delta }); },
      onReasoning: (delta: string) => { assistant.reasoning += delta; post({ type: "reasoning", text: delta }); },
      onEvent: (method: string, params: Record<string, unknown>) => {
        const eventThreadId = typeof params.threadId === "string" ? params.threadId : typeof (params.turn as { threadId?: unknown } | undefined)?.threadId === "string" ? String((params.turn as { threadId: string }).threadId) : typeof (params.item as { threadId?: unknown } | undefined)?.threadId === "string" ? String((params.item as { threadId: string }).threadId) : undefined;
        if (method === "thread/started" && !tab.thread) {
          const started = params.thread as { id?: string } | undefined;
          if (started?.id) {
            const provider = validateSelection(selection).providerId;
            tab.thread = { id: started.id, providerId: provider, name: tab.name, cwd, project: cwd.split("/").pop() ?? cwd, filePath: "", lastActivityAt: new Date().toISOString(), turnCount: 0, sizeBytes: 0, live: true };
            tab.settings = { ...selection, providerId: provider }; this.persist(tab); this.saveChats();
          }
        }
        const rootThreadId = tab.thread?.id ?? graph.snapshot().rootThreadId;
        const childEvent = !!eventThreadId && !!rootThreadId && eventThreadId !== rootThreadId && (tab.agentGraph?.nodes ?? graph.snapshot().nodes).some((node) => node.threadId === eventThreadId && node.parentThreadId);
        const providerTurnId = typeof params.turnId === "string" ? params.turnId : typeof (params.turn as { id?: unknown } | undefined)?.id === "string" ? String((params.turn as { id: string }).id) : undefined;
        if (method === "turn/started" && !childEvent && providerTurnId) this.taskRuntimes.adoptTurn(tab.id, this.taskRuntimes.get(tab.id)?.activeTurnId ?? runId, providerTurnId);
        const routed = this.taskRuntimes.routeEvent({ taskId: tab.id, workspaceId: this.runtimeIdentity(tab).workspaceId, method, params, ...(eventThreadId ? { threadId: eventThreadId } : {}), ...(providerTurnId ? { turnId: providerTurnId } : {}), ...(childEvent ? { child: true } : {}), ...(typeof params.eventId === "string" ? { eventId: params.eventId } : {}) });
        if (!routed.accepted) { this.output.appendLine(`runtime event dropped: ${routed.reason ?? "unowned"}`); return; }
        const graphEvent = graph.ingest(method, params);
        tab.agentGraph = graph.snapshot();
        if (graphEvent) post({ type: "agentWorkspace", data: tab.agentGraph });
        if (childEvent && (method === "thread/status/changed" || method === "turn/completed" || method === "thread/closed")) this.maybeReleaseEditLease(tab);
        this.recordActivity(tab, method, params);
        if (process.env.MUSTER_CODE_DEV_SOCK && !method.endsWith("Delta") && !method.endsWith("/delta")) this.output.appendLine(`ev ${method} ${String(((params.item as { type?: string } | undefined)?.type) ?? "")}`);
        if (method === "thread/tokenUsage/updated" && !childEvent) {
          tab.usage = readUsage((params.tokenUsage as { last?: unknown } | undefined)?.last);
          const turnId = typeof params.turnId === "string" ? params.turnId : tab.run?.turnId;
          const previous = turnId ? tab.usageLedger?.find((entry) => entry.turnId === turnId) : undefined;
          const usage = { ...(previous ?? {}), id: previous?.id ?? `usage-${turnId ?? runId}`, startedAt: previous?.startedAt ?? tab.startedAt ?? Date.now(), ...(turnId ? { turnId } : {}), ...tab.usage, ...(tab.settings.modelId ? { model: tab.settings.modelId } : {}), ...(tab.settings.effortId ? { effort: tab.settings.effortId } : {}) } as UsageLedgerEntry;
          tab.usageLedger = [...(tab.usageLedger ?? []).filter((entry) => entry.id !== usage.id), usage];
        }
        if (method === "turn/started" && !childEvent) { tab.activity = "Working"; if (tab.run) { const turnId = String((params.turn as { id?: string } | undefined)?.id ?? params.turnId ?? ""); tab.run = { ...tab.run, state: "running", ...(turnId ? { turnId } : {}), dispatched: true }; } }
        if (method.endsWith("/requestApproval") && tab.run && !childEvent) { tab.run = { ...tab.run, state: "waiting" }; if (providerTurnId) this.taskRuntimes.setWaiting(tab.id, providerTurnId); }
        if (method === "item/started" && !childEvent) { const item = params.item as { type?: string; tool?: string; command?: string } | undefined; tab.activity = item?.type === "commandExecution" ? "Running command" : item?.type === "fileChange" ? "Editing files" : item?.type === "mcpToolCall" ? `Using ${item.tool ?? "tool"}` : item?.type === "webSearch" ? "Searching the web" : item?.type === "reasoning" ? "Thinking" : "Writing response"; }
        if ((method === "thread/tokenUsage/updated" && !childEvent) || (method === "item/started" && !childEvent) || (method === "turn/started" && !childEvent) || (method.endsWith("/requestApproval") && !childEvent)) post({ type: "telemetry", activity: tab.activity ?? "Working", ...(tab.usage ? { usage: tab.usage } : {}), ...(tab.usageLedger?.length ? { usageLedger: tab.usageLedger } : {}), ...(tab.activityTimeline?.length ? { activityTimeline: tab.activityTimeline } : {}), ...(tab.contextReferences?.length ? { contextReferences: tab.contextReferences } : {}), ...(tab.agentGraph ? { agentWorkspace: tab.agentGraph } : {}), ...(tab.run ? { run: tab.run, runState: tab.run.state } : {}), ...(tab.startedAt ? { startedAt: tab.startedAt } : {}) });
        if (method === "account/rateLimits/updated") this.accountEvents.fire(params);
        if (method === "turn/started" && !childEvent) { const turnId = String((params.turn as { id?: string } | undefined)?.id ?? params.turnId ?? ""); const mine = tab.messages.find((m) => m.kind === "user" && m.checkpoint === checkpointId); if (turnId && mine && mine.kind === "user") mine.turnId = turnId; }
        if (method === "item/started" && (params.item as {type?: string} | undefined)?.type === "fileChange") { const item = params.item as {id: string; changes?: {path?: string; diff?: string}[]}; (tab.proposals ??= new Map()).set(item.id, item.changes ?? []); }
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (method === "item/reasoning/textDelta" && !childEvent) {
          const delta = String(params.delta ?? "");
          if (delta) { assistant.reasoning += delta; post({ type: "reasoning", text: delta }); }
        } else if (method === "item/completed" && item.type === "reasoning" && !childEvent) {
          const text = String(item.text ?? item.summary ?? "");
          if (text && !assistant.reasoning) { assistant.reasoning = text; post({ type: "reasoning", text }); }
        } else if (!childEvent && method === "item/started" && (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "webSearch")) {
          const cua = computerUseToolFromItem(item);
          const tool: ToolMessage = cua
            ? { kind: "tool", ...cua, title: "Computer use", output: "", status: "running" }
            : { kind: "tool", id: String(item.id ?? ""), tool: item.type === "commandExecution" ? "command" : item.type === "webSearch" ? "search" : "mcp", ...(item.cwd ? { cwd: String(item.cwd) } : {}), title: item.type === "commandExecution" ? "Ran" : item.type === "webSearch" ? "Searched" : "Called", detail: String(item.command ?? item.query ?? item.tool ?? item.server ?? ""), output: "", status: "running" };
          tools.set(tool.id, tool);
          tab.messages.push(tool);
          post({ type: "tool", tool });
        } else if (method === "item/commandExecution/outputDelta" || method === "item/mcpToolCall/progress") {
          const tool = tools.get(String(params.itemId ?? ""));
          if (tool) { tool.output += String(params.delta ?? params.message ?? ""); post({ type: "tool", tool }); }
        } else if (method === "item/completed" && tools.has(String(item.id ?? ""))) {
          const tool = tools.get(String(item.id))!;
          if (item.type === "commandExecution") void runtime.syncTurnWatch();
          tool.status = String(item.status ?? "completed");
          if (typeof item.exitCode === "number") tool.exitCode = item.exitCode;
          if (typeof item.durationMs === "number") tool.durationMs = item.durationMs;
          if (typeof item.aggregatedOutput === "string" && !tool.output) tool.output = item.aggregatedOutput;
          post({ type: "tool", tool });
        } else if (method === "item/plan/delta") {
          planText += String(params.delta ?? "");
          post({ type: "plan", card: parsePlan(planText) });
        } else if (method === "item/completed" && item.type === "plan") {
          planText = String(item.text ?? planText);
          const card = parsePlan(planText);
          card.path = this.savePlan(card, planText, cwd);
          const planned = this.models.find((m) => m.id === tab.settings.modelId);
          if (planned) { card.model = planned.name; card.modelId = planned.id; }
          tab.plan = card;
          tab.messages.push({ kind: "plan", card });
          post({ type: "plan", card });
          void this.openPlan(card.path);
        } else if (method === "turn/plan/updated") {
          const steps = ((params.plan as { step?: string; status?: string }[] | undefined) ?? []).map((s) => ({ text: String(s.step ?? ""), done: s.status === "completed" }));
          if (steps.length) { const card: PlanCard = { title: tab.plan?.title ?? "Plan", summary: String(params.explanation ?? tab.plan?.summary ?? ""), todos: steps, ...(tab.plan?.path ? { path: tab.plan.path } : {}), ...(tab.plan?.model ? { model: tab.plan.model, modelId: tab.plan.modelId ?? "" } : {}) }; tab.plan = card; post({ type: "plan", card }); }
        }
        if (method === "thread/tokenUsage/updated" || method === "item/completed" || method === "thread/status/changed" || method.endsWith("/requestApproval")) this.saveChats();
      },
      onRequest: async (method: string, params: Record<string, unknown>) => {
        const requestThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
        const rootThreadId = tab.thread?.id ?? tab.agentGraph?.rootThreadId;
        const childApproval = !!requestThreadId && !!rootThreadId && requestThreadId !== rootThreadId && tab.agentGraph?.nodes.some((node) => node.threadId === requestThreadId && node.parentThreadId);
        return this.approve(method, childApproval ? { ...params, reason: `Child agent ${requestThreadId}: ${String(params.reason ?? "Approval requested")}` } : params, tab);
      },
    };
    const model = this.models.find((m) => m.id === tab.settings.modelId);
    const selection = { ...tab.settings };
    const access = this.access.find((a) => a.id === tab.settings.accessId);
    const askAccess: AccessMode | undefined = mode.readOnly ? { id: ":read-only", label: "Read only", sandbox: "read-only", approvalPolicy: "on-request" } : access;
    const stage = mode.debug ? DEBUG_STAGES[tab.settings.debugStage ?? 0]! : undefined;
    const preset = stage?.prompt ?? mode.prompt;
    try {
    if (!model) throw new Error("Select an available provider and model before running this task.");
    if (model.provider !== "claude") validateSelection(selection, tab.thread?.providerId);
    await runtime.beginTurnWatch(cwd);
    const expanded = await expandContext(preset ? `${preset}\n\n${text}` : text, cwd);
    const prompt = expanded.prompt;
    tab.contextReferences = expanded.references;
    tab.promptEstimate = Math.ceil(prompt.length / 4);
    post({ type: "telemetry", activity: "Sending context", promptEstimate: tab.promptEstimate, contextReferences: tab.contextReferences, ...(tab.agentGraph ? { agentWorkspace: tab.agentGraph } : {}), ...(tab.run ? { run: tab.run, runState: tab.run.state } : {}) });
    this.saveChats();
    const rules = readRules(cwd, { disabled: vscode.workspace.getConfiguration("muster").get<string[]>("rules.disabled", []), mentioned: [...text.matchAll(/(?:^|\s)@([\w./:-]+)/g)].map((m) => m[1]!) });
      const effort = tab.settings.effortId as "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      if (model?.provider === "claude" && tab.run) { tab.run = { ...tab.run, state: "running", dispatched: true }; post({ type: "telemetry", activity: "Working", run: tab.run, runState: tab.run.state }); }
      const result = model?.provider === "claude"
        ? await runClaudeTurn({ prompt, cwd, model: model.id.replace(/^claude:/, ""), effort, ...(tab.claudeSession ? { sessionId: tab.claudeSession, resume: true } : { sessionId: (tab.claudeSession = cryptoId()) }), handlers })
        : await runTurn({ prompt, cwd, ...(tab.thread ? { threadId: tab.thread.id } : {}), conversation: tab.id, model: model.id, ...(selection.providerId ? { providerId: selection.providerId } : {}), reasoning: effort, ...(askAccess ? { access: askAccess } : {}), mode: mode.plan ? "plan" : "default", ...(rules ? { rules } : {}), ...(expanded.images.length ? { images: expanded.images } : {}), handlers });
      if (result.threadId && model.provider !== "claude") {
        const route = validateSelection(selection);
        tab.thread = { ...(tab.thread ?? { name: tab.name, cwd, project: cwd.split("/").pop() ?? cwd, filePath: "", lastActivityAt: new Date().toISOString(), turnCount: 0, sizeBytes: 0, live: true }), id: result.threadId, providerId: route.providerId };
        tab.settings = { ...selection, providerId: route.providerId };
        this.persist(tab);
      }
      if (result.turnId && tab.run && !tab.run.turnId) tab.run = { ...tab.run, turnId: result.turnId, ...(result.dispatchState !== "not-dispatched" ? { dispatched: true } : {}) };
      if (result.tokenUsage) { tab.usage = readUsage(result.tokenUsage); const usage = { id: `usage-${tab.run?.turnId ?? runId}`, ...(tab.run?.turnId ? { turnId: tab.run.turnId } : {}), startedAt: tab.startedAt ?? Date.now(), endedAt: Date.now(), ...tab.usage, model: tab.settings.modelId, effort: tab.settings.effortId } as UsageLedgerEntry; tab.usageLedger = [...(tab.usageLedger ?? []).filter((entry) => entry.id !== usage.id), usage]; }
      if (result.status === "failed") {
        tab.lastError = result.errorMessage ?? "The turn failed.";
        if (tab.run) tab.run = { ...tab.run, state: result.fallbackEligible === false ? "disconnected" : "failed", endedAt: Date.now(), error: tab.lastError, ...(result.threadId ? { threadId: result.threadId } : {}) };
        this.output.appendLine(`turn failed: ${tab.lastError}`);
        post({ type: "done", ok: false, error: tab.lastError });
      } else {
        delete tab.lastError;
        if (tab.run) tab.run = { ...tab.run, state: "complete", endedAt: Date.now(), ...(result.threadId ? { threadId: result.threadId } : {}) };
        if (result.threadId && model.provider !== "claude") {
          const thread = (await listThreads().catch(() => [] as CodexThread[])).find((t) => t.id === result.threadId);
          if (thread) { tab.thread = { ...thread, providerId: validateSelection(selection).providerId }; tab.name = thread.name; this.persist(tab); }
        }
        if (tab.name === "New Agent") tab.name = text.trim().slice(0, 40);
        post({ type: "done", ok: true });
        if (mode.debug) { tab.settings.debugStage = (((tab.settings.debugStage ?? 0) + 1) % 3) as 0 | 1 | 2; this.persist(tab); }
        if (mode.autoFix && !tab.autoFixed) void this.autoFix(tab, checkpointId);
      }
    } catch (error) {
      tab.lastError = error instanceof Error ? error.message : String(error);
      if (tab.run) tab.run = { ...tab.run, state: tab.run.dispatched ? "disconnected" : "failed", endedAt: Date.now(), error: tab.lastError };
      this.output.appendLine(`turn threw: ${tab.lastError}`);
      post({ type: "done", ok: false, error: tab.lastError });
    } finally {
      this.settlePending("decline", tab.id);
      await runtime.syncTurnWatch(true).catch(() => undefined);
      tab.running = false; tab.activity = tab.run?.state === "interrupted" ? "Interrupted" : tab.run?.state === "disconnected" ? "Disconnected" : tab.lastError ? "Needs attention" : "Complete";
      if (tab.run && (tab.run.state === "preparing" || tab.run.state === "running" || tab.run.state === "waiting")) tab.run = { ...tab.run, state: tab.lastError ? "failed" : "complete", endedAt: Date.now(), ...(tab.lastError ? { error: tab.lastError } : {}) };
      tab.checkpoints.set(checkpointId, runtime.takeCheckpoint());
      const activeTurnId = this.taskRuntimes.get(tab.id)?.activeTurnId;
      if (activeTurnId) this.taskRuntimes.finishTurn(tab.id, activeTurnId, tab.lastError ? "failed" : "completed");
      this.taskRuntimes.checkpoint(tab.id, checkpointId, tab.checkpoints.get(checkpointId));
      this.recordActivity(tab, `muster/run/${tab.run?.state ?? "complete"}`, { runId, checkpointId, ...(tab.lastError ? { error: tab.lastError } : {}) });
      this.saveChats();
      this.pushState();
      this.maybeReleaseEditLease(tab);
    }
  }

  private drainQueued(preferred?: Tab): void {
    const queued = preferred?.queue?.length ? preferred : this.tabs.find((candidate) => !candidate.running && !candidate.inlineRunning && candidate.queue?.length);
    if (queued && (this.editLeaseActive(queued) || !this.runtimeCanStart(queued).ok)) return;
    const next = queued?.queue?.shift();
    const settled = queued?.queueWaiters?.shift();
    if (!queued || !next) return;
    const runtimeItem = this.taskRuntimes.dequeue(queued.id);
    this.pushState();
    void this.send(next, queued).finally(() => { if (runtimeItem) this.taskRuntimes.settleQueue(queued.id, runtimeItem.id); settled?.(); });
  }

  private activeDescendants(tab: Tab): AgentGraphSnapshot["nodes"] {
    const graph = tab.agentGraph; const root = graph?.rootThreadId ?? tab.thread?.id; if (!graph || !root) return [];
    return graph.nodes.filter((node) => isChildOfRoot(graph.nodes, node.threadId, root) && (node.status === "pendingInit" || node.status === "running"));
  }

  private editLeaseActive(tab: Tab): boolean { const graph = tab.agentGraph; const root = graph?.rootThreadId ?? tab.thread?.id; return !!(tab.inlineRunning || isEditLeaseActive(!!tab.running, graph?.nodes ?? [], root)); }

  private maybeReleaseEditLease(tab: Tab): void {
    if (this.editLeaseActive(tab)) return;
    const runtime = this.taskRuntimes.get(tab.id);
    if (runtime?.activeTurnId) this.taskRuntimes.finishTurn(tab.id, runtime.activeTurnId, tab.lastError ? "failed" : "completed");
    if (this.editOwner === tab) this.editOwner = undefined;
    this.drainQueued(tab);
  }

  /** Refuse closing an owner tab while descendants are still running so their warm owner remains resolvable. */
  private canCloseTab(tab: Tab): boolean {
    const graph = tab.agentGraph; const root = graph?.rootThreadId ?? tab.thread?.id; const active = graph && root ? activeDescendantCount(graph.nodes, root) : 0; if (!active) return true;
    void vscode.window.showWarningMessage(`Keep ${tab.name} open while ${active} child agent${active === 1 ? " is" : "s are"} still running. Stop the child work before closing this tab.`);
    return false;
  }

  /** Cursor's autoFix: after the agent edits, errors the language services report in the touched files go back to the agent once. */
  private async autoFix(tab: Tab, checkpointId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 1500));
    const touched = [...(tab.checkpoints.get(checkpointId)?.keys() ?? [])];
    const problems: string[] = [];
    for (const abs of touched) {
      for (const d of vscode.languages.getDiagnostics(vscode.Uri.file(abs))) {
        if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
        problems.push(`${relative(this.cwd(), abs)}:${d.range.start.line + 1}: ${d.message}`);
        if (problems.length >= 20) break;
      }
    }
    if (!problems.length || tab.running || !this.tabs.includes(tab) || tab.queue?.length) return;
    tab.autoFixed = true;
    try { await this.send(`Fix these problems reported by the language services in the files you edited (auto-fix):\n${problems.join("\n")}`, tab); } finally { tab.autoFixed = false; }
  }

  /** Cursor's Multitask: one request becomes several tasks that run in parallel threads and appear on the board. */
  private async runParallel(text: string): Promise<void> {
    const items = text.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim()).filter(Boolean);
    const tasks = items.length > 1 ? items : [text.trim()];
    const board = this.context.workspaceState.get<BoardTask[]>("muster.board", []);
    const runs: Promise<void>[] = [];
    for (const title of tasks) {
      const task: BoardTask = { id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title, column: "progress", createdAt: Date.now() };
      board.push(task);
      const tab = this.newTab(title.slice(0, 40));
      tab.settings.mode = "agent";
      runs.push((async () => {
        this.activeId = tab.id;
        await this.send(title);
        if (tab.thread) task.threadId = tab.thread.id;
        task.column = "review";
        await this.context.workspaceState.update("muster.board", board);
        this.pushBoard();
      })());
    }
    await this.context.workspaceState.update("muster.board", board);
    await this.showBoard();
    await Promise.allSettled(runs);
  }

  /** @path mentions become context blocks; the mention text stays so the agent sees what was meant. */
  private expandMentions(prompt: string, cwd: string): string {
    const blocks: string[] = [];
    for (const match of prompt.matchAll(/(?:^|\s)@([\w./-]+(?::\d+-\d+)?)/g)) {
      const rel = match[1]!.replace(/:\d+-\d+$/, "");
      const range = /:(\d+)-(\d+)$/.exec(match[1]!);
      const abs = join(cwd, rel);
      if (!existsSync(abs) || blocks.length >= 8) continue;
      try {
        const text = readFileSync(abs, "utf8");
        const lines = text.split("\n");
        const slice = range ? lines.slice(Number(range[1]) - 1, Number(range[2])) : lines.slice(0, 400);
        blocks.push(`<file path="${rel}"${range ? ` lines="${range[1]}-${range[2]}"` : ""}>\n${slice.join("\n")}${!range && lines.length > 400 ? "\n… (truncated)" : ""}\n</file>`);
      } catch { /* directories and binaries are skipped */ }
    }
    return blocks.length ? `${prompt}\n\nContext:\n${blocks.join("\n")}` : prompt;
  }

  /** Does a mention resolve to something the turn will attach? (Drives the pill colour in the composer.) */
  private async tokenResolves(token: string): Promise<boolean> {
    const cwd = this.cwd();
    if (token.startsWith("/")) { this.skills ??= await listSkills(cwd); return this.skills.some((s) => `/${s.name}` === token); }
    let body = token.slice(1); try { body = decodeURIComponent(body); } catch { return false; }
    if (/^browser:[a-f0-9]{20}$/.test(body)) return existsSync(join(cwd, ".muster", "browser", `context-${body.slice(8)}.json`));
    if (["browser", "web", "terminal", "git:diff", "git:branch", "git:pr", "rules"].includes(body) || body.startsWith("terminal:") || body.startsWith("git:commit:") || body.startsWith("code:") || body.startsWith("symbol:") || body.startsWith("link:") || /^https?:\/\//.test(body)) return true;
    if (body.startsWith("rule:")) return listRules(cwd).some((r) => r.name === body.slice(5));
    if (body.startsWith("folder:")) return existsSync(join(cwd, body.slice(7)));
    if (body.startsWith("image:")) return existsSync(body.slice(6));
    if (body.startsWith("docs:")) return vscode.workspace.getConfiguration("muster").get<{ name: string }[]>("docs", []).some((d) => d.name.toLowerCase() === body.slice(5).toLowerCase());
    if (body.startsWith("chat:")) return (await this.visibleThreads()).some((t) => t.id === body.slice(5));
    return existsSync(join(cwd, body.replace(/:\d+-\d+$/, "")));
  }

  private async suggest(kind: "file" | "skill", query: string, mode = "all"): Promise<MenuData> {
    if (kind === "skill") { this.skills ??= await listSkills(this.cwd()); return suggestSlash(this.cwd(), query, this.skills); }
    return suggestMentions(this.cwd(), query, mode);
  }

  /** Cursor's built-in slash commands: they act, they are not inserted as text. */
  private async slashAction(id: string): Promise<void> {
    if (id === "reset") { const tab = this.newTab(); this.activeId = tab.id; this.paneView = "chat"; this.pushState(); this.post({ type: "messages", messages: [] }); return; }
    if (id === "summarize") { await this.send("Summarize our conversation so far in under 10 lines: what I asked, what you did, what is left."); return; }
    if (id === "browser") { this.openBrowserTab(); return; }
    if (id === "review") {
      const tab = this.newTab("Review changes"); tab.settings.mode = "chat"; this.persist(tab); this.activeId = tab.id; this.paneView = "chat"; this.pushState(); this.post({ type: "messages", messages: [] });
      await this.send("Review the current working tree changes (run `git status` and `git diff`, including staged changes) for bugs, regressions, missing tests and risky changes. Report findings with file:line references, most severe first, or say \"No issues found\". Do not edit files.");
    }
  }

  private async agentAction(message: Extract<FromPane, { type: "agentAction" }>): Promise<void> {
    const tab = this.active(); const graph = tab.agentGraph;
    const node = graph?.nodes.find((candidate) => candidate.threadId === message.threadId || candidate.threadId === message.agentId || candidate.id === message.agentId);
    if (!node) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: false, reason: "Agent is not part of the current provider graph." }, tab.id); return; }
    if (message.threadId && message.threadId !== node.threadId) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: false, reason: "The requested agent ID does not match the provider graph node." }, tab.id); return; }
    const rootId = graph?.rootThreadId ?? tab.thread?.id;
    if (message.action === "open") {
      if (node.threadId === rootId) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: true }, tab.id); return; }
      try { const opened = await vscode.commands.executeCommand<boolean>("muster.thread.open", { id: node.threadId }); this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: opened === true, ...(opened === true ? {} : { reason: "The child thread could not be opened in the Agent pane." }) }, tab.id); } catch (error) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: false, reason: error instanceof Error ? error.message : String(error) }, tab.id); }
      return;
    }
    const descendant = !!rootId && isChildOfRoot(graph?.nodes ?? [], node.threadId, rootId);
    if (!descendant) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: false, reason: "The requested agent is not a child of the active root thread." }, tab.id); return; }
    if (node.status !== "running" || !node.turnId) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: false, reason: "The child has no active turn to control." }, tab.id); return; }
    if (message.action === "steer") {
      const text = await vscode.window.showInputBox({ prompt: `Steer ${node.name ?? node.threadId}`, placeHolder: "Instruction for the running agent" });
      if (!text?.trim()) { this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: false, reason: "No steering instruction provided." }, tab.id); return; }
      const result = await controlOwnedTurn(tab.id, node.threadId, node.turnId, "steer", text.trim(), tab.thread?.cwd ?? this.cwd()); this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: result.ok, ...(result.ok ? {} : { reason: result.reason ?? "The child provider turn could not be steered." }) }, tab.id); return;
    }
    const result = await controlOwnedTurn(tab.id, node.threadId, node.turnId, "interrupt", undefined, tab.thread?.cwd ?? this.cwd()); this.post({ type: "agentActionResult", action: message.action, agentId: message.agentId, ok: result.ok, ...(result.ok ? {} : { reason: result.reason ?? "The child provider turn could not be interrupted." }) }, tab.id);
  }

  /** Approval and question requests from the provider (Manual approval / Read only): ask in the app, answer on the wire. */
  private async approve(method: string, params: Record<string, unknown>, tab: Tab = this.active()): Promise<Record<string, unknown> | undefined> {
    const requestThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const requestTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    const rootThreadId = tab.thread?.id ?? tab.agentGraph?.rootThreadId;
    const childThreadId = requestThreadId && rootThreadId && requestThreadId !== rootThreadId && tab.agentGraph?.nodes.some((node) => node.threadId === requestThreadId && node.parentThreadId) ? requestThreadId : undefined;
    if (requestThreadId && requestThreadId !== rootThreadId && !childThreadId) return undefined;
    this.runtimeFor(tab);
    if (method !== "item/permissions/requestApproval" && !method.endsWith("/requestApproval") && method !== "mcpServer/elicitation/request" && !method.endsWith("/elicitation/request") && method !== "openai/form" && method !== "item/tool/requestUserInput") return undefined;
    const approvalId = String(params.approvalId ?? params.itemId ?? `ap-${Date.now().toString(36)}`);
    const claim = this.taskRuntimes.requestApproval(tab.id, { id: approvalId, method, ...(requestThreadId ? { threadId: requestThreadId } : {}), ...(requestTurnId ? { turnId: requestTurnId } : {}), payload: params });
    if (!claim.accepted) { this.output.appendLine(`approval dropped: ${claim.reason ?? "already owned"}`); return undefined; }
    const resolveClaim = (decision: unknown) => { this.taskRuntimes.resolveApproval(tab.id, approvalId, decision); return decision; };
    const silent = isUnattendedAccess(this.access.find((a) => a.id === tab.settings.accessId));
    if (method === "item/permissions/requestApproval") {
      if (silent) return resolveClaim({ permissions: params.permissions ?? {}, scope: "session" }) as Record<string, unknown>;
      const decision = await this.askInChat({ id: String(params.itemId ?? cryptoId()), kind: "elicitation", command: JSON.stringify(params.permissions ?? {}, null, 2), reason: String(params.reason ?? "Additional permissions requested") }, tab, childThreadId);
      resolveClaim(decision);
      return { permissions: decision === "accept" || decision === "acceptForSession" ? params.permissions ?? {} : {}, scope: decision === "acceptForSession" ? "session" : "turn" };
    }
    if (method.endsWith("/requestApproval")) {
      if (silent) return resolveClaim({ decision: "accept" }) as Record<string, unknown>;
      const isCommand = method.includes("commandExecution");
      const changes = Array.isArray(params.changes) ? params.changes as {path?: string; diff?: string}[] : tab.proposals?.get(String(params.itemId ?? "")) ?? [];
      const files = changes.map(c => c.path ?? "").filter(Boolean);
      const diff = changes.map(c => `${c.path ?? ""}\n${c.diff ?? ""}`).join("\n\n");
      const card: ApprovalCard = { id: String(params.approvalId ?? params.itemId ?? `ap-${Date.now().toString(36)}`), kind: isCommand ? "command" : "patch", command: String(params.command ?? (files?.length ? `Edit ${files.length} file(s)` : params.reason ?? "Apply changes")), ...(params.cwd ? { cwd: String(params.cwd) } : {}), ...(params.reason ? { reason: String(params.reason) } : {}), ...(files.length ? { files } : {}), ...(diff ? { diff } : {}) };
      const decision = await this.askInChat(card, tab, childThreadId);
      resolveClaim(decision);
      return { decision };
    }
    if (method === "mcpServer/elicitation/request" || method.endsWith("/elicitation/request") || method === "openai/form") {
      if (silent) return resolveClaim({ action: "accept", content: {} }) as Record<string, unknown>;
      const text = elicitationText(params);
      const decision = await this.askInChat({ id: String(params.elicitationId ?? params.id ?? `el-${Date.now().toString(36)}`), kind: "elicitation", command: text, ...(params.reason ? { reason: String(params.reason) } : {}) }, tab);
      resolveClaim(decision);
      return decision === "decline" ? { action: "decline", content: null } : { action: "accept", content: {} };
    }
    if (method === "item/tool/requestUserInput") {
      const questions = (params.questions as { id?: string; header?: string; question?: string; options?: { label?: string }[] }[] | undefined) ?? [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of questions) {
        const options = (q.options ?? []).map((o) => String(o.label ?? "")).filter(Boolean);
        const answer = options.length ? await vscode.window.showQuickPick(options, { placeHolder: q.question ?? q.header ?? "Codex asks" }) : await vscode.window.showInputBox({ prompt: q.question ?? q.header ?? "Codex asks" });
        answers[String(q.id ?? q.header ?? "answer")] = { answers: answer ? [answer] : [] };
      }
      resolveClaim(answers);
      return { answers };
    }
    return undefined;
  }

  private savePlan(card: PlanCard, markdown: string, cwd: string): string {
    const dir = join(cwd, ".muster", "plans");
    mkdirSync(dir, { recursive: true });
    const slug = card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "plan";
    let path = join(dir, `${slug}.plan.md`);
    let n = 2;
    while (existsSync(path)) path = join(dir, `${slug}-${n++}.plan.md`);
    writeFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    return path;
  }

  private async openPlan(path: string): Promise<void> {
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(path), "muster.planEditor", { preserveFocus: true });
  }
}

const COMPUTER_USE_SERVER = /computer-use|unified-computer-use|cua_repl|node_repl/i;
const COMPUTER_USE_TOOL = /^(listApps|list_apps|snapshot|getAppState|get_app_state|click|type|typeText|type_text|scroll)$/i;

/** item/started mcpToolCall payload → transcript tool card fields. */
export function computerUseToolFromItem(item: Record<string, unknown>, status = "running"): { id: string; tool: "computer"; detail: string; status: string } | undefined {
  const server = String(item.server ?? item.mcpServer ?? item.serverName ?? item.plugin ?? "");
  const name = String(item.tool ?? item.toolName ?? item.name ?? "");
  const type = String(item.type ?? "");
  if (type && type !== "mcpToolCall") return undefined;
  if (!COMPUTER_USE_SERVER.test(server) && !COMPUTER_USE_SERVER.test(name) && !COMPUTER_USE_TOOL.test(name)) return undefined;
  return { id: String(item.id ?? ""), tool: "computer", detail: [server, name].filter(Boolean).join(" ") || "computer-use", status };
}

/** Computer-use / MCP elicitation text from app-server or plugin payload shapes. */
export function elicitationText(params: Record<string, unknown>): string {
  const nested = params.elicitation ?? params.params ?? params.request;
  const row = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
  for (const value of [params.message, params.prompt, params.text, params.description, params.reason, params.title, row?.message, row?.prompt, row?.text, row?.description]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  const schema = params.requestedSchema ?? row?.requestedSchema;
  if (schema && typeof schema === "object") return JSON.stringify(schema, null, 2);
  return "An MCP server asks for permission.";
}

function catalogThread(record: ThreadRecord): CodexThread {
  const raw = record.raw; const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now() / 1000;
  return { id: record.id, name: record.name, project: record.workspaceRoot.split(/[\\/]/).pop() || record.workspaceRoot || "(workspace)", cwd: record.cwd, filePath: typeof raw.path === "string" ? raw.path : typeof raw.filePath === "string" ? raw.filePath : "", lastActivityAt: new Date(updatedAt * 1000).toISOString(), turnCount: Array.isArray((raw as { turns?: unknown }).turns) ? (raw as { turns: unknown[] }).turns.length : 0, sizeBytes: 0, live: record.status?.type === "active" };
}

function hydrateCatalogTurns(value: unknown): PaneMessage[] {
  const messages: PaneMessage[] = [];
  for (const turn of Array.isArray(value) ? value : []) {
    const items = turn && typeof turn === "object" && Array.isArray((turn as { items?: unknown }).items) ? (turn as { items: unknown[] }).items : [];
    const storedTurnId = turn && typeof turn === "object" && typeof (turn as { id?: unknown }).id === "string" ? String((turn as { id: string }).id) : undefined;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>; const type = typeof row.type === "string" ? row.type : "";
      if (type === "userMessage") {
        const content = Array.isArray(row.content) ? row.content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : part && typeof part === "object" && typeof (part as { path?: unknown }).path === "string" ? `[${String((part as { type?: unknown }).type ?? "attachment")}:${String((part as { path: string }).path)}]` : "").filter(Boolean).join("\n") : "";
        if (content) messages.push({ kind: "user", text: content, ...(storedTurnId ? { turnId: storedTurnId } : {}) });
      } else if (type === "agentMessage" && typeof row.text === "string") messages.push({ kind: "assistant", text: row.text, reasoning: "" });
      else if (type === "commandExecution") messages.push({ kind: "tool", id: String(row.id ?? cryptoId()), title: "Command", detail: String(row.command ?? ""), output: String(row.aggregatedOutput ?? ""), status: String(row.status ?? "completed"), ...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}), ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}) });
      else if (type === "fileChange") { const paths = Array.isArray(row.changes) ? row.changes.map((change) => change && typeof change === "object" ? String((change as { path?: unknown }).path ?? "") : "").filter(Boolean) : []; messages.push({ kind: "assistant", text: paths.length ? `File changes: ${paths.join(", ")}` : "File changes", reasoning: "" }); }
      else if (type === "plan" && typeof row.text === "string") messages.push({ kind: "assistant", text: row.text, reasoning: "" });
    }
  }
  return messages;
}

function replayCatalogGraph(rootThreadId: string, value: unknown): AgentGraphSnapshot {
  const graph = new AgentGraphAdapter(rootThreadId);
  for (const turn of Array.isArray(value) ? value : []) {
    if (!turn || typeof turn !== "object") continue;
    const row = turn as Record<string, unknown>; const turnId = typeof row.id === "string" ? row.id : ""; if (!turnId) continue;
    const startedAt = typeof row.startedAt === "number" ? row.startedAt * 1000 : 0; const completedAt = typeof row.completedAt === "number" ? row.completedAt * 1000 : startedAt;
    graph.ingest("turn/started", { threadId: rootThreadId, turn: { id: turnId } }, startedAt);
    for (const item of Array.isArray(row.items) ? row.items : []) if (item && typeof item === "object") graph.ingest("item/completed", { threadId: rootThreadId, turnId, item }, completedAt);
    const status = typeof row.status === "string" ? row.status : "";
    if (status && status !== "inProgress") graph.ingest("turn/completed", { threadId: rootThreadId, turn: { id: turnId, status } }, completedAt);
  }
  return graph.snapshot();
}

function cryptoId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); });
}

/** Title, first paragraph, and the to-dos (checkbox, bullet or numbered items) of a streamed plan. */
function parsePlan(markdown: string): PlanCard {
  const lines = markdown.split("\n");
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim() ?? "Plan";
  const body = lines.filter((l) => !/^#/.test(l) && l.trim());
  const summary = body.find((l) => !/^\s*([-*]|\d+\.)\s/.test(l)) ?? "";
  const todos = lines.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l)).map((l) => {
    const raw = l.replace(/^\s*([-*]|\d+\.)\s+/, "");
    const box = /^\[( |x|X)\]\s*/.exec(raw);
    return { text: raw.replace(/^\[( |x|X)\]\s*/, "").replace(/\*\*/g, ""), done: !!box && box[1] !== " " };
  });
  return { title, summary: summary.trim(), todos };
}
