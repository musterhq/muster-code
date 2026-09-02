// Muster Code — the built-in Muster layer. Codex-first: the default chat
// participant, Codex threads as chat sessions, Codex models in the model
// picker, the Threads view, and the Board view.
import * as vscode from "vscode";
import { formatAge, formatSize, interruptTurn, listThreads, readHistory, runTurn, type CodexThread } from "./codex.js";

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

  // ── The default chat participant: streams a Codex turn into the native chat ──
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const threadId = threadIdForRequest(request);
    const thread = threadsCache.find((item) => item.id === threadId);
    const cwd = thread?.cwd ?? workspaceCwd();
    let reasoningBuffer = "";
    stream.progress(thread ? `Continuing ${thread.name}` : "Thinking");
    const cancel = token.onCancellationRequested(() => { void interruptTurn(); });
    try {
      const result = await runTurn({
        prompt: request.prompt,
        cwd,
        ...(threadId ? { threadId } : {}),
        model: config().get<string>("codex.model") ?? "gpt-5.6-sol",
        reasoning: (config().get<string>("codex.effort") as "low" | "medium" | "high" | "xhigh" | "max" | "ultra") ?? "medium",
        handlers: {
          onDelta: (text) => stream.markdown(text),
          onReasoning: (text) => {
            reasoningBuffer += text;
            (stream as unknown as { thinkingProgress?: (d: { text: string; id: string }) => void }).thinkingProgress?.({ text, id: "codex-reasoning" });
          },
        },
      });
      if (result.status === "failed") {
        stream.warning(result.errorMessage ?? "The turn failed.");
        return { errorDetails: { message: result.errorMessage ?? "failed" } };
      }
      if (result.threadId && !threadId) void refreshThreads();
      return { metadata: { threadId: result.threadId ?? threadId, reasoningChars: reasoningBuffer.length, tokens: result.tokenUsage } };
    } finally {
      cancel.dispose();
    }
  };
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "muster.svg");
  context.subscriptions.push(participant);

  // ── Codex threads as chat sessions (the sidebar list, by the app's own names) ──
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

  // ── Threads view (activity bar) ──
  const tree = new ThreadsTree();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("muster.threads", tree));
  context.subscriptions.push(vscode.commands.registerCommand("muster.threads.refresh", async () => { await refreshThreads(); tree.refresh(); await controller.refreshHandler(new vscode.CancellationTokenSource().token); }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.thread.resume", async (thread?: CodexThread) => {
    const target = thread ?? (await pickThread());
    if (!target) return;
    await vscode.commands.executeCommand("vscode.open", sessionUri(target.id));
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.debug.extensionState", () => {
    output.appendLine(JSON.stringify({ threads: threadsCache.length, model: config().get("codex.model"), effort: config().get("codex.effort") }));
    output.show();
  }));

  // ── Board view (webview) ──
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("muster.board", {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: false };
      view.webview.html = boardHtml();
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand("muster.board.open", () => vscode.commands.executeCommand("muster.board.focus")));

  await refreshThreads();
  tree.refresh();
  output.appendLine(`Muster activated · ${threadsCache.length} Codex threads`);

  async function refreshThreads(): Promise<CodexThread[]> {
    try {
      threadsCache = await listThreads();
    } catch (error) {
      output.appendLine(`thread discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return threadsCache;
  }

  async function pickThread(): Promise<CodexThread | undefined> {
    const picked = await vscode.window.showQuickPick(threadsCache.map((thread) => ({
      label: thread.name,
      description: `${thread.project} · ${formatAge(thread.lastActivityAt)}`,
      detail: `${thread.turnCount} turns · ${formatSize(thread.sizeBytes)}`,
      thread,
    })), { placeHolder: "Continue a Codex thread", matchOnDescription: true });
    return picked?.thread;
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
  const resource = (request as unknown as { resourceUri?: vscode.Uri; sessionResource?: vscode.Uri }).sessionResource
    ?? (request as unknown as { resourceUri?: vscode.Uri }).resourceUri;
  if (resource?.scheme === SESSION_SCHEME) return resource.path.replace(/^\//, "");
  return undefined;
}

class ThreadsTree implements vscode.TreeDataProvider<CodexThread> {
  private readonly emitter = new vscode.EventEmitter<CodexThread | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh(): void { this.emitter.fire(undefined); }
  getChildren(): CodexThread[] { return threadsCache; }
  getTreeItem(thread: CodexThread): vscode.TreeItem {
    const item = new vscode.TreeItem(thread.name);
    item.description = `${thread.project} · ${formatAge(thread.lastActivityAt)}`;
    item.tooltip = `${thread.cwd}\n${thread.turnCount} turns · ${formatSize(thread.sizeBytes)}`;
    item.iconPath = new vscode.ThemeIcon(thread.live ? "circle-filled" : "comment-discussion");
    item.command = { command: "muster.thread.resume", title: "Resume", arguments: [thread] };
    return item;
  }
}

function boardHtml(): string {
  return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px">
  <div style="opacity:.6;font-size:12px">Board</div>
  <div style="margin-top:8px">Tasks run in worktrees and land here for review. Start one from the chat: <code>/tasks "goal"</code>.</div>
  </body></html>`;
}
