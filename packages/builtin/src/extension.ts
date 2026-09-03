// Muster Code — the built-in Muster layer. Codex-first: the Agent pane (the
// Cursor-standard surface, secondary sidebar), Codex threads as chat sessions,
// the default chat participant + models (native chat kept as plumbing for
// inline chat / chat editing), and Cursor's status-bar cluster.
import * as vscode from "vscode";
import { formatAge, formatSize, interruptTurn, listThreads, readHistory, runTurn, type CodexThread } from "./codex.js";
import { AgentPane } from "./agent-pane.js";
import { LiveEditController } from "./live-edit.js";
import { startDevControl } from "./dev-control.js";

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
  startDevControl(context, { live, log: (line) => output.appendLine(line) });

  // ── The Agent pane (secondary sidebar) — the Cursor-standard surface ──
  const pane = new AgentPane(context, output, live);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPane.viewId, pane, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.new", () => pane.newAgent()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.history", () => pane.showHistory()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.board", () => pane.showBoard()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.mode", () => pane.cycleMode()));
  context.subscriptions.push(vscode.commands.registerCommand("muster.agent.more", () => vscode.commands.executeCommand("workbench.action.openSettings", "muster")));
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
  tabItem.text = "Muster Tab"; tabItem.tooltip = "Inline completions"; tabItem.show();
  const statsItem = vscode.window.createStatusBarItem("muster.agentStats", vscode.StatusBarAlignment.Right, 59);
  statsItem.text = "$(comment-discussion) Agent Stats: 0/0 (0%)"; statsItem.tooltip = "Turns this session"; statsItem.show();
  context.subscriptions.push(tabItem, statsItem);

  await refreshThreads();
  output.appendLine(`Muster activated · ${threadsCache.length} Codex threads`);

  async function refreshThreads(): Promise<CodexThread[]> {
    try {
      threadsCache = await listThreads();
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
