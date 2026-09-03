// The Agent pane — muster's own surface in the secondary sidebar, built to the
// measured Cursor spec (docs/cursor-ux-spec.md). Empty state: composer card at
// the top. Conversation: messages above, composer docked at the bottom.
import * as vscode from "vscode";
import { formatAge, formatSize, interruptTurn, listThreads, readHistory, runTurn, type CodexThread } from "./codex.js";
import type { EditCard, LiveEditController } from "./live-edit.js";

type ToPane =
  | { type: "state"; model: string; effort: string; thread?: { id: string; name: string } }
  | { type: "history"; messages: { role: "user" | "assistant"; text: string }[] }
  | { type: "user"; text: string }
  | { type: "start" }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; ok: boolean; error?: string }
  | { type: "edit"; card: EditCard };
type FromPane = { type: "ready" } | { type: "send"; text: string } | { type: "stop" };

export class AgentPane implements vscode.WebviewViewProvider {
  static readonly viewId = "muster.agent.pane";
  private view: vscode.WebviewView | undefined;
  private thread: CodexThread | undefined;
  private running = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.LogOutputChannel, private readonly live: LiveEditController) {
    this.live.onCard((card) => this.post({ type: "edit", card }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = paneHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: FromPane) => void this.onMessage(message));
  }

  newAgent(): void {
    this.thread = undefined;
    this.post({ type: "history", messages: [] });
    this.pushState();
    void vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
  }

  async openThread(thread: CodexThread): Promise<void> {
    this.thread = thread;
    await vscode.commands.executeCommand(`${AgentPane.viewId}.focus`);
    const history = await readHistory(thread);
    this.post({ type: "history", messages: history.map((m) => ({ role: m.role, text: m.text })) });
    this.pushState();
  }

  async pickThread(): Promise<void> {
    const threads = await listThreads();
    const picked = await vscode.window.showQuickPick(threads.map((thread) => ({
      label: thread.name,
      description: `${thread.project} · ${formatAge(thread.lastActivityAt)}`,
      detail: `${thread.turnCount} turns · ${formatSize(thread.sizeBytes)}`,
      thread,
    })), { placeHolder: "Continue a Codex thread", matchOnDescription: true });
    if (picked) await this.openThread(picked.thread);
  }

  stop(): void {
    if (this.running) void interruptTurn();
  }

  private post(message: ToPane): void {
    void this.view?.webview.postMessage(message);
  }

  private pushState(): void {
    const config = vscode.workspace.getConfiguration("muster");
    this.post({
      type: "state",
      model: modelLabel(config.get<string>("codex.model") ?? "gpt-5.6-sol"),
      effort: effortLabel(config.get<string>("codex.effort") ?? "medium"),
      ...(this.thread ? { thread: { id: this.thread.id, name: this.thread.name } } : {}),
    });
  }

  private async onMessage(message: FromPane): Promise<void> {
    if (message.type === "ready") { this.pushState(); return; }
    if (message.type === "stop") { this.stop(); return; }
    if (message.type !== "send" || !message.text.trim() || this.running) return;
    const config = vscode.workspace.getConfiguration("muster");
    const cwd = this.thread?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.running = true;
    this.post({ type: "user", text: message.text });
    this.post({ type: "start" });
    try {
      const result = await runTurn({
        prompt: message.text,
        cwd,
        ...(this.thread ? { threadId: this.thread.id } : {}),
        model: config.get<string>("codex.model") ?? "gpt-5.6-sol",
        reasoning: (config.get<string>("codex.effort") as "low" | "medium" | "high" | "xhigh" | "max" | "ultra") ?? "medium",
        handlers: {
          onDelta: (text) => this.post({ type: "delta", text }),
          onReasoning: (text) => this.post({ type: "reasoning", text }),
          onEvent: (method, params) => this.live.onEvent(method, params),
        },
      });
      if (result.status === "failed") {
        this.post({ type: "done", ok: false, error: result.errorMessage ?? "The turn failed." });
      } else {
        if (result.threadId && !this.thread) {
          this.thread = (await listThreads()).find((t) => t.id === result.threadId);
          this.pushState();
        }
        this.post({ type: "done", ok: true });
      }
    } catch (error) {
      this.post({ type: "done", ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}

function modelLabel(id: string): string {
  const names: Record<string, string> = { "gpt-5.6-sol": "GPT-5.6 Sol", "gpt-5.6-terra": "GPT-5.6 Terra", "gpt-5.6-luna": "GPT-5.6 Luna", "gpt-5.5": "GPT-5.5" };
  return names[id] ?? id;
}
function effortLabel(id: string): string {
  const names: Record<string, string> = { low: "Light", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
  return names[id] ?? id;
}

function paneHtml(csp: string): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp}; img-src ${csp} data:;">
<style>
  :root {
    --fg: var(--vscode-editor-foreground);
    --bg-secondary: color-mix(in srgb, var(--fg) 14%, transparent);
    --bg-tertiary: color-mix(in srgb, var(--fg) 8%, transparent);
    --bg-quaternary: color-mix(in srgb, var(--fg) 6%, transparent);
    --text-secondary: color-mix(in srgb, var(--fg) 55%, transparent);
    --text-tertiary: color-mix(in srgb, var(--fg) 37%, transparent);
    --stroke-secondary: color-mix(in srgb, var(--fg) 10%, transparent);
    --stroke-tertiary: color-mix(in srgb, var(--fg) 7%, transparent);
    --radius-sm: 4px; --radius-base: 6px; --radius-xl: 12px;
    --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-lg: 14px; --lh-lg: 22px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--fs-lg); line-height: var(--lh-lg); color: var(--fg); background: transparent; -webkit-font-smoothing: subpixel-antialiased; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow: auto; padding: 8px 10px 12px; display: none; flex-direction: column; gap: 10px; }
  body.has-messages #messages { display: flex; }
  .human { align-self: flex-end; margin-left: max(32px, 20%); min-width: 150px; background: var(--vscode-input-background); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-xl); padding: 8px 10px; white-space: pre-wrap; }
  .assistant { white-space: pre-wrap; }
  .assistant code { background: var(--vscode-textCodeBlock-background); border-radius: var(--radius-sm); padding: 1px 4px; font-family: var(--vscode-editor-font-family); font-size: var(--fs-base); }
  .assistant pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-base); padding: 8px 10px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--fs-base); line-height: 20px; }
  .thinking { color: var(--text-tertiary); font-size: var(--fs-base); }
  .thinking summary { cursor: pointer; color: var(--text-secondary); list-style: none; }
  .thinking summary::before { content: "▸ "; }
  .thinking[open] summary::before { content: "▾ "; }
  .thinking .body { white-space: pre-wrap; font-style: italic; margin-top: 4px; }
  .error { color: var(--vscode-errorForeground); font-size: var(--fs-base); }
  .edit { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; border: 1px solid var(--stroke-tertiary); border-radius: var(--radius-xl); background: var(--vscode-editor-background); font-size: var(--fs-base); color: var(--text-secondary); }
  .edit .path { color: var(--fg); font-family: var(--vscode-editor-font-family); font-size: var(--fs-sm); }
  .edit .adds { color: var(--vscode-charts-green); font-variant-numeric: tabular-nums; }
  .edit .dels { color: var(--vscode-charts-red); font-variant-numeric: tabular-nums; }
  .edit .state { margin-left: auto; color: var(--text-tertiary); font-size: var(--fs-xs); }
  #status { display: none; align-items: center; justify-content: space-between; padding: 0 12px 6px; font-size: var(--fs-base); color: var(--text-secondary); }
  body.running #status { display: flex; }
  #status .stop { cursor: pointer; color: var(--text-secondary); }
  #status .stop kbd { font-family: inherit; color: var(--text-tertiary); margin-left: 6px; }
  #composer { margin: 8px 10px 10px; background: var(--vscode-input-background); border: 1px solid var(--stroke-secondary); border-radius: var(--radius-xl); padding: 10px 12px 8px; }
  #composer:focus-within { border-color: color-mix(in srgb, var(--fg) 20%, transparent); }
  body:not(.has-messages) #composer { order: -1; }
  #input { width: 100%; min-height: 84px; max-height: 240px; resize: none; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: var(--fs-lg); line-height: var(--lh-lg); padding: 0; }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .bar { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: var(--radius-base); background: var(--bg-secondary); font-size: var(--fs-sm); color: var(--fg); cursor: default; }
  .pill svg { width: 12px; height: 12px; }
  .model { font-size: var(--fs-sm); color: var(--fg); display: inline-flex; align-items: center; gap: 6px; }
  .model .lock { color: var(--text-tertiary); }
  .spacer { flex: 1; }
  .icon { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-base); color: var(--fg); cursor: pointer; }
  .icon:hover { background: var(--bg-tertiary); }
  .icon svg { width: 16px; height: 16px; }
  .send { background: var(--fg); color: var(--vscode-editor-background); border-radius: 9999px; width: 24px; height: 24px; display: none; align-items: center; justify-content: center; cursor: pointer; }
  body.dirty .send { display: inline-flex; }
  body.running .send { display: none; }
</style></head>
<body>
  <div id="messages"></div>
  <div id="status"><span>Generating..</span><span class="stop" id="stop">Stop<kbd>⇧⌘⌫</kbd></span></div>
  <div id="composer">
    <textarea id="input" placeholder="Plan, Build, / for skills, @ for context" rows="1"></textarea>
    <div class="bar">
      <span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.2 8.5a3.5 3.5 0 0 1 0 7c-2.5 0-3.7-3.5-6.2-3.5S8.3 15.5 5.8 15.5a3.5 3.5 0 0 1 0-7c2.5 0 3.7 3.5 6.2 3.5s3.7-3.5 6.2-3.5z"/></svg>Agent <span style="opacity:.6">⌘I</span> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span>
      <span class="model" id="model">GPT-5.6 Sol Medium <span class="lock">🔒</span></span>
      <span class="spacer"></span>
      <span class="icon" title="Attach"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.5l-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"/></svg></span>
      <span class="icon" title="Dictate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>
      <span class="send" id="send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="14" height="14"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $("messages"), input = $("input"), body = document.body;
  let assistantEl = null, thinkingEl = null;
  const escape = (s) => s.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  function renderMarkdown(text) {
    let html = escape(text);
    html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => "<pre>" + code + "</pre>");
    html = html.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
    html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<b>$1</b>");
    return html;
  }
  function addHuman(text) { const el = document.createElement("div"); el.className = "human"; el.textContent = text; messages.appendChild(el); body.classList.add("has-messages"); scroll(); }
  function ensureAssistant() { if (!assistantEl) { assistantEl = document.createElement("div"); assistantEl.className = "assistant"; assistantEl.dataset.raw = ""; messages.appendChild(assistantEl); } return assistantEl; }
  function ensureThinking() { if (!thinkingEl) { thinkingEl = document.createElement("details"); thinkingEl.className = "thinking"; thinkingEl.innerHTML = "<summary>Thinking</summary><div class=body></div>"; messages.appendChild(thinkingEl); } return thinkingEl; }
  function scroll() { messages.scrollTop = messages.scrollHeight; }
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, Math.max(84, input.scrollHeight)) + "px"; body.classList.toggle("dirty", input.value.trim().length > 0); }
  function send() { const text = input.value.trim(); if (!text || body.classList.contains("running")) return; vscode.postMessage({ type: "send", text }); input.value = ""; autosize(); }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  $("send").addEventListener("click", send);
  $("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "state") { $("model").innerHTML = escape(m.model) + " " + escape(m.effort) + ' <span class="lock">🔒</span>'; }
    else if (m.type === "history") { messages.innerHTML = ""; assistantEl = thinkingEl = null; body.classList.toggle("has-messages", m.messages.length > 0); for (const msg of m.messages) { if (msg.role === "user") addHuman(msg.text); else { const el = document.createElement("div"); el.className = "assistant"; el.innerHTML = renderMarkdown(msg.text); messages.appendChild(el); } } scroll(); }
    else if (m.type === "user") { assistantEl = thinkingEl = null; addHuman(m.text); }
    else if (m.type === "start") { body.classList.add("running"); }
    else if (m.type === "reasoning") { const t = ensureThinking(); t.querySelector(".body").textContent += m.text; scroll(); }
    else if (m.type === "delta") { const a = ensureAssistant(); a.dataset.raw += m.text; a.innerHTML = renderMarkdown(a.dataset.raw); scroll(); }
    else if (m.type === "edit") { const id = "edit-" + m.card.path.replace(/[^a-z0-9]/gi, "_"); let el = document.getElementById(id); if (!el) { el = document.createElement("div"); el.className = "edit"; el.id = id; messages.appendChild(el); body.classList.add("has-messages"); } const labels = { streaming: "Editing…", written: "Written", kept: "Kept", undone: "Undone" }; el.innerHTML = '<span class="path">' + escape(m.card.path) + '</span><span class="adds">+' + m.card.adds + '</span><span class="dels">−' + m.card.dels + '</span><span class="state">' + labels[m.card.status] + '</span>'; scroll(); }
    else if (m.type === "done") { body.classList.remove("running"); if (thinkingEl) thinkingEl.querySelector("summary").textContent = "Thought"; if (!m.ok) { const e = document.createElement("div"); e.className = "error"; e.textContent = m.error || "Failed"; messages.appendChild(e); } assistantEl = thinkingEl = null; scroll(); }
  });
  autosize();
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
