// Muster Code — the built-in Muster layer. Codex-first: the Agent pane (the
// Cursor-standard surface, secondary sidebar), Codex threads as chat sessions,
// the default chat participant + models (native chat kept as plumbing for
// inline chat / chat editing), and Cursor's status-bar cluster.
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { cachedQuery, callOwnedThread, formatAge, formatSize, interruptTurn, listThreads, prefetchCatalog, readHistory, runTurn, setBrowserMcp, setDisabledMcpServers, threadsForWorkspace, turnHooks, type CodexThread, useCatalogStore } from "./codex.js";
import { BrowserToolServer } from "./browser-tools.js";
import { join as joinPath } from "node:path";
import { AgentPane } from "./agent-pane.js";
import { LiveEditController } from "./live-edit.js";
import { startDevControl } from "./dev-control.js";
import { completionsSnoozedFor, registerCompletions, snoozeCompletions } from "./completions.js";
import { PlanEditorProvider } from "./plan-editor.js";
import { refreshMentionIndex, setBrowserProvider, watchTerminals } from "./context.js";
import { SettingsPage } from "./settings-page.js";
import { BrowserController } from "./browser.js";
import { queryCodex } from "./codex.js";
import { TerminalWorkspace } from "./terminal-workspace.js";
import { handoffThread, ThreadCatalog, ThreadCatalogError, type ThreadListOptions, type ThreadRead, type ThreadRecord } from "./thread-catalog.js";
import { NavigationHub } from "./navigation.js";
import { registerWorkspaceHub } from "./workspace-hub.js";

const SESSION_TYPE = "codex";
const SESSION_SCHEME = "muster-codex";
const PARTICIPANT_ID = "muster.agent";

const CODEX_MODELS = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", detail: "Best for everyday, complex tasks" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", detail: "Deeper reasoning" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", detail: "Most capable, slowest" },
  { id: "gpt-5.5", name: "GPT-5.5", detail: "Previous generation" },
] as const;

let threadsCache: CodexThread[] = [];
const output = vscode.window.createOutputChannel("Muster", { log: true });

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  useCatalogStore(context.globalState);
  if (vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") === "Muster Dark") {
    void vscode.workspace.getConfiguration("workbench").update("colorTheme", "Muster Graphite", vscode.ConfigurationTarget.Global);
  }
  setTimeout(() => prefetchCatalog(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()), 1500);
  setTimeout(() => refreshMentionIndex(), 2500); // the @ file index, so the first popover is instant
  const config = () => vscode.workspace.getConfiguration("muster");
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const effort = () => (config().get<string>("codex.effort") as "low" | "medium" | "high" | "xhigh" | "max" | "ultra") ?? "medium";

  // ── Default chat participant (plumbing for inline chat / chat editing) ──
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const threadId = threadIdForRequest(request);
    const thread = threadsCache.find((item) => item.id === threadId);
    const cwd = thread?.cwd ?? workspaceCwd();
    stream.progress(thread ? `Continuing ${thread.name}` : "Thinking");
    const cancel = token.onCancellationRequested(() => { void interruptTurn(); });
    try {
      const result = await runTurn({
        prompt: request.prompt,
        cwd,
        ...(threadId ? { threadId } : {}),
        model: config().get<string>("codex.model") ?? "gpt-5.6-sol",
        reasoning: effort(),
        handlers: {
          onDelta: (text) => stream.markdown(text),
          onReasoning: (text) => {
            (stream as unknown as { thinkingProgress?: (d: { text: string; id: string }) => void }).thinkingProgress?.({ text, id: "codex-reasoning" });
          },
          onEvent: (method, params) => live.onEvent(method, params),
        },
      });
      if (result.status === "failed") {
        stream.warning(result.errorMessage ?? "The turn failed.");
        return { errorDetails: { message: result.errorMessage ?? "failed" } };
      }
      if (result.threadId && !threadId) void refreshThreads();
      return { metadata: { threadId: result.threadId ?? threadId, tokens: result.tokenUsage } };
    } finally {
      cancel.dispose();
    }
  };
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "muster.svg");
  context.subscriptions.push(participant);

  // ── Codex threads as chat sessions (by the app's own names) ──
  const controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => {
    await refreshThreads();
    controller.items.replace(threadsCache.map((thread) => {
      const item = controller.createChatSessionItem(sessionUri(thread.id), thread.name);
      item.description = `${thread.project} · ${formatAge(thread.lastActivityAt)} · ${thread.turnCount} turns · ${formatSize(thread.sizeBytes)}`;
      item.status = thread.live ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
      item.tooltip = thread.cwd;
      return item;
    }));
  });
  context.subscriptions.push(controller);

  context.subscriptions.push(vscode.chat.registerChatSessionContentProvider(SESSION_SCHEME, {
    async provideChatSessionContent(resource) {
      const threadId = resource.path.replace(/^\//, "");
      const thread = threadsCache.find((item) => item.id === threadId) ?? (await refreshThreads()).find((item) => item.id === threadId);
      const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [];
      if (thread) {
        for (const message of await readHistory(thread)) {
          if (message.role === "user") {
            history.push(new vscode.ChatRequestTurn2(message.text, undefined, [], PARTICIPANT_ID, [], undefined, undefined, undefined, undefined) as unknown as vscode.ChatRequestTurn);
          } else {
            history.push(new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(message.text)], {}, PARTICIPANT_ID));
          }
        }
      }
      return {
        ...(thread ? { title: thread.name } : {}),
        history,
        requestHandler: handler,
      } satisfies vscode.ChatSession;
    },
  }, participant, { supportsInterruptions: true }));

  // ── Codex models in the native model picker ──
  const modelProvider: vscode.LanguageModelChatProvider = {
    provideLanguageModelChatInformation() {
      const active = config().get<string>("codex.model") ?? "gpt-5.6-sol";
      return CODEX_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        family: "codex",
        version: "5.6",
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        tooltip: model.detail,
        detail: "ChatGPT plan · Codex",
        isDefault: model.id === active,
        isUserSelectable: true,
        capabilities: { toolCalling: true, imageInput: true },
      }));
    },
    async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
      const prompt = messages.map((message) => message.content.map(partText).join("")).join("\n\n");
      const cancel = token.onCancellationRequested(() => { void interruptTurn(); });
      try {
        await runTurn({
          prompt,
          cwd: workspaceCwd(),
          model: model.id,
          handlers: { onDelta: (text) => progress.report(new vscode.LanguageModelTextPart(text)), onReasoning: () => {} },
        });
      } finally {
        cancel.dispose();
      }
    },
    provideTokenCount: (_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage) =>
      Promise.resolve(Math.ceil((typeof text === "string" ? text : text.content.map(partText).join("")).length / 4)),
  };
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("muster", modelProvider));

  // ── Live edits (Cursor-style streaming inline diffs) ──
  const live = new LiveEditController(workspaceCwd, (line) => output.appendLine(line));
  live.register(context);
  startDevControl(context, { live, log: (line) => output.appendLine(line), settings: () => settings, pane: { debugState: () => pane.debugState(), debugInput: (text) => pane.debugInput(text), debugSend: (text) => pane.debugSend(text), debugStop: () => pane.debugStop(), debugEdit: (cp, text) => pane.debugEdit(cp, text), debugDecide: (id, d) => pane.debugDecide(id, d), debugRequest: (m, p) => pane.debugRequest(m, p), debugSuggest: (kind, query, mode) => pane.debugSuggest(kind, query, mode), debugThreads: () => pane.debugThreads(), harness: (input) => pane.harness(input) } });

  // ── The Agent pane (secondary sidebar) — the Cursor-standard surface ──
  const pane = new AgentPane(context, output, live);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPane.viewId, pane, { webviewOptions: { retainContextWhenHidden: true } }));
  registerWorkspaceHub(context, { sourceRoot: workspaceCwd });
  const navigation = new NavigationHub({
    getCommands: (all = true) => vscode.commands.getCommands(all),
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  });
  context.subscriptions.push(vscode.commands.registerCommand("muster.navigation.goTo", () => navigation.open()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.new", () => pane.newAgent()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.history", () => pane.showHistory()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.board", () => pane.showBoard()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.mode", () => pane.cycleMode()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.tab", (args: { id: string }) => pane.activateTab(args.id)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.addSelection", () => { const editor = vscode.window.activeTextEditor; if (editor) void pane.addSelection(editor); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.closeTab", (args: { id: string }) => pane.closeTab(args.id)));
  // ⌘K: edit the selection (or the file) with the agent; the change streams in as the inline diff.
  context.subscriptions.push(vscode.commands.registerCommand("muster.cmdk", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    try {
      await vscode.commands.executeCommand("muster.cmdk.show", { uri: editor.document.uri.toString(), line: editor.selection.start.line + 1 });
    } catch {
      const instruction = await vscode.window.showInputBox({ prompt: "Edit with the agent", placeHolder: "Describe the change · Enter to generate · Esc to cancel", ignoreFocusOut: true });
      if (instruction?.trim()) await pane.inlineEdit(editor, instruction.trim());
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.cmdk.submit", async (args: { uri: string; instruction: string; quick?: boolean }) => {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === args.uri) ?? vscode.window.activeTextEditor;
    if (!editor) return;
    if (args.quick) { await vscode.commands.executeCommand("muster.cmdk.hide", { uri: args.uri }); await pane.askSelection(editor, args.instruction); return; }
    try { await pane.inlineEdit(editor, args.instruction); } finally { await vscode.commands.executeCommand("muster.cmdk.hide", { uri: args.uri }); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.plugins", () => pane.showPlugins()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.review.git", () => pane.reviewAgainstBranch()));
  // Terminal ⌘K: describe the command, the agent writes it into the terminal (not run until you press Enter).
  context.subscriptions.push(vscode.commands.registerCommand("muster.cmdk.terminal", async () => {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) return;
    const instruction = await vscode.window.showInputBox({ prompt: "Command instructions", placeHolder: "Describe the command to run in this terminal" });
    if (!instruction?.trim()) return;
    let text = "";
    const status = vscode.window.setStatusBarMessage("$(sync~spin) Writing command…");
    try {
      const result = await runTurn({ prompt: `Reply with ONLY a single shell command (zsh on macOS, no prose, no fences) that does: ${instruction.trim()}. Working directory: ${workspaceCwd()}.`, cwd: workspaceCwd(), reasoning: "low", access: { id: ":read-only", label: "Read only", sandbox: "read-only", approvalPolicy: "never" }, handlers: { onDelta: (d) => { text += d; }, onReasoning: () => {} } });
      if (result.status === "failed") { void vscode.window.showWarningMessage(result.errorMessage ?? "Could not write the command."); return; }
      const command = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").trim().split("\n")[0] ?? "";
      if (command) terminal.sendText(command, false);
    } finally { status.dispose(); }
  }));
  registerCompletions(context, workspaceCwd, () => config().get<string>("codex.model"));
  watchTerminals(context);
  const terminalWorkspace = new TerminalWorkspace(context, workspaceCwd, () => config().get<number>("terminal.maxOutputBytes", 40_000));
  context.subscriptions.push(terminalWorkspace);
  const terminalContext = (): { taskId?: string; taskLabel?: string; cwd?: string } => {
    const provider = pane as AgentPane & { terminalContext?: () => { taskId?: string; taskLabel?: string; cwd?: string } };
    const value = provider.terminalContext?.();
    return value && typeof value === "object" ? value : {};
  };
  const terminalArgs = (args?: Parameters<TerminalWorkspace["open"]>[0]): Parameters<TerminalWorkspace["open"]>[0] => ({ ...terminalContext(), ...(args ?? {}) });
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.workspace", () => terminalWorkspace.openInteractive(terminalArgs())));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.list", (args?: { includeClosed?: boolean }) => args ? terminalWorkspace.list(args.includeClosed !== false) : terminalWorkspace.listInteractive()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.open", (args?: Parameters<TerminalWorkspace["open"]>[0]) => args ? terminalWorkspace.open(terminalArgs(args)) : terminalWorkspace.openInteractive(terminalArgs())));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.create", (args?: Parameters<TerminalWorkspace["create"]>[0]) => terminalWorkspace.create(terminalArgs(args))));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.reveal", (args?: { id?: string }) => terminalWorkspace.revealInteractive(args?.id)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.output", (args?: { id?: string; maxChars?: number }) => terminalWorkspace.outputInteractive(args?.id, args?.maxChars)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.search", (args?: { id?: string; query?: string; limit?: number; caseSensitive?: boolean }) => args?.id && args.query ? terminalWorkspace.search(args.id, args.query, { ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }) }) : terminalWorkspace.searchInteractive(args?.id, args?.query)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.send", (args?: { id?: string; text?: string; execute?: boolean }) => args?.id && args.text ? terminalWorkspace.send(args.id, args.text, args.execute === true) : terminalWorkspace.sendInteractive(args?.id)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.terminal.close", (args?: { id?: string }) => terminalWorkspace.closeInteractive(args?.id)));
  // Codex status (Cursor shows plan/usage in its chrome): plan + the primary rate-limit window, refreshed periodically and on account events.
  const codexItem = vscode.window.createStatusBarItem("muster.codex", vscode.StatusBarAlignment.Right, 61);
  codexItem.command = "muster.agent.plugins";
  const renderLimits = (limits: Record<string, unknown> | undefined, plan: string) => {
    const primary = (limits?.primary ?? null) as { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
    const secondary = (limits?.secondary ?? null) as { usedPercent?: number; windowDurationMins?: number } | null;
    const window = (m?: number) => (!m ? "" : m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`);
    const parts = [primary ? `${primary.usedPercent ?? 0}% / ${window(primary.windowDurationMins)}` : "", secondary ? `${secondary.usedPercent ?? 0}% / ${window(secondary.windowDurationMins)}` : ""].filter(Boolean);
    codexItem.text = `$(hubot) Codex ${plan ? plan[0]!.toUpperCase() + plan.slice(1) : ""}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
    codexItem.tooltip = primary?.resetsAt ? `Codex ${plan} · ${primary.usedPercent ?? 0}% of the ${window(primary.windowDurationMins)} window used · resets ${new Date(primary.resetsAt * 1000).toLocaleString()}` : "Codex account";
    codexItem.show();
  };
  const refreshCodexStatus = async () => {
    try {
      const account = (await queryCodex("account/read", {}, workspaceCwd())).account as { planType?: string } | undefined;
      const limits = (await cachedQuery("account/rateLimits/read", {}, workspaceCwd(), { ttlMs: 9 * 60_000 })).rateLimits as Record<string, unknown> | undefined;
      renderLimits(limits, account?.planType ?? "");
    } catch { codexItem.text = "$(hubot) Codex: sign in"; codexItem.show(); }
  };
  void refreshCodexStatus();
  const statusTimer = setInterval(() => void refreshCodexStatus(), 10 * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) }, codexItem);
  pane.onAccountEvent((params) => { const limits = (params.rateLimits ?? params) as Record<string, unknown>; renderLimits(limits, String((limits.planType as string | undefined) ?? "")); });
  // Cursor's status-bar Tab item: toggle, snooze, per-language, settings.
  const refreshTab = () => { const on = config().get<boolean>("completions.enabled", false); const left = completionsSnoozedFor(); tabItem.text = !on ? "Muster Tab: off" : left > 0 ? `Muster Tab: snoozed ${Math.ceil(left / 60_000)}m` : "Muster Tab"; };
  context.subscriptions.push(vscode.commands.registerCommand("muster.completions.toggle", async () => {
    const on = !config().get<boolean>("completions.enabled", false);
    await config().update("completions.enabled", on, vscode.ConfigurationTarget.Global);
    refreshTab();
    void vscode.window.setStatusBarMessage(on ? "Muster Tab on — Codex completes as you pause" : "Muster Tab off", 2500);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.completions.snooze", async (minutes?: number) => {
    const pick = typeof minutes === "number" ? String(minutes) : (await vscode.window.showQuickPick([{ label: "15 minutes", value: "15" }, { label: "1 hour", value: "60" }, { label: "Until tomorrow", value: "720" }, { label: "Resume now", value: "0" }], { placeHolder: "Snooze Muster Tab" }))?.value;
    if (pick === undefined) return;
    snoozeCompletions(Number(pick) * 60_000); refreshTab();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.completions.menu", async () => {
    const on = config().get<boolean>("completions.enabled", false); const lang = vscode.window.activeTextEditor?.document.languageId;
    const disabled = config().get<string[]>("completions.disabledLanguages", ["markdown", "plaintext"]);
    const items = [
      { label: on ? "$(circle-slash) Turn off Muster Tab" : "$(check) Turn on Muster Tab", act: "toggle" },
      ...(on ? [{ label: completionsSnoozedFor() > 0 ? "$(debug-start) Resume" : "$(clock) Snooze…", act: completionsSnoozedFor() > 0 ? "resume" : "snooze" }] : []),
      ...(lang ? [{ label: disabled.includes(lang) ? `$(check) Enable for ${lang}` : `$(circle-slash) Disable for ${lang}`, act: "lang" }] : []),
      { label: config().get<boolean>("completions.nextEdit", true) ? "$(circle-slash) Turn off next-edit prediction" : "$(check) Turn on next-edit prediction", act: "next" },
      { label: "$(gear) Settings", act: "settings" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Muster Tab" }); if (!pick) return;
    if (pick.act === "toggle") await vscode.commands.executeCommand("muster.completions.toggle");
    else if (pick.act === "snooze") await vscode.commands.executeCommand("muster.completions.snooze");
    else if (pick.act === "resume") { snoozeCompletions(0); refreshTab(); }
    else if (pick.act === "lang" && lang) await config().update("completions.disabledLanguages", disabled.includes(lang) ? disabled.filter((l) => l !== lang) : [...disabled, lang], vscode.ConfigurationTarget.Global);
    else if (pick.act === "next") await config().update("completions.nextEdit", !config().get<boolean>("completions.nextEdit", true), vscode.ConfigurationTarget.Global);
    else if (pick.act === "settings") await vscode.commands.executeCommand("workbench.action.openSettings", "muster.completions");
  }));
  const tabTimer = setInterval(refreshTab, 30_000); context.subscriptions.push({ dispose: () => clearInterval(tabTimer) });
  context.subscriptions.push(vscode.commands.registerCommand("muster.plan.preview", (uri?: vscode.Uri) => { const target = uri ?? vscode.window.activeTextEditor?.document.uri; if (target) return vscode.commands.executeCommand("vscode.openWith", target, "muster.planEditor"); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.plan.build", (uri?: vscode.Uri) => { const active = planEditors.active(); if (!uri && active) { void pane.buildFromFile(active.uri, { ...(active.selection.length ? { todos: active.selection } : {}), ...(active.model ? { model: active.model } : {}) }); return; } const target = uri ?? vscode.window.activeTextEditor?.document.uri; if (target) void pane.buildFromFile(target); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.plan.model", async () => { const id = await pane.pickBuildModel(); if (id) planEditors.setModel(id); }));
  const planEditors = new PlanEditorProvider({
    models: () => pane.catalog().models,
    currentModel: () => pane.catalog().model,
    build: (request) => pane.buildFromFile(request.uri, { ...(request.todos ? { todos: request.todos } : {}), ...(request.model ? { model: request.model } : {}), ...(request.newThread ? { newThread: true } : {}) }),
  });
  pane.onCatalog(() => planEditors.refreshAll());
  context.subscriptions.push(vscode.commands.registerCommand("muster.plan.previewMenu", async () => {
    const pick = await vscode.window.showQuickPick([{ label: "$(check) Preview", id: "preview" }, { label: "Markdown source", id: "source" }], { placeHolder: "Plan view" });
    const active = planEditors.active();
    if (pick?.id === "source" && active) await vscode.commands.executeCommand("vscode.openWith", active.uri, "default");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.plan.buildMenu", async () => {
    const active = planEditors.active();
    if (!active) return;
    const pick = await vscode.window.showQuickPick([{ label: "Build in this thread", description: "⌘⏎", id: "here" }, { label: "Build in a new agent thread", id: "new" }], { placeHolder: "Build" });
    if (!pick) return;
    await pane.buildFromFile(active.uri, { ...(active.selection.length ? { todos: active.selection } : {}), ...(active.model ? { model: active.model } : {}), ...(pick.id === "new" ? { newThread: true } : {}) });
  }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(PlanEditorProvider.viewType, planEditors, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  const settings = new SettingsPage(context, workspaceCwd);
  context.subscriptions.push(vscode.commands.registerCommand("muster.appearance.open", () => settings.open("appearance")));
  const threadCatalog = new ThreadCatalog({ query: (method, params, cwd) => queryCodex(method, params, cwd), callOwned: (threadId, method, params, cwd) => { const owner = (pane as AgentPane & { conversationForThread?: (id: string) => string | undefined }).conversationForThread?.(threadId); if (!owner) return Promise.resolve(undefined); return callOwnedThread(owner, threadId, method, params, cwd); } }, () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
  const catalogError = (error: unknown): void => {
    const detail = error instanceof ThreadCatalogError && error.capability ? " This app-server does not expose that capability." : "";
    void vscode.window.showErrorMessage(`${error instanceof Error ? error.message : String(error)}${detail}`);
  };
  const selectCatalogThread = async (options: Omit<ThreadListOptions, "cursor"> = {}): Promise<ThreadRecord | undefined> => {
    try {
      const records = await threadCatalog.listAll(options);
      if (!records.length) { void vscode.window.showInformationMessage("No Codex threads match the open workspaces and filters."); return undefined; }
      const pick = await vscode.window.showQuickPick(records.map((record) => ({ label: `${record.isPinned ? "$(pinned) " : ""}${record.name}`, description: `${record.workspaceRoot || record.cwd} · ${record.sourceKind || "thread"}`, detail: `${record.id}${record.relation.forkedFromId ? ` · fork of ${record.relation.forkedFromId}` : ""}${record.relation.spawnedParentId ? ` · spawned by ${record.relation.spawnedParentId}` : ""}`, id: record.id })), { placeHolder: "Select a Codex thread" });
      return pick ? threadCatalog.knownThread(pick.id) : undefined;
    } catch (error) { catalogError(error); return undefined; }
  };
  const resolveCatalogThread = async (id: string | undefined, options: Omit<ThreadListOptions, "cursor"> = {}): Promise<ThreadRecord | undefined> => {
    if (!id) return selectCatalogThread(options);
    const known = threadCatalog.knownThread(id); if (known) return known;
    const refreshed = await threadCatalog.listAll(options); const found = refreshed.find((record) => record.id === id);
    if (!found) throw new ThreadCatalogError(`Thread ${id} is not available in the currently open workspaces.`, "thread/read");
    return found;
  };
  const inspectCatalogThread = async (args?: { id?: string; includeTurns?: boolean }): Promise<void> => {
    try {
      const record = await resolveCatalogThread(args?.id, { includeSubagents: true });
      if (!record) return;
      const read = await threadCatalog.read(record.id, args?.includeTurns !== false);
      const metadata = { ...read.thread, relation: record.relation, workspaceRoot: record.workspaceRoot };
      const text = [`# ${record.name}`, "", `Thread ${record.id}`, `Workspace ${record.workspaceRoot || record.cwd}`, `Source ${record.sourceKind || "unknown"}`, "", "```json", JSON.stringify(metadata, null, 2), "```", ""].join("\n");
      const doc = await vscode.workspace.openTextDocument({ content: text, language: "markdown" }); await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    } catch (error) { catalogError(error); }
  };
  const openCatalogThread = async (args: { id?: string } | undefined, mode: "open" | "continue"): Promise<boolean> => {
    try {
      const record = await resolveCatalogThread(args?.id, { includeSubagents: true }); if (!record) return false;
      const read = await threadCatalog.read(record.id, true);
      await handoffThread(pane as AgentPane & { openCatalogThread?: (record: ThreadRecord, read: ThreadRead, mode: "open" | "continue") => Promise<void> }, record, read, mode);
      return true;
    } catch (error) { catalogError(error); return false; }
  };
  const searchCatalogThread = async (): Promise<ThreadRecord | undefined> => {
    const searchTerm = await vscode.window.showInputBox({ prompt: "Search Codex thread titles", placeHolder: "Optional title text" });
    if (searchTerm === undefined) return undefined;
    const archiveChoice = await vscode.window.showQuickPick([{ label: "Active threads", archived: false }, { label: "Archived threads", archived: true }, { label: "All active and archived", archived: undefined }], { placeHolder: "Thread state" });
    if (!archiveChoice) return undefined;
    const pinChoice = await vscode.window.showQuickPick([{ label: "Pinned and unpinned", isPinned: undefined }, { label: "Pinned only", isPinned: true }, { label: "Unpinned only", isPinned: false }], { placeHolder: "Pin filter" });
    if (!pinChoice) return undefined;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const cwdChoice = folders.length > 1 ? await vscode.window.showQuickPick([{ label: "All open workspaces", cwd: undefined }, ...folders.map((cwd) => ({ label: cwd, cwd }))], { placeHolder: "Workspace filter" }) : undefined;
    return selectCatalogThread({ ...(searchTerm.trim() ? { searchTerm: searchTerm.trim() } : {}), ...(archiveChoice.archived === undefined ? {} : { archived: archiveChoice.archived }), ...(pinChoice.isPinned === undefined ? {} : { isPinned: pinChoice.isPinned }), ...(cwdChoice?.cwd ? { cwd: cwdChoice.cwd } : {}) });
  };
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.catalog", () => selectCatalogThread()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.list", async (args?: ThreadListOptions) => args ? threadCatalog.listPage(args) : selectCatalogThread()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.search", () => searchCatalogThread()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.listSubagents", () => selectCatalogThread({ includeSubagents: true })));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.inspect", (args?: { id?: string; includeTurns?: boolean }) => inspectCatalogThread(args)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.open", (args?: { id?: string }) => openCatalogThread(args, "open")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.continue", (args?: { id?: string }) => openCatalogThread(args, "continue")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.rename", async (args?: { id?: string; name?: string }) => { try { const record = await resolveCatalogThread(args?.id); if (!record) return; const name = args?.name ?? await vscode.window.showInputBox({ prompt: "Thread name", value: record.name }); if (name === undefined) return; await threadCatalog.rename(record.id, name); void vscode.window.showInformationMessage(`Renamed thread to ${name.trim()}.`); } catch (error) { catalogError(error); } }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.pin", async (args?: { id?: string; pinned?: boolean }) => { try { const record = await resolveCatalogThread(args?.id); if (!record) return; await threadCatalog.setPinned(record.id, args?.pinned ?? !record.isPinned); void vscode.window.showInformationMessage(`${args?.pinned ?? !record.isPinned ? "Pinned" : "Unpinned"} ${record.name}.`); } catch (error) { catalogError(error); } }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.archive", async (args?: { id?: string }) => { try { const record = await resolveCatalogThread(args?.id); if (!record) return; const ok = await vscode.window.showWarningMessage(`Archive ${record.name}?`, { modal: true }, "Archive"); if (ok === "Archive") { await threadCatalog.archive(record.id); void vscode.window.showInformationMessage(`Archived ${record.name}.`); } } catch (error) { catalogError(error); } }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.unarchive", async (args?: { id?: string }) => { try { const record = await resolveCatalogThread(args?.id, { archived: true, includeSubagents: true }); if (!record) return; await threadCatalog.unarchive(record.id); void vscode.window.showInformationMessage(`Restored ${record.name}.`); } catch (error) { catalogError(error); } }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.fork", async (args?: { id?: string; lastTurnId?: string; ephemeral?: boolean }) => { try { const record = await resolveCatalogThread(args?.id, { includeSubagents: true }); if (!record) return; const fork = await threadCatalog.fork(record.id, { ...(args?.lastTurnId ? { lastTurnId: args.lastTurnId } : {}), ...(args?.ephemeral === true ? { ephemeral: true } : {}) }); if (args?.ephemeral === true) { void vscode.window.showInformationMessage(`Created ephemeral fork ${fork.id}; it is available only in the owning app-server session.`); return; } const read = await threadCatalog.read(fork.id, true); await handoffThread(pane as AgentPane & { openCatalogThread?: (record: ThreadRecord, read: ThreadRead, mode: "open" | "continue") => Promise<void> }, fork, read, "continue"); } catch (error) { catalogError(error); } }));
  setDisabledMcpServers(vscode.workspace.getConfiguration("muster").get<string[]>("mcp.disabled", []));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("muster.mcp.disabled")) setDisabledMcpServers(vscode.workspace.getConfiguration("muster").get<string[]>("mcp.disabled", [])); }));
  // Browser (⇧⌘B): a Chromium guest tab with Cursor's visual editor; picks and screenshots go to the chat.
  const browser = new BrowserController(context, workspaceCwd);
  pane.browser = browser;
  setBrowserProvider(() => { const id = browser.activeEditorBrowser() ?? pane.activeBrowserId() ?? browser.list()[0]?.id; const st = id ? browser.get(id) : undefined; return st ? { url: st.url, title: st.title, console: st.console } : undefined; });
  browser.onChange((state) => pane.browserChanged(state));
  browser.onPick((pick) => { if (pick.imagePath || !pick.picked) void pane.addBrowserPick(pick); });
  // The browser as agent tools: Codex launches our MCP shim, which calls back into this host over a socket.
  const browserTools = new BrowserToolServer(browser, () => browser.activeEditorBrowser() ?? pane.activeBrowserId(), (url, headless) => { if (headless) return browser.open(url, "headless"); pane.openBrowserTab(url); return browser.list().at(-1); }, (line) => output.appendLine(line), () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  browserTools.start(joinPath(context.extensionPath, "browser-mcp.js")); context.subscriptions.push(browserTools);
  setBrowserMcp({ command: browserTools.launcherPath, args: [], env: {}, mcpConfig: browserTools.mcpConfigPath });
  turnHooks.start = () => browserTools.turnStarted(); turnHooks.end = () => browserTools.turnEnded();
  output.appendLine(`browser tools listening on ${browserTools.socketPath} (shim: ${browserTools.launcherPath})`);
  context.subscriptions.push(vscode.commands.registerCommand("muster.browser.openTab", async (url?: string) => { const target = typeof url === "string" ? url : await vscode.window.showInputBox({ prompt: "Open Browser", value: browser.defaultUrl(), placeHolder: "Enter URL or search..." }); if (!target) return; if (config().get<string>("browser.location", "editor") === "pane") pane.openBrowserTab(target); else browser.open(target, "editor"); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.browser.devtoolsActive", () => { const id = browser.activeEditorBrowser() ?? pane.activeBrowserId(); if (id) void vscode.commands.executeCommand("muster.browser.devtools", { id }); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.browser.reloadActive", () => { const id = browser.activeEditorBrowser() ?? pane.activeBrowserId(); if (id) browser.action(id, "reload"); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.browser.pickActive", () => { const id = browser.activeEditorBrowser() ?? pane.activeBrowserId(); if (id) browser.action(id, "pick"); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.more", () => settings.open("general")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.settings.open", (section?: "general" | "models" | "rules" | "mcp" | "skills" | "plugins" | "hooks" | "docs") => settings.open(section ?? "general")));
  // Bugbot-style review on commit: after each commit, review it read-only in the pane (setting muster.review.onCommit).
  void (async () => {
    const git = vscode.extensions.getExtension<{ getAPI(v: number): { repositories: { state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> } }[]; onDidOpenRepository: vscode.Event<unknown> } }>("vscode.git");
    const api = git ? (await git.activate()).getAPI(1) : undefined;
    if (!api) return;
    const watch = (repo: { state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> } }) => {
      let last = repo.state.HEAD?.commit;
      context.subscriptions.push(repo.state.onDidChange(() => {
        const head = repo.state.HEAD?.commit;
        if (head && last && head !== last && config().get<boolean>("review.onCommit", false)) void pane.reviewCommit(head);
        last = head;
      }));
    };
    api.repositories.forEach(watch);
    context.subscriptions.push(api.onDidOpenRepository(() => api.repositories.forEach(watch)));
  })();
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.stop", () => pane.stop()));
  // Cursor's chat keyboard surface (see docs/cursor-feature-atlas.md §2).
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.focus", () => pane.focus()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.closeActiveTab", () => pane.closeActive()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.prevTab", () => pane.stepTab(-1)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.nextTab", () => pane.stepTab(1)));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.model", () => pane.openMenu("model")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.access", () => pane.openMenu("access")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.addContext", () => pane.openMenu("context")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.fixError", () => pane.fixErrorAtCursor()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.plan.toggleMode", async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab; const input = tab?.input as { uri?: vscode.Uri; viewType?: string } | undefined; const uri = input?.uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || !/\.plan\.md$/i.test(uri.fsPath)) return;
    await vscode.commands.executeCommand("vscode.openWith", uri, input?.viewType === "muster.planEditor" ? "default" : "muster.planEditor");
  }));
  // Dictation: a command that prints transcribed text (default `hear`, Apple's on-device recognition via brew install hear); lines land in the composer.
  let dictation: import("node:child_process").ChildProcess | undefined;
  const stopDictation = () => { if (dictation) { dictation.kill(); dictation = undefined; } pane.dictation(false); };
  const startDictation = (command?: string) => {
    const cmd = command ?? config().get<string>("dictation.command", "hear");
    const child = spawn(cmd, { shell: true, cwd: workspaceCwd(), env: process.env });
    dictation = child; pane.dictation(true);
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => { buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ""; for (const l of lines) if (l.trim()) pane.dictation(true, l.trim()); });
    child.on("error", (e) => { pane.dictation(false); dictation = undefined; void vscode.window.showWarningMessage(`Dictation command failed (${e.message}). Install it (brew install hear) or set muster.dictation.command.`); });
    child.on("exit", (code) => { if (buf.trim()) pane.dictation(true, buf.trim()); if (dictation === child) { dictation = undefined; pane.dictation(false); if (code && code !== 0 && code !== 143) void vscode.window.showWarningMessage(`Dictation command exited with ${code}. Install hear (brew install hear) or set muster.dictation.command.`); } });
  };
  pane.onDictate = () => { if (dictation) stopDictation(); else startDictation(); };
  context.subscriptions.push(vscode.commands.registerCommand("muster.dictation.toggle", () => pane.onDictate?.()), { dispose: stopDictation });
  context.subscriptions.push(vscode.commands.registerCommand("muster.dictation.start", (command?: string) => { stopDictation(); startDictation(command); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.maximize", () => vscode.commands.executeCommand("workbench.action.toggleMaximizedAuxiliaryBar")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.togglePane", () => vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.resume", async (thread?: CodexThread) => {
    if (thread) await pane.openThread(thread); else await pane.pickThread();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.debug.extensionState", () => {
    output.appendLine(JSON.stringify({ threads: threadsCache.length, model: config().get("codex.model"), effort: config().get("codex.effort") }));
    output.show();
  }));

  // ── Status bar, Cursor's right cluster ──
  const tabItem = vscode.window.createStatusBarItem("muster.tab", vscode.StatusBarAlignment.Right, 60);
  tabItem.text = config().get<boolean>("completions.enabled", false) ? "Muster Tab" : "Muster Tab: off"; tabItem.tooltip = "Muster Tab — inline completions and next-edit prediction from Codex (uses your plan). Click for snooze and options."; tabItem.command = "muster.completions.menu"; tabItem.show();
  const statsItem = vscode.window.createStatusBarItem("muster.agentStats", vscode.StatusBarAlignment.Right, 59);
  statsItem.text = "$(comment-discussion) Agent Stats: 0/0 (0%)"; statsItem.tooltip = "Turns this session"; statsItem.show();
  context.subscriptions.push(tabItem, statsItem);

  await refreshThreads();
  output.appendLine(`Muster activated · ${threadsCache.length} Codex threads`);
  // Cursor opens with its agent pane, not VS Code's chat: make ours the secondary sidebar's view on startup.
  void vscode.commands.executeCommand("muster.evictBuiltinChat").then(undefined, () => undefined);
  void vscode.commands.executeCommand("workbench.view.extension.muster-agent");

  async function refreshThreads(): Promise<CodexThread[]> {
    try {
      threadsCache = threadsForWorkspace(await listThreads(), (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    } catch (error) {
      output.appendLine(`thread discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return threadsCache;
  }
}

export function deactivate(): void {}

function partText(part: unknown): string {
  return part instanceof vscode.LanguageModelTextPart ? part.value : "";
}

function sessionUri(threadId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SESSION_SCHEME, path: `/${threadId}` });
}

function threadIdForRequest(request: vscode.ChatRequest): string | undefined {
  const resource = (request as unknown as { sessionResource?: vscode.Uri }).sessionResource
    ?? (request as unknown as { resourceUri?: vscode.Uri }).resourceUri;
  if (resource?.scheme === SESSION_SCHEME) return resource.path.replace(/^\//, "");
  return undefined;
}
