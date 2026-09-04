// Muster Code — the built-in Muster layer. Codex-first: the Agent pane (the
// Cursor-standard surface, secondary sidebar), Codex threads as chat sessions,
// the default chat participant + models (native chat kept as plumbing for
// inline chat / chat editing), and Cursor's status-bar cluster.
import * as vscode from "vscode";
import { formatAge, formatSize, interruptTurn, listThreads, readHistory, runTurn, setBrowserMcp, threadsForWorkspace, turnHooks, type CodexThread } from "./codex.js";
import { BrowserToolServer } from "./browser-tools.js";
import { join as joinPath } from "node:path";
import { AgentPane } from "./agent-pane.js";
import { LiveEditController } from "./live-edit.js";
import { startDevControl } from "./dev-control.js";
import { registerCompletions } from "./completions.js";
import { PlanEditorProvider } from "./plan-editor.js";
import { watchTerminals, setBrowserProvider } from "./context.js";
import { SettingsPage } from "./settings-page.js";
import { BrowserController } from "./browser.js";
import { queryCodex } from "./codex.js";

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
  startDevControl(context, { live, log: (line) => output.appendLine(line), pane: { debugState: () => pane.debugState(), debugInput: (text) => pane.debugInput(text), debugSend: (text) => pane.debugSend(text), debugStop: () => pane.debugStop(), debugEdit: (cp, text) => pane.debugEdit(cp, text), debugDecide: (id, d) => pane.debugDecide(id, d), debugRequest: (m, p) => pane.debugRequest(m, p), debugSuggest: (kind, query, mode) => pane.debugSuggest(kind, query, mode), debugThreads: () => pane.debugThreads(), harness: (input) => pane.harness(input) } });

  // ── The Agent pane (secondary sidebar) — the Cursor-standard surface ──
  const pane = new AgentPane(context, output, live);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPane.viewId, pane, { webviewOptions: { retainContextWhenHidden: true } }));
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
      const limits = (await queryCodex("account/rateLimits/read", {}, workspaceCwd())).rateLimits as Record<string, unknown> | undefined;
      renderLimits(limits, account?.planType ?? "");
    } catch { codexItem.text = "$(hubot) Codex: sign in"; codexItem.show(); }
  };
  void refreshCodexStatus();
  const statusTimer = setInterval(() => void refreshCodexStatus(), 10 * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) }, codexItem);
  pane.onAccountEvent((params) => { const limits = (params.rateLimits ?? params) as Record<string, unknown>; renderLimits(limits, String((limits.planType as string | undefined) ?? "")); });
  context.subscriptions.push(vscode.commands.registerCommand("muster.completions.toggle", async () => {
    const on = !config().get<boolean>("completions.enabled", false);
    await config().update("completions.enabled", on, vscode.ConfigurationTarget.Global);
    tabItem.text = on ? "Muster Tab" : "Muster Tab: off";
    void vscode.window.setStatusBarMessage(on ? "Muster Tab on — Codex completes as you pause" : "Muster Tab off", 2500);
  }));
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
  // Browser (⇧⌘B): a Chromium guest tab with Cursor's visual editor; picks and screenshots go to the chat.
  const browser = new BrowserController(context, workspaceCwd);
  pane.browser = browser;
  setBrowserProvider(() => { const id = browser.activeEditorBrowser() ?? pane.activeBrowserId() ?? browser.list()[0]?.id; const st = id ? browser.get(id) : undefined; return st ? { url: st.url, title: st.title, console: st.console } : undefined; });
  browser.onChange((state) => pane.browserChanged(state));
  browser.onPick((pick) => { if (pick.imagePath || !pick.picked) void pane.addBrowserPick(pick); });
  // The browser as agent tools: Codex launches our MCP shim, which calls back into this host over a socket.
  const browserTools = new BrowserToolServer(browser, () => browser.activeEditorBrowser() ?? pane.activeBrowserId(), (url) => { pane.openBrowserTab(url); return browser.list().at(-1); }, (line) => output.appendLine(line));
  browserTools.start(joinPath(context.extensionPath, "browser-mcp.js")); context.subscriptions.push(browserTools);
  setBrowserMcp({ command: browserTools.launcherPath, args: [], env: {} });
  turnHooks.start = () => browserTools.turnStarted(); turnHooks.end = () => browserTools.turnEnded();
  output.appendLine(`browser tools listening on ${browserTools.socketPath} (shim: ${browserTools.launcherPath})`);
  context.subscriptions.push(vscode.commands.registerCommand("muster.browser.openTab", async (url?: string) => { const target = typeof url === "string" ? url : await vscode.window.showInputBox({ prompt: "Open Browser", value: browser.defaultUrl(), placeHolder: "Enter URL or search..." }); if (!target) return; if (config().get<string>("browser.location", "editor") === "pane") pane.openBrowserTab(target); else browser.open(target, "editor"); }));
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
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.maximize", () => vscode.commands.executeCommand("workbench.action.toggleMaximizedAuxiliaryBar")));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.resume", async (thread?: CodexThread) => {
    if (thread) await pane.openThread(thread); else await pane.pickThread();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.debug.extensionState", () => {
    output.appendLine(JSON.stringify({ threads: threadsCache.length, model: config().get("codex.model"), effort: config().get("codex.effort") }));
    output.show();
  }));

  // ── Status bar, Cursor's right cluster ──
  const tabItem = vscode.window.createStatusBarItem("muster.tab", vscode.StatusBarAlignment.Right, 60);
  tabItem.text = config().get<boolean>("completions.enabled", false) ? "Muster Tab" : "Muster Tab: off"; tabItem.tooltip = "Inline completions from Codex (click to toggle; uses your plan)"; tabItem.command = "muster.completions.toggle"; tabItem.show();
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
