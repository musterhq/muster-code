// The Agent pane — muster's own chat surface in the secondary sidebar, built to
// Cursor's chat (docs/cursor-parity-spec.md, docs/cursor-feature-atlas.md):
// thread tabs, history, modes (Agent / Plan / Ask / Kanban / custom), access
// modes and models discovered from the app-server, plan cards saved as
// .plan.md in the workspace, tool cards, edit cards, the review bar.
import * as vscode from "vscode";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { formatAge, formatSize, interruptTurn, listAccessModes, listModels, listThreads, readHistory, runClaudeTurn, runTurn, type AccessMode, type CodexThread, type ModelInfo } from "./codex.js";
import type { EditCard, LiveEditController } from "./live-edit.js";

interface ModeInfo { readonly id: string; readonly name: string; readonly icon: string; readonly placeholder: string; readonly prompt?: string }
interface ThreadSettings { mode: string; accessId: string; modelId: string; effortId: string }
interface PlanCard { title: string; summary: string; todos: { text: string; done: boolean }[]; path?: string }
type ToolMessage = { kind: "tool"; id: string; title: string; detail: string; output: string; status: string };
type PaneMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning: string }
  | ToolMessage
  | { kind: "plan"; card: PlanCard };
interface Tab { id: string; name: string; thread?: CodexThread; messages: PaneMessage[]; settings: ThreadSettings; plan?: PlanCard; claudeSession?: string; running: boolean }
interface BoardTask { id: string; title: string; column: "backlog" | "progress" | "review" | "done"; threadId?: string; createdAt: number }

type ToPane =
  | { type: "state"; tabs: { id: string; name: string; running: boolean }[]; activeId: string; view: "chat" | "history" | "board"; modes: ModeInfo[]; access: AccessMode[]; models: ModelInfo[]; settings: ThreadSettings; loading: boolean }
  | { type: "messages"; messages: PaneMessage[] }
  | { type: "user"; text: string }
  | { type: "start" }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: ToolMessage }
  | { type: "plan"; card: PlanCard }
  | { type: "done"; ok: boolean; error?: string }
  | { type: "edit"; card: EditCard }
  | { type: "review"; files: EditCard[] }
  | { type: "threads"; items: { id: string; name: string; project: string; age: string; turns: number; size: string; live: boolean; pinned: boolean }[] }
  | { type: "board"; columns: { id: string; title: string; cards: { id: string; title: string; subtitle: string; running: boolean }[] }[] };
type FromPane =
  | { type: "ready" } | { type: "send"; text: string } | { type: "stop" }
  | { type: "acceptAll" } | { type: "rejectAll" } | { type: "open"; path: string }
  | { type: "newAgent" } | { type: "openThread"; id: string } | { type: "closeTab"; id: string } | { type: "activateTab"; id: string }
  | { type: "view"; view: "chat" | "history" | "board" }
  | { type: "setMode"; id: string } | { type: "setAccess"; id: string } | { type: "setModel"; id: string } | { type: "setEffort"; id: string }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "viewPlan" } | { type: "buildPlan" }
  | { type: "boardAdd"; title: string } | { type: "boardRun"; id: string } | { type: "boardMove"; id: string; column: BoardTask["column"] };

const BUILTIN_MODES: ModeInfo[] = [
  { id: "agent", name: "Agent", icon: "∞", placeholder: "Plan, search, build anything" },
  { id: "plan", name: "Plan", icon: "☰", placeholder: "Plan, Build, / for skills, @ for context" },
  { id: "ask", name: "Ask", icon: "◌", placeholder: "Ask, learn, brainstorm" },
  { id: "kanban", name: "Kanban", icon: "▦", placeholder: "Add a task to the board" },
];

export class AgentPane implements vscode.WebviewViewProvider {
  static readonly viewId = "muster.agent.pane";
  private view: vscode.WebviewView | undefined;
  private tabs: Tab[] = [];
  private activeId = "";
  private paneView: "chat" | "history" | "board" = "chat";
  private models: ModelInfo[] = [];
  private access: AccessMode[] = [];
  private loading = true;
  private catalogLoaded = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.LogOutputChannel, private readonly live: LiveEditController) {
    this.live.onCard((card) => this.post({ type: "edit", card }));
    this.live.onChange(() => this.post({ type: "review", files: this.live.review() }));
    this.newTab();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = paneHtml(view.webview.cspSource);
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
      tab.messages = history.map((m) => (m.role === "user" ? { kind: "user", text: m.text } : { kind: "assistant", text: m.text, reasoning: "" }));
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
    const threads = await listThreads();
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

  cycleMode(): void {
    const tab = this.active();
    const modes = this.modes();
    const index = modes.findIndex((m) => m.id === tab.settings.mode);
    tab.settings.mode = modes[(index + 1) % modes.length]!.id;
    this.persist(tab);
    this.pushState();
  }

  stop(): void {
    if (this.active().running) void interruptTurn();
  }

  // ── state ──

  private newTab(name = "New Agent", thread?: CodexThread): Tab {
    const id = thread?.id ?? `new-${Date.now().toString(36)}`;
    const saved = this.context.workspaceState.get<Record<string, ThreadSettings>>("muster.threadSettings", {})[id];
    const tab: Tab = { id, name, ...(thread ? { thread } : {}), messages: [], settings: saved ?? this.defaultSettings(), running: false };
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
    return { mode: "agent", accessId: this.access.find((a) => a.id === ":workspace")?.id ?? this.access[0]?.id ?? ":workspace", modelId: model?.id ?? config.get<string>("codex.model") ?? "", effortId: config.get<string>("codex.effort") ?? model?.defaultEffort ?? "medium" };
  }

  private persist(tab: Tab): void {
    const all = { ...this.context.workspaceState.get<Record<string, ThreadSettings>>("muster.threadSettings", {}), [tab.id]: tab.settings };
    void this.context.workspaceState.update("muster.threadSettings", all);
  }

  private modes(): ModeInfo[] {
    const custom = vscode.workspace.getConfiguration("muster").get<Partial<ModeInfo>[]>("modes", []);
    return [...BUILTIN_MODES, ...custom.filter((m) => m.id && m.name).map((m) => ({ id: m.id!, name: m.name!, icon: m.icon ?? "◆", placeholder: m.placeholder ?? "Plan, search, build anything", ...(m.prompt ? { prompt: m.prompt } : {}) }))];
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
    for (const tab of this.tabs) {
      if (!this.models.some((m) => m.id === tab.settings.modelId)) tab.settings.modelId = this.defaultSettings().modelId;
      if (!this.access.some((a) => a.id === tab.settings.accessId)) tab.settings.accessId = this.defaultSettings().accessId;
      const model = this.models.find((m) => m.id === tab.settings.modelId);
      if (model && !model.efforts.some((e) => e.id === tab.settings.effortId)) tab.settings.effortId = model.defaultEffort;
    }
    this.pushState();
  }

  private cwd(): string {
    return this.active().thread?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private post(message: ToPane): void {
    void this.view?.webview.postMessage(message);
  }

  private pushState(): void {
    const tab = this.active();
    this.post({ type: "state", tabs: this.tabs.map((t) => ({ id: t.id, name: t.name, running: t.running })), activeId: tab.id, view: this.paneView, modes: this.modes(), access: this.access, models: this.models, settings: tab.settings, loading: this.loading });
  }

  private pushBoard(): void {
    const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []);
    const running = new Set(this.tabs.filter((t) => t.running).map((t) => t.thread?.id ?? t.id));
    const column = (id: BoardTask["column"], title: string) => ({ id, title, cards: tasks.filter((t) => t.column === id).map((t) => ({ id: t.id, title: t.title, subtitle: t.threadId ? "thread" : "not started", running: !!t.threadId && running.has(t.threadId) })) });
    this.post({ type: "board", columns: [column("backlog", "Backlog"), column("progress", "In progress"), column("review", "Review"), column("done", "Done")] });
  }

  // ── messages from the webview ──

  private async onMessage(message: FromPane): Promise<void> {
    switch (message.type) {
      case "ready": this.pushState(); this.post({ type: "messages", messages: this.active().messages }); void this.loadCatalog(); return;
      case "stop": this.stop(); return;
      case "acceptAll": await this.live.acceptAll(); return;
      case "rejectAll": await this.live.rejectAll(); return;
      case "open": await this.live.open(message.path); return;
      case "newAgent": this.newAgent(); return;
      case "activateTab": { const tab = this.tabs.find((t) => t.id === message.id); if (tab) { this.activeId = tab.id; this.paneView = "chat"; this.pushState(); this.post({ type: "messages", messages: tab.messages }); } return; }
      case "closeTab": { this.tabs = this.tabs.filter((t) => t.id !== message.id); if (!this.tabs.length) this.newTab(); if (!this.tabs.some((t) => t.id === this.activeId)) this.activeId = this.tabs[this.tabs.length - 1]!.id; this.pushState(); this.post({ type: "messages", messages: this.active().messages }); return; }
      case "openThread": { const thread = (await listThreads()).find((t) => t.id === message.id); if (thread) await this.openThread(thread); return; }
      case "view": { if (message.view === "history") await this.showHistory(); else if (message.view === "board") await this.showBoard(); else { this.paneView = "chat"; this.pushState(); this.post({ type: "messages", messages: this.active().messages }); } return; }
      case "setMode": { const tab = this.active(); tab.settings.mode = message.id; this.persist(tab); this.pushState(); if (message.id === "kanban") await this.showBoard(); return; }
      case "setAccess": { const tab = this.active(); tab.settings.accessId = message.id; this.persist(tab); this.pushState(); return; }
      case "setModel": { const tab = this.active(); tab.settings.modelId = message.id; const model = this.models.find((m) => m.id === message.id); if (model && !model.efforts.some((e) => e.id === tab.settings.effortId)) tab.settings.effortId = model.defaultEffort; this.persist(tab); this.pushState(); return; }
      case "setEffort": { const tab = this.active(); tab.settings.effortId = message.id; this.persist(tab); this.pushState(); return; }
      case "pin": { const pinned = new Set(this.context.workspaceState.get<string[]>("muster.pinnedThreads", [])); if (message.pinned) pinned.add(message.id); else pinned.delete(message.id); await this.context.workspaceState.update("muster.pinnedThreads", [...pinned]); await this.showHistory(); return; }
      case "viewPlan": { const plan = this.active().plan; if (plan?.path) await this.openPlan(plan.path); return; }
      case "buildPlan": { const tab = this.active(); const plan = tab.plan; if (!plan) return; tab.settings.mode = "agent"; this.persist(tab); this.pushState(); await this.send(`Implement the plan${plan.path ? ` in ${relative(this.cwd(), plan.path)}` : ""}. Work through the to-dos in order and keep them updated.`); return; }
      case "boardAdd": { const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []); tasks.push({ id: `task-${Date.now().toString(36)}`, title: message.title, column: "backlog", createdAt: Date.now() }); await this.context.workspaceState.update("muster.board", tasks); this.pushBoard(); return; }
      case "boardMove": { const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []); const task = tasks.find((t) => t.id === message.id); if (task) { task.column = message.column; await this.context.workspaceState.update("muster.board", tasks); } this.pushBoard(); return; }
      case "boardRun": {
        const tasks = this.context.workspaceState.get<BoardTask[]>("muster.board", []);
        const task = tasks.find((t) => t.id === message.id);
        if (!task) return;
        if (task.threadId) { const thread = (await listThreads()).find((t) => t.id === task.threadId); if (thread) { await this.openThread(thread); return; } }
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
    }
  }

  // ── running a turn ──

  private async send(text: string): Promise<void> {
    const tab = this.active();
    if (!text.trim() || tab.running) return;
    const mode = this.modes().find((m) => m.id === tab.settings.mode) ?? BUILTIN_MODES[0]!;
    if (mode.id === "kanban") { await this.onMessage({ type: "boardAdd", title: text.trim() }); await this.showBoard(); return; }
    const cwd = this.cwd();
    tab.running = true;
    tab.messages.push({ kind: "user", text });
    this.post({ type: "user", text });
    this.post({ type: "start" });
    this.pushState();
    const assistant: Extract<PaneMessage, { kind: "assistant" }> = { kind: "assistant", text: "", reasoning: "" };
    tab.messages.push(assistant);
    const tools = new Map<string, ToolMessage>();
    let planText = "";
    const handlers = {
      onDelta: (delta: string) => { assistant.text += delta; this.post({ type: "delta", text: delta }); },
      onReasoning: (delta: string) => { assistant.reasoning += delta; this.post({ type: "reasoning", text: delta }); },
      onEvent: (method: string, params: Record<string, unknown>) => {
        this.live.onEvent(method, params);
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (method === "item/started" && (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "webSearch")) {
          const tool: ToolMessage = { kind: "tool", id: String(item.id ?? ""), title: item.type === "commandExecution" ? "Ran" : item.type === "webSearch" ? "Searched" : "Called", detail: String(item.command ?? item.query ?? item.tool ?? item.server ?? ""), output: "", status: "running" };
          tools.set(tool.id, tool);
          tab.messages.push(tool);
          this.post({ type: "tool", tool });
        } else if (method === "item/commandExecution/outputDelta") {
          const tool = tools.get(String(params.itemId ?? ""));
          if (tool) { tool.output += String(params.delta ?? ""); this.post({ type: "tool", tool }); }
        } else if (method === "item/completed" && tools.has(String(item.id ?? ""))) {
          const tool = tools.get(String(item.id))!;
          tool.status = String(item.status ?? "completed");
          if (typeof item.aggregatedOutput === "string" && !tool.output) tool.output = item.aggregatedOutput;
          this.post({ type: "tool", tool });
        } else if (method === "item/plan/delta") {
          planText += String(params.delta ?? "");
          this.post({ type: "plan", card: parsePlan(planText) });
        } else if (method === "item/completed" && item.type === "plan") {
          planText = String(item.text ?? planText);
          const card = parsePlan(planText);
          card.path = this.savePlan(card, planText, cwd);
          tab.plan = card;
          tab.messages.push({ kind: "plan", card });
          this.post({ type: "plan", card });
          void this.openPlan(card.path);
        } else if (method === "turn/plan/updated") {
          const steps = ((params.plan as { step?: string; status?: string }[] | undefined) ?? []).map((s) => ({ text: String(s.step ?? ""), done: s.status === "completed" }));
          if (steps.length) { const card: PlanCard = { title: tab.plan?.title ?? "Plan", summary: String(params.explanation ?? tab.plan?.summary ?? ""), todos: steps, ...(tab.plan?.path ? { path: tab.plan.path } : {}) }; tab.plan = card; this.post({ type: "plan", card }); }
        }
      },
      onRequest: async (method: string, params: Record<string, unknown>) => this.approve(method, params),
    };
    const model = this.models.find((m) => m.id === tab.settings.modelId);
    const access = this.access.find((a) => a.id === tab.settings.accessId);
    const askAccess: AccessMode | undefined = mode.id === "ask" ? { id: ":read-only", label: "Read only", sandbox: "read-only", approvalPolicy: "on-request" } : access;
    const prompt = mode.prompt ? `${mode.prompt}\n\n${text}` : text;
    try {
      const effort = tab.settings.effortId as "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      const result = model?.provider === "claude"
        ? await runClaudeTurn({ prompt, cwd, model: model.id.replace(/^claude:/, ""), effort, ...(tab.claudeSession ? { sessionId: tab.claudeSession, resume: true } : { sessionId: (tab.claudeSession = cryptoId()) }), handlers })
        : await runTurn({ prompt, cwd, ...(tab.thread ? { threadId: tab.thread.id } : {}), ...(model ? { model: model.id } : {}), reasoning: effort, ...(askAccess ? { access: askAccess } : {}), mode: mode.id === "plan" ? "plan" : "default", handlers });
      if (result.status === "failed") {
        this.post({ type: "done", ok: false, error: result.errorMessage ?? "The turn failed." });
      } else {
        if (result.threadId && !tab.thread && model?.provider !== "claude") {
          const thread = (await listThreads()).find((t) => t.id === result.threadId);
          if (thread) { tab.thread = thread; tab.name = thread.name; }
        }
        if (tab.name === "New Agent") tab.name = text.trim().slice(0, 40);
        this.post({ type: "done", ok: true });
      }
    } catch (error) {
      this.post({ type: "done", ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      tab.running = false;
      this.pushState();
    }
  }

  /** Approval and question requests from the provider (Manual approval / Read only): ask in the app, answer on the wire. */
  private async approve(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (method.endsWith("/requestApproval")) {
      const what = String(params.command ?? params.reason ?? (Array.isArray(params.changes) ? `edit ${params.changes.length} file(s)` : method));
      const pick = await vscode.window.showWarningMessage(`Codex wants to ${method.includes("commandExecution") ? "run" : "do"}: ${what}`, "Allow", "Allow for session", "Deny");
      const decision = pick === "Allow" ? "accept" : pick === "Allow for session" ? "acceptForSession" : "decline";
      return { decision };
    }
    if (method === "item/tool/requestUserInput") {
      const questions = (params.questions as { id?: string; header?: string; question?: string; options?: { label?: string }[] }[] | undefined) ?? [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of questions) {
        const options = (q.options ?? []).map((o) => String(o.label ?? "")).filter(Boolean);
        const answer = options.length ? await vscode.window.showQuickPick(options, { placeHolder: q.question ?? q.header ?? "Codex asks" }) : await vscode.window.showInputBox({ prompt: q.question ?? q.header ?? "Codex asks" });
        answers[String(q.id ?? q.header ?? "answer")] = { answers: answer ? [answer] : [] };
      }
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
    await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(path));
  }
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

function paneHtml(csp: string): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp}; img-src ${csp} data:;">
<style>
  :root {
    --fg: var(--vscode-editor-foreground);
    --bg-primary: color-mix(in srgb, var(--fg) 20%, transparent);
    --bg-secondary: color-mix(in srgb, var(--fg) 14%, transparent);
    --bg-tertiary: color-mix(in srgb, var(--fg) 8%, transparent);
    --bg-quaternary: color-mix(in srgb, var(--fg) 6%, transparent);
    --bg-quinary: color-mix(in srgb, var(--fg) 4%, transparent);
    --text-secondary: color-mix(in srgb, var(--fg) 66%, transparent);
    --text-tertiary: color-mix(in srgb, var(--fg) 36%, transparent);
    --stroke-primary: color-mix(in srgb, var(--fg) 20%, transparent);
    --stroke-secondary: color-mix(in srgb, var(--fg) 12%, transparent);
    --stroke-tertiary: color-mix(in srgb, var(--fg) 8%, transparent);
    --amber: #D2943E;
    --radius-sm: 4px; --radius-base: 6px; --radius-lg: 8px; --radius-xl: 12px;
    --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-lg: 14px; --lh-lg: 22px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--fs-lg); line-height: var(--lh-lg); color: var(--fg); background: transparent; -webkit-font-smoothing: subpixel-antialiased; display: flex; flex-direction: column; overflow: hidden; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  #tabs { display: flex; align-items: center; gap: 4px; padding: 6px 8px 4px; overflow-x: auto; scrollbar-width: none; flex: 0 0 auto; }
  #tabs::-webkit-scrollbar { display: none; }
  .tab { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px 0 10px; border-radius: var(--radius-base); font-size: var(--fs-base); color: var(--text-secondary); white-space: nowrap; max-width: 220px; cursor: pointer; flex: 0 0 auto; }
  .tab .name { overflow: hidden; text-overflow: ellipsis; }
  .tab.active { background: var(--bg-tertiary); color: var(--fg); }
  .tab:hover { background: var(--bg-quaternary); }
  .tab .x { width: 16px; height: 16px; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-tertiary); font-size: 12px; visibility: hidden; }
  .tab:hover .x, .tab.active .x { visibility: visible; }
  .tab .x:hover { background: var(--bg-secondary); color: var(--fg); }
  .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green); }
  .tabbtn { width: 26px; height: 26px; border-radius: var(--radius-base); display: inline-flex; align-items: center; justify-content: center; color: var(--text-secondary); flex: 0 0 auto; }
  .tabbtn:hover { background: var(--bg-tertiary); color: var(--fg); }
  .tabbtn.on { color: var(--fg); background: var(--bg-tertiary); }
  .tabbtn svg { width: 15px; height: 15px; }
  #tabs .spacer { flex: 1; }
  .view { display: none; flex: 1; min-height: 0; flex-direction: column; }
  body[data-view="chat"] #chat, body[data-view="history"] #history, body[data-view="board"] #board { display: flex; }
  #messages { flex: 1; overflow: auto; padding: 8px 10px 12px; display: flex; flex-direction: column; gap: 10px; }
  body:not(.has-messages) #messages { display: none; }
  .human { align-self: flex-end; margin-left: max(32px, 20%); min-width: 150px; max-height: 120px; overflow: hidden; position: relative; background: var(--vscode-input-background); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-xl); padding: 8px 10px; white-space: pre-wrap; word-break: break-word; }
  .human.clipped::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 28px; background: linear-gradient(to bottom, transparent, var(--vscode-input-background)); border-radius: 0 0 var(--radius-xl) var(--radius-xl); }
  .assistant { word-break: break-word; }
  .assistant p { margin: 0 0 8px; }
  .assistant h1, .assistant h2, .assistant h3 { margin: 12px 0 6px; font-weight: 600; line-height: 1.3; }
  .assistant h1 { font-size: 17px; } .assistant h2 { font-size: 15px; } .assistant h3 { font-size: var(--fs-lg); }
  .assistant ul, .assistant ol { margin: 0 0 8px; padding-left: 22px; }
  .assistant li { margin: 2px 0; }
  .assistant code { background: var(--vscode-textCodeBlock-background); border-radius: var(--radius-sm); padding: 1px 4px; font-family: var(--vscode-editor-font-family); font-size: var(--fs-base); }
  .assistant .code { position: relative; margin: 8px 0; border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-base); background: var(--vscode-textCodeBlock-background); }
  .assistant .code .head { display: flex; align-items: center; height: 26px; padding: 0 10px; font-size: var(--fs-xs); color: var(--text-tertiary); border-bottom: 1px solid var(--stroke-tertiary); }
  .assistant .code .copy { margin-left: auto; color: var(--text-secondary); font-size: var(--fs-xs); }
  .assistant .code .copy:hover { color: var(--fg); }
  .assistant pre { margin: 0; padding: 8px 10px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--fs-base); line-height: 20px; }
  .assistant a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .assistant blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--stroke-primary); color: var(--text-secondary); }
  .assistant table { border-collapse: collapse; margin: 0 0 8px; font-size: var(--fs-base); }
  .assistant th, .assistant td { border: 1px solid var(--stroke-secondary); padding: 3px 8px; text-align: left; }
  .assistant hr { border: 0; border-top: 1px solid var(--stroke-secondary); margin: 10px 0; }
  .thinking { color: var(--text-tertiary); font-size: var(--fs-base); }
  .thinking summary { cursor: pointer; color: var(--text-secondary); list-style: none; }
  .thinking summary::before { content: "▸ "; }
  .thinking[open] summary::before { content: "▾ "; }
  .thinking .body { white-space: pre-wrap; font-style: italic; margin-top: 4px; }
  .error { color: var(--vscode-errorForeground); font-size: var(--fs-base); }
  .card { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-xl); background: var(--vscode-editor-background); font-size: var(--fs-base); }
  .edit { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; color: var(--text-secondary); cursor: pointer; }
  .edit:hover { background: var(--bg-quinary); }
  .edit .path { color: var(--fg); font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  .adds { color: var(--vscode-charts-green); font-variant-numeric: tabular-nums; } .dels { color: var(--vscode-charts-red); font-variant-numeric: tabular-nums; }
  .edit .state { margin-left: auto; color: var(--text-tertiary); font-size: var(--fs-xs); }
  .tool .head { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; color: var(--text-secondary); cursor: pointer; }
  .tool .head .cmd { font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool .head .status { margin-left: auto; color: var(--text-tertiary); font-size: var(--fs-xs); }
  .tool pre { display: none; margin: 0; padding: 6px 10px 8px; border-top: 1px solid var(--stroke-tertiary); max-height: 220px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); line-height: 18px; color: var(--text-secondary); white-space: pre-wrap; }
  .tool.open pre { display: block; }
  .plan { padding: 10px 12px 8px; }
  .plan .file { display: flex; align-items: center; gap: 6px; font-size: var(--fs-base); color: var(--text-secondary); margin-bottom: 6px; }
  .plan .file .icon { color: var(--text-tertiary); }
  .plan .file .name { font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  .plan h3 { margin: 4px 0 6px; font-size: 16px; font-weight: 600; }
  .plan .summary { color: var(--text-secondary); margin-bottom: 8px; }
  .plan .todos { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-lg); padding: 8px 10px; background: var(--bg-quinary); }
  .plan .todos .t { color: var(--text-tertiary); font-size: var(--fs-base); margin-bottom: 4px; }
  .plan .todo { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; font-size: var(--fs-base); }
  .plan .todo .o { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--stroke-primary); flex: 0 0 auto; margin-top: 3px; }
  .plan .todo.done .o { background: var(--vscode-charts-green); border-color: var(--vscode-charts-green); }
  .plan .todo.done { color: var(--text-tertiary); text-decoration: line-through; }
  .plan .more { color: var(--text-tertiary); font-size: var(--fs-base); padding: 3px 0 0 22px; }
  .plan .foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .plan .foot .viewplan { color: var(--text-secondary); font-size: var(--fs-base); }
  .plan .foot .viewplan:hover { color: var(--fg); }
  .plan .foot .spacer { flex: 1; }
  .btn { height: 24px; padding: 0 9px; border-radius: var(--radius-base); font-size: var(--fs-sm); display: inline-flex; align-items: center; gap: 6px; }
  .btn.amber { background: var(--amber); color: #1a1a1a; font-weight: 500; }
  .btn.amber kbd { font-family: inherit; opacity: .7; }
  .btn.text { color: var(--text-secondary); } .btn.text:hover { color: var(--fg); background: var(--bg-quaternary); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #review { display: none; margin: 0 10px; border: 1px solid var(--stroke-secondary); border-bottom: 0; border-radius: var(--radius-xl) var(--radius-xl) 0 0; background: var(--vscode-input-background); font-size: var(--fs-base); }
  body.reviewing #review { display: block; }
  body.reviewing #composer { margin-top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
  #review .head { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; cursor: pointer; }
  #review .chev { color: var(--text-tertiary); font-size: 10px; width: 10px; }
  #review .files { display: none; border-top: 1px solid var(--stroke-tertiary); padding: 4px 0; }
  #review.open .files { display: block; }
  #review .file { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 10px; cursor: pointer; }
  #review .file:hover { background: var(--bg-quaternary); }
  #review .file .name { font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  #review .file .dir { color: var(--text-tertiary); font-size: var(--fs-xs); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status { display: none; align-items: center; justify-content: space-between; padding: 0 12px 6px; font-size: var(--fs-base); color: var(--text-secondary); }
  body.running #status { display: flex; }
  #status .stop { cursor: pointer; } #status .stop kbd { font-family: inherit; color: var(--text-tertiary); margin-left: 6px; }
  #composer { margin: 8px 10px 10px; background: var(--vscode-input-background); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-xl); padding: 10px 12px 8px; position: relative; flex: 0 0 auto; }
  #composer:focus-within { border-color: var(--stroke-primary); }
  body:not(.has-messages)[data-view="chat"] #composer { order: -1; }
  #input { width: 100%; min-height: 84px; max-height: 240px; resize: none; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: var(--fs-lg); line-height: var(--lh-lg); padding: 0; }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .bar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; border-radius: var(--radius-base); font-size: var(--fs-sm); color: var(--fg); cursor: pointer; white-space: nowrap; }
  .pill:hover { background: var(--bg-tertiary); }
  .pill.mode { background: var(--bg-secondary); }
  .pill.mode.plan { background: color-mix(in srgb, var(--amber) 24%, transparent); color: var(--amber); }
  .pill .chev { font-size: 9px; opacity: .7; }
  .pill.model, .pill.access { color: var(--text-secondary); }
  .pill.model:hover, .pill.access:hover { color: var(--fg); }
  .spacer { flex: 1; }
  .icon { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-base); color: var(--fg); cursor: pointer; }
  .icon:hover { background: var(--bg-tertiary); }
  .icon svg { width: 16px; height: 16px; }
  .send { background: var(--fg); color: var(--vscode-editor-background); border-radius: 9999px; width: 24px; height: 24px; display: none; align-items: center; justify-content: center; cursor: pointer; }
  body.dirty .send { display: inline-flex; } body.running .send { display: none; }
  .menu { position: fixed; top: 0; left: 0; visibility: hidden; min-width: 220px; max-width: 320px; max-height: 320px; overflow: auto; background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-lg); box-shadow: 0 6px 24px var(--vscode-widget-shadow); padding: 4px; z-index: 20; display: none; font-size: var(--fs-base); }
  .menu.open { display: block; visibility: visible; }
  .menu .group { padding: 6px 10px 2px; font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: .3px; }
  .menu .item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: var(--radius-sm); cursor: pointer; }
  .menu .item:hover { background: var(--bg-tertiary); }
  .menu .item .ic { width: 16px; text-align: center; color: var(--text-secondary); }
  .menu .item .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu .item .sub { color: var(--text-tertiary); font-size: var(--fs-xs); margin-left: 6px; white-space: nowrap; }
  .menu .item .check { width: 14px; color: var(--fg); visibility: hidden; }
  .menu .item.on .check { visibility: visible; }
  .menu .item .kbd { color: var(--text-tertiary); font-size: var(--fs-xs); }
  .menu .sep { border-top: 1px solid var(--stroke-tertiary); margin: 4px 0; }
  .menu .note { padding: 6px 10px; color: var(--text-tertiary); font-size: var(--fs-xs); }
  #history { padding: 4px 10px 10px; gap: 6px; }
  #hsearch { height: 30px; border: 1px solid var(--stroke-secondary); border-radius: var(--radius-lg); background: var(--vscode-input-background); color: var(--fg); padding: 0 10px; font: inherit; font-size: var(--fs-base); outline: none; }
  #hlist { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .h { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-base); cursor: pointer; }
  .h:hover { background: var(--bg-quaternary); }
  .h .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-base); }
  .h .meta { color: var(--text-tertiary); font-size: var(--fs-xs); white-space: nowrap; }
  .h .pin { color: var(--text-tertiary); width: 18px; text-align: center; visibility: hidden; }
  .h:hover .pin, .h.pinned .pin { visibility: visible; } .h.pinned .pin { color: var(--amber); }
  .live { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green); display: inline-block; }
  .hsec { color: var(--text-tertiary); font-size: var(--fs-xs); padding: 8px 8px 2px; text-transform: uppercase; letter-spacing: .3px; }
  #board { padding: 4px 10px 10px; gap: 8px; }
  #bcols { flex: 1; display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 8px; overflow: auto; }
  .col { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-lg); background: var(--bg-quinary); display: flex; flex-direction: column; min-height: 120px; }
  .col .ct { padding: 6px 10px; font-size: var(--fs-xs); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: .3px; display: flex; gap: 6px; }
  .col .cards { padding: 0 6px 6px; display: flex; flex-direction: column; gap: 6px; }
  .kcard { border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-base); background: var(--vscode-editor-background); padding: 6px 8px; font-size: var(--fs-base); cursor: pointer; }
  .kcard:hover { border-color: var(--stroke-primary); }
  .kcard .sub { color: var(--text-tertiary); font-size: var(--fs-xs); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .kcard .acts { display: none; gap: 4px; margin-top: 6px; } .kcard:hover .acts { display: flex; }
  .kcard .acts .btn { height: 20px; padding: 0 6px; font-size: var(--fs-xs); background: var(--bg-tertiary); }
  #badd { height: 30px; border: 1px solid var(--stroke-secondary); border-radius: var(--radius-lg); background: var(--vscode-input-background); color: var(--fg); padding: 0 10px; font: inherit; font-size: var(--fs-base); outline: none; }
</style></head>
<body data-view="chat">
  <div id="tabs"></div>
  <div class="view" id="chat">
    <div id="messages"></div>
    <div id="review"><div class="head" id="review-head"><span class="chev">▶</span><span id="review-summary">1 file</span><span class="adds" id="review-adds">+0</span><span class="dels" id="review-dels">−0</span><span class="spacer"></span><button class="btn text" id="review-reject">Reject</button><button class="btn primary" id="review-accept">Accept</button></div><div class="files" id="review-files"></div></div>
    <div id="status"><span>Generating..</span><span class="stop" id="stop">Stop<kbd>⇧⌘⌫</kbd></span></div>
    <div id="composer">
      <textarea id="input" placeholder="Plan, search, build anything" rows="1"></textarea>
      <div class="bar">
        <span class="pill mode" id="mode-pill"><span id="mode-icon">∞</span><span id="mode-name">Agent</span><span class="chev">▼</span></span>
        <span class="pill access" id="access-pill"><span id="access-name">…</span><span class="chev">▼</span></span>
        <span class="pill model" id="model-pill"><span id="model-name">…</span><span class="chev">▼</span></span>
        <span class="spacer"></span>
        <span class="icon" title="Attach"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.5l-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"/></svg></span>
        <span class="icon" title="Dictate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>
        <span class="send" id="send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="14" height="14"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span>
      </div>
      <div class="menu" id="menu"></div>
    </div>
  </div>
  <div class="view" id="history"><input id="hsearch" placeholder="Search threads"><div id="hlist"></div></div>
  <div class="view" id="board"><input id="badd" placeholder="Add a task to the board and press Enter"><div id="bcols"></div></div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $("messages"), input = $("input"), body = document.body, menu = $("menu");
  let assistantEl = null, thinkingEl = null, planEl = null, state = null, threads = [];
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></svg>',
  };
  function inline(t) {
    return escape(t)
      .replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>")
      .replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, "$1<i>$2</i>")
      .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
  }
  function renderMarkdown(text) {
    const lines = text.split("\\n"); let html = "", i = 0, para = [];
    const flushP = () => { if (para.length) html += "<p>" + inline(para.join(" ")) + "</p>"; para = []; };
    while (i < lines.length) {
      const l = lines[i];
      const fence = /^\`\`\`(\\w*)\\s*$/.exec(l);
      if (fence) { flushP(); const lang = fence[1]; const code = []; i++; while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) code.push(lines[i++]); i++;
        html += '<div class="code"><div class="head"><span>' + escape(lang || "code") + '</span><button class="copy" data-copy>Copy</button></div><pre>' + escape(code.join("\\n")) + "</pre></div>"; continue; }
      const h = /^(#{1,3})\\s+(.*)$/.exec(l);
      if (h) { flushP(); html += "<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
      if (/^\\s*([-*]|\\d+\\.)\\s+/.test(l)) { flushP(); const ordered = /^\\s*\\d+\\./.test(l); const items = []; while (i < lines.length && /^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i])) items.push(lines[i++].replace(/^\\s*([-*]|\\d+\\.)\\s+/, ""));
        html += (ordered ? "<ol>" : "<ul>") + items.map((t) => "<li>" + inline(t.replace(/^\\[( |x)\\]\\s*/, "")) + "</li>").join("") + (ordered ? "</ol>" : "</ul>"); continue; }
      if (/^\\s*>/.test(l)) { flushP(); const q = []; while (i < lines.length && /^\\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\\s*>\\s?/, "")); html += "<blockquote>" + inline(q.join(" ")) + "</blockquote>"; continue; }
      if (/^\\s*\\|/.test(l) && /^\\s*\\|/.test(lines[i + 1] || "")) { flushP(); const rows = []; while (i < lines.length && /^\\s*\\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\\||\\|$/g, "").split("|").map((c) => c.trim()); const head = cells(rows[0]); const bodyRows = rows.slice(1).filter((r) => !/^\\s*\\|?\\s*:?-+/.test(r));
        html += "<table><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr>" + bodyRows.map((r) => "<tr>" + cells(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</table>"; continue; }
      if (/^\\s*(-{3,}|\\*{3,})\\s*$/.test(l)) { flushP(); html += "<hr>"; i++; continue; }
      if (!l.trim()) { flushP(); i++; continue; }
      para.push(l); i++;
    }
    flushP(); return html;
  }
  messages.addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) { navigator.clipboard.writeText(b.parentElement.nextElementSibling.textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); } });
  function scroll() { messages.scrollTop = messages.scrollHeight; }
  function addHuman(text) { const el = document.createElement("div"); el.className = "human"; el.textContent = text; messages.appendChild(el); if (el.scrollHeight > 120) el.classList.add("clipped"); body.classList.add("has-messages"); scroll(); }
  function addAssistant(text) { const el = document.createElement("div"); el.className = "assistant"; el.dataset.raw = text; el.innerHTML = renderMarkdown(text); messages.appendChild(el); body.classList.add("has-messages"); return el; }
  function ensureAssistant() { if (!assistantEl) assistantEl = addAssistant(""); return assistantEl; }
  function ensureThinking() { if (!thinkingEl) { thinkingEl = document.createElement("details"); thinkingEl.className = "thinking"; thinkingEl.innerHTML = "<summary>Thinking</summary><div class=body></div>"; messages.appendChild(thinkingEl); } return thinkingEl; }
  function toolEl(tool) {
    let el = document.getElementById("tool-" + tool.id);
    if (!el) { el = document.createElement("div"); el.className = "card tool"; el.id = "tool-" + tool.id; el.innerHTML = '<div class="head"><span class="t"></span><span class="cmd"></span><span class="status"></span></div><pre></pre>'; el.querySelector(".head").addEventListener("click", () => el.classList.toggle("open")); messages.appendChild(el); body.classList.add("has-messages"); }
    el.querySelector(".t").textContent = tool.title; el.querySelector(".cmd").textContent = tool.detail; el.querySelector(".status").textContent = tool.status === "running" ? "Running…" : tool.status; el.querySelector("pre").textContent = tool.output; scroll();
  }
  function planCard(card) {
    if (!planEl) { planEl = document.createElement("div"); planEl.className = "card plan"; messages.appendChild(planEl); body.classList.add("has-messages"); }
    const shown = card.todos.slice(0, 3), more = card.todos.length - shown.length;
    planEl.innerHTML = '<div class="file"><span class="icon">☰</span><span class="name">' + escape(card.path ? card.path.split("/").pop() : "plan.md") + '</span></div><h3>' + escape(card.title) + '</h3>' + (card.summary ? '<div class="summary">' + escape(card.summary) + '</div>' : "") +
      (card.todos.length ? '<div class="todos"><div class="t">' + card.todos.length + ' To-dos</div>' + shown.map((t) => '<div class="todo' + (t.done ? " done" : "") + '"><span class="o"></span><span>' + escape(t.text) + '</span></div>').join("") + (more > 0 ? '<div class="more">··· ' + more + ' more</div>' : "") + '</div>' : "") +
      '<div class="foot"><button class="viewplan" id="plan-view">View Plan</button><span class="spacer"></span><button class="btn amber" id="plan-build">Build <kbd>⌘⏎</kbd></button></div>';
    planEl.querySelector("#plan-view").addEventListener("click", () => vscode.postMessage({ type: "viewPlan" }));
    planEl.querySelector("#plan-build").addEventListener("click", () => vscode.postMessage({ type: "buildPlan" }));
    scroll();
  }
  function editCard(card) {
    const id = "edit-" + card.path.replace(/[^a-z0-9]/gi, "_"); let el = document.getElementById(id);
    if (!el) { el = document.createElement("div"); el.className = "card edit"; el.id = id; el.addEventListener("click", () => vscode.postMessage({ type: "open", path: card.path })); messages.appendChild(el); body.classList.add("has-messages"); }
    const labels = { streaming: "Editing…", written: "Review", kept: "Accepted", undone: "Rejected" };
    el.innerHTML = '<span class="path">' + escape(card.path) + '</span><span class="adds">+' + card.adds + '</span><span class="dels">−' + card.dels + '</span><span class="state">' + labels[card.status] + '</span>'; scroll();
  }
  function renderMessages(list) {
    messages.innerHTML = ""; assistantEl = thinkingEl = planEl = null; body.classList.toggle("has-messages", list.length > 0);
    for (const m of list) {
      if (m.kind === "user") addHuman(m.text);
      else if (m.kind === "assistant") { if (m.reasoning) { const d = document.createElement("details"); d.className = "thinking"; d.innerHTML = "<summary>Thought</summary><div class=body>" + escape(m.reasoning) + "</div>"; messages.appendChild(d); } addAssistant(m.text); }
      else if (m.kind === "tool") toolEl(m);
      else if (m.kind === "plan") { planEl = null; planCard(m.card); }
    }
    scroll();
  }
  function renderTabs() {
    const t = $("tabs"); t.innerHTML = "";
    for (const tab of state.tabs) {
      const el = document.createElement("div"); el.className = "tab" + (tab.id === state.activeId ? " active" : ""); el.title = tab.name;
      el.innerHTML = (tab.running ? '<span class="dot"></span>' : "") + '<span class="name">' + escape(tab.name) + '</span><span class="x" title="Close">×</span>';
      el.addEventListener("click", (e) => { if (e.target.classList.contains("x")) vscode.postMessage({ type: "closeTab", id: tab.id }); else vscode.postMessage({ type: "activateTab", id: tab.id }); });
      t.appendChild(el);
    }
    const mk = (icon, title, on, fn) => { const b = document.createElement("button"); b.className = "tabbtn" + (on ? " on" : ""); b.title = title; b.innerHTML = icon; b.addEventListener("click", fn); return b; };
    t.appendChild(mk(ICONS.plus, "New Agent ⇧⌘L", false, () => vscode.postMessage({ type: "newAgent" })));
    const sp = document.createElement("span"); sp.className = "spacer"; t.appendChild(sp);
    t.appendChild(mk(ICONS.history, "History", state.view === "history", () => vscode.postMessage({ type: "view", view: state.view === "history" ? "chat" : "history" })));
    t.appendChild(mk(ICONS.board, "Board (Kanban)", state.view === "board", () => vscode.postMessage({ type: "view", view: state.view === "board" ? "chat" : "board" })));
  }
  function effortLabel(id) { return ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" })[id] || id; }
  function renderState() {
    body.dataset.view = state.view; renderTabs();
    const mode = state.modes.find((m) => m.id === state.settings.mode) || state.modes[0];
    $("mode-icon").textContent = mode.icon; $("mode-name").textContent = mode.name; $("mode-pill").classList.toggle("plan", mode.id === "plan");
    input.placeholder = body.classList.contains("has-messages") && mode.id === "plan" ? "Steer the plan, or add more details" : mode.placeholder;
    const access = state.access.find((a) => a.id === state.settings.accessId); $("access-name").textContent = access ? access.label : (state.loading ? "…" : "Access");
    const model = state.models.find((m) => m.id === state.settings.modelId);
    const effort = model && model.efforts.find((e) => e.id === state.settings.effortId);
    $("model-name").textContent = model ? model.name + (effort ? " " + effortLabel(effort.id) : "") : (state.loading ? "Loading models…" : "Choose model");
    body.classList.toggle("running", !!state.tabs.find((t) => t.id === state.activeId && t.running));
  }
  function placeMenu(anchor) {
    // Adaptive: below the pill when there is room, else above; clamped to the pane.
    const a = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    menu.style.maxHeight = Math.max(120, Math.max(vh - a.bottom - 12, a.top - 12)) + "px";
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const below = vh - a.bottom - 8, above = a.top - 8;
    const top = (h <= below || below >= above) ? Math.min(a.bottom + 4, vh - h - 4) : Math.max(4, a.top - h - 4);
    const left = Math.max(6, Math.min(a.left, vw - w - 6));
    menu.style.top = top + "px"; menu.style.left = left + "px";
  }
  let menuAnchor = null;
  function openMenu(kind, anchor) {
    if (menu.dataset.kind === kind && menu.classList.contains("open")) { closeMenu(); return; }
    menuAnchor = anchor;
    menu.dataset.kind = kind; menu.innerHTML = ""; const add = (html) => menu.insertAdjacentHTML("beforeend", html);
    if (kind === "mode") {
      for (const m of state.modes) add('<div class="item' + (m.id === state.settings.mode ? " on" : "") + '" data-id="' + escape(m.id) + '"><span class="ic">' + escape(m.icon) + '</span><span class="lbl">' + escape(m.name) + '</span><span class="check">✓</span></div>');
      add('<div class="sep"></div><div class="note">⌘. cycles modes · custom modes: settings → muster.modes</div>');
      menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setMode", id: el.dataset.id }); closeMenu(); }));
    } else if (kind === "access") {
      if (!state.access.length) add('<div class="note">' + (state.loading ? "Loading access modes from Codex…" : "No access modes reported by Codex (permissionProfile/list)") + '</div>');
      for (const a of state.access) add('<div class="item' + (a.id === state.settings.accessId ? " on" : "") + '" data-id="' + escape(a.id) + '"><span class="lbl">' + escape(a.label) + '</span><span class="sub">' + escape(a.sandbox) + ' · ' + escape(a.approvalPolicy) + '</span><span class="check">✓</span></div>');
      menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setAccess", id: el.dataset.id }); closeMenu(); }));
    } else if (kind === "model") {
      if (!state.models.length) add('<div class="note">' + (state.loading ? "Loading models from Codex…" : "No models reported (model/list). Is Codex signed in?") + '</div>');
      for (const [prov, title] of [["codex", "Codex · ChatGPT plan"], ["claude", "Claude Code · Claude subscription"]]) { const ms = state.models.filter((m) => m.provider === prov); if (!ms.length) continue; add('<div class="group">' + title + '</div>');
        for (const m of ms) add('<div class="item' + (m.id === state.settings.modelId ? " on" : "") + '" data-id="' + escape(m.id) + '" title="' + escape(m.description) + '"><span class="lbl">' + escape(m.name) + '</span>' + (m.isDefault ? '<span class="sub">default</span>' : "") + '<span class="check">✓</span></div>'); }
      const model = state.models.find((m) => m.id === state.settings.modelId);
      if (model && model.efforts.length) { add('<div class="sep"></div><div class="group">Effort · ' + escape(model.name) + '</div>'); for (const e of model.efforts) add('<div class="item' + (e.id === state.settings.effortId ? " on" : "") + '" data-effort="' + escape(e.id) + '" title="' + escape(e.description) + '"><span class="lbl">' + effortLabel(e.id) + '</span><span class="check">✓</span></div>'); }
      menu.querySelectorAll(".item[data-id]").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setModel", id: el.dataset.id }); setTimeout(() => { if (menuAnchor) { menu.classList.remove("open"); openMenu("model", menuAnchor); } }, 60); }));
      menu.querySelectorAll(".item[data-effort]").forEach((el) => el.addEventListener("click", () => { vscode.postMessage({ type: "setEffort", id: el.dataset.effort }); closeMenu(); }));
    }
    menu.classList.add("open");
    placeMenu(anchor);
  }
  function closeMenu() { menu.classList.remove("open"); menuAnchor = null; }
  window.addEventListener("resize", () => { if (menuAnchor) placeMenu(menuAnchor); });
  messages.addEventListener("scroll", closeMenu);
  $("mode-pill").addEventListener("click", (e) => { e.stopPropagation(); openMenu("mode", e.currentTarget); });
  $("access-pill").addEventListener("click", (e) => { e.stopPropagation(); openMenu("access", e.currentTarget); });
  $("model-pill").addEventListener("click", (e) => { e.stopPropagation(); openMenu("model", e.currentTarget); });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
    if ((e.metaKey || e.ctrlKey) && e.key === "." && state) { e.preventDefault(); const i = state.modes.findIndex((m) => m.id === state.settings.mode); vscode.postMessage({ type: "setMode", id: state.modes[(i + 1) % state.modes.length].id }); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && planEl && !body.classList.contains("running") && !input.value.trim()) vscode.postMessage({ type: "buildPlan" });
  });
  $("hsearch").addEventListener("input", renderHistory);
  function renderHistory() {
    const q = $("hsearch").value.toLowerCase(); const list = $("hlist"); list.innerHTML = "";
    const items = threads.filter((t) => !q || (t.name + " " + t.project).toLowerCase().includes(q));
    const section = (title, arr) => { if (!arr.length) return; list.insertAdjacentHTML("beforeend", '<div class="hsec">' + title + '</div>'); for (const t of arr) { const el = document.createElement("div"); el.className = "h" + (t.pinned ? " pinned" : ""); el.innerHTML = (t.live ? '<span class="live"></span>' : "") + '<span class="name">' + escape(t.name) + '</span><span class="meta">' + escape(t.project) + ' · ' + escape(t.age) + ' · ' + t.turns + ' turns</span><span class="pin" title="Pin">★</span>'; el.querySelector(".pin").addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "pin", id: t.id, pinned: !t.pinned }); }); el.addEventListener("click", () => vscode.postMessage({ type: "openThread", id: t.id })); list.appendChild(el); } };
    section("Pinned", items.filter((t) => t.pinned)); section("Threads", items.filter((t) => !t.pinned));
  }
  $("badd").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.value.trim()) { vscode.postMessage({ type: "boardAdd", title: e.target.value.trim() }); e.target.value = ""; } });
  function renderBoard(columns) {
    const root = $("bcols"); root.innerHTML = "";
    for (const c of columns) { const col = document.createElement("div"); col.className = "col"; col.innerHTML = '<div class="ct">' + escape(c.title) + '<span class="n">' + c.cards.length + '</span></div><div class="cards"></div>'; const cards = col.querySelector(".cards");
      for (const k of c.cards) { const el = document.createElement("div"); el.className = "kcard"; el.innerHTML = '<div>' + escape(k.title) + '</div><div class="sub">' + (k.running ? '<span class="live"></span> running' : escape(k.subtitle)) + '</div><div class="acts"><button class="btn" data-run>' + (k.subtitle === "thread" ? "Open" : "Run") + '</button>' + (c.id !== "done" ? '<button class="btn" data-move="' + (c.id === "backlog" ? "progress" : c.id === "progress" ? "review" : "done") + '">→</button>' : "") + '</div>';
        el.querySelector("[data-run]").addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "boardRun", id: k.id }); }); const mv = el.querySelector("[data-move]"); if (mv) mv.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "boardMove", id: k.id, column: mv.dataset.move }); }); cards.appendChild(el); }
      root.appendChild(col); }
  }
  $("review-head").addEventListener("click", (e) => { if (e.target.closest("button")) return; $("review").classList.toggle("open"); });
  $("review-accept").addEventListener("click", () => vscode.postMessage({ type: "acceptAll" }));
  $("review-reject").addEventListener("click", () => vscode.postMessage({ type: "rejectAll" }));
  function renderReview(files) {
    body.classList.toggle("reviewing", files.length > 0); if (!files.length) return;
    $("review-summary").textContent = files.length + (files.length === 1 ? " file" : " files"); $("review-adds").textContent = "+" + files.reduce((n, f) => n + f.adds, 0); $("review-dels").textContent = "−" + files.reduce((n, f) => n + f.dels, 0);
    const list = $("review-files"); list.innerHTML = "";
    for (const f of files) { const row = document.createElement("div"); row.className = "file"; const parts = f.path.split("/"); const name = parts.pop(); row.innerHTML = '<span class="name">' + escape(name) + '</span><span class="dir">' + escape(parts.join("/")) + '</span><span class="adds">+' + f.adds + '</span><span class="dels">−' + f.dels + '</span>'; row.addEventListener("click", () => vscode.postMessage({ type: "open", path: f.path })); list.appendChild(row); }
  }
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, Math.max(84, input.scrollHeight)) + "px"; body.classList.toggle("dirty", input.value.trim().length > 0); }
  function send() { const text = input.value.trim(); if (!text || body.classList.contains("running")) return; vscode.postMessage({ type: "send", text }); input.value = ""; autosize(); }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); } });
  $("send").addEventListener("click", send);
  $("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "state") { state = m; renderState(); }
    else if (m.type === "messages") { renderMessages(m.messages); if (state) renderState(); }
    else if (m.type === "user") { assistantEl = thinkingEl = null; addHuman(m.text); if (state) renderState(); }
    else if (m.type === "start") { body.classList.add("running"); }
    else if (m.type === "reasoning") { const t = ensureThinking(); t.querySelector(".body").textContent += m.text; scroll(); }
    else if (m.type === "delta") { const a = ensureAssistant(); a.dataset.raw += m.text; a.innerHTML = renderMarkdown(a.dataset.raw); scroll(); }
    else if (m.type === "tool") { toolEl(m.tool); }
    else if (m.type === "plan") { planCard(m.card); }
    else if (m.type === "edit") { editCard(m.card); }
    else if (m.type === "review") { renderReview(m.files); }
    else if (m.type === "threads") { threads = m.items; renderHistory(); }
    else if (m.type === "board") { renderBoard(m.columns); }
    else if (m.type === "done") { body.classList.remove("running"); if (thinkingEl) thinkingEl.querySelector("summary").textContent = "Thought"; if (!m.ok) { const e = document.createElement("div"); e.className = "error"; e.textContent = m.error || "Failed"; messages.appendChild(e); } assistantEl = thinkingEl = null; scroll(); }
  });
  autosize();
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
