// The Plan editor — Cursor's rendered surface for *.plan.md (docs/cursor-feature-atlas.md §4):
// breadcrumb toolbar with "Preview ⌄" (rendered / markdown source), the model that will
// build, and the amber "Build ⌘⏎ ⌄" split button; the plan body rendered with clickable
// to-dos so one, some or all of them can be built.
import * as vscode from "vscode";

export interface PlanBuildRequest { readonly uri: vscode.Uri; readonly todos?: number[]; readonly model?: string; readonly newThread?: boolean }
export interface PlanEditorHost {
  models(): { id: string; name: string; provider: string }[];
  currentModel(): string | undefined;
  build(request: PlanBuildRequest): Promise<void>;
}

export class PlanEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "muster.planEditor";
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; document: vscode.TextDocument; selection: number[]; todos: number; model: string }>();
  private activeUri: string | undefined;

  constructor(private readonly host: PlanEditorHost) {}

  /** The plan editor that is active right now (for the breadcrumb toolbar's commands). */
  active(): { uri: vscode.Uri; selection: number[]; model: string } | undefined {
    const entry = this.activeUri ? this.panels.get(this.activeUri) : undefined;
    return entry ? { uri: entry.document.uri, selection: entry.selection, model: entry.model } : undefined;
  }

  refreshAll(): void {
    for (const entry of this.panels.values()) void entry.panel.webview.postMessage({ type: "plan", text: entry.document.getText(), name: entry.document.uri.path.split("/").pop() ?? "plan.md", models: this.host.models(), model: entry.model || this.host.currentModel() || "" });
    this.syncToolbar();
  }

  setModel(id: string): void {
    const entry = this.activeUri ? this.panels.get(this.activeUri) : undefined;
    if (entry) { entry.model = id; this.refreshAll(); }
  }

  private syncToolbar(): void {
    const entry = this.activeUri ? this.panels.get(this.activeUri) : undefined;
    const visible = !!entry && entry.panel.active;
    const modelName = entry ? (this.host.models().find((m) => m.id === (entry.model || this.host.currentModel()))?.name ?? "Model") : "";
    void vscode.commands.executeCommand("muster.planToolbar.set", { visible, model: modelName, count: entry?.todos ?? 0, selected: entry?.selection.length ?? 0 });
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = planHtml(panel.webview.cspSource);
    const key = document.uri.toString();
    const entry = { panel, document, selection: [] as number[], todos: 0, model: "" };
    this.panels.set(key, entry);
    if (panel.active) this.activeUri = key;
    const push = () => void panel.webview.postMessage({ type: "plan", text: document.getText(), name: document.uri.path.split("/").pop() ?? "plan.md", models: this.host.models(), model: entry.model || this.host.currentModel() || "" });
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === key) push(); });
    const view = panel.onDidChangeViewState(() => { if (panel.active) this.activeUri = key; else if (this.activeUri === key) this.activeUri = undefined; this.syncToolbar(); });
    panel.onDidDispose(() => { sub.dispose(); view.dispose(); this.panels.delete(key); if (this.activeUri === key) this.activeUri = undefined; this.syncToolbar(); });
    this.syncToolbar();
    panel.webview.onDidReceiveMessage(async (message: { type: string; todos?: number[]; model?: string; newThread?: boolean; count?: number }) => {
      if (message.type === "selection") { entry.selection = message.todos ?? []; entry.todos = message.count ?? entry.todos; this.syncToolbar(); return; }
      if (message.type === "ready") push();
      else if (message.type === "source") await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      else if (message.type === "build") await this.host.build({ uri: document.uri, ...(message.todos?.length ? { todos: message.todos } : {}), ...(message.model ? { model: message.model } : {}), ...(message.newThread ? { newThread: true } : {}) });
    });
  }
}

function planHtml(csp: string): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp};">
<style>
  :root { --fg: var(--vscode-editor-foreground); --bg: var(--vscode-editor-background); --amber: #D2943E;
    --text-secondary: color-mix(in srgb, var(--fg) 66%, transparent); --text-tertiary: color-mix(in srgb, var(--fg) 36%, transparent);
    --bg-tertiary: color-mix(in srgb, var(--fg) 8%, transparent); --bg-quaternary: color-mix(in srgb, var(--fg) 6%, transparent);
    --stroke-secondary: color-mix(in srgb, var(--fg) 12%, transparent); --stroke-tertiary: color-mix(in srgb, var(--fg) 8%, transparent); }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: 14px; line-height: 22px; display: flex; flex-direction: column; }
  #bar { display: none; flex: 0 0 auto; height: 32px; display: flex; align-items: center; gap: 6px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--stroke-tertiary); font-size: 13px; }
  #bar .crumb { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #bar .crumb .ic { color: var(--text-tertiary); }
  #bar .spacer { flex: 1; }
  .pill { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border-radius: 6px; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
  .pill:hover { background: var(--bg-tertiary); color: var(--fg); }
  .pill .chev { font-size: 9px; opacity: .7; }
  .sep { width: 1px; height: 16px; background: var(--stroke-secondary); margin: 0 4px; }
  .split { display: inline-flex; border-radius: 6px; overflow: hidden; }
  .split .build { height: 24px; padding: 0 9px; background: var(--amber); color: #1a1a1a; font: inherit; font-size: 13px; font-weight: 500; border: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .split .build kbd { font-family: inherit; color: #1a1a1a; opacity: .7; }
  .split .more { width: 22px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: var(--amber); color: #1a1a1a; border-left: 1px solid rgba(0,0,0,.25); cursor: pointer; font-size: 9px; }
  #doc { flex: 1; overflow: auto; padding: 28px 48px 80px; max-width: 900px; }
  #doc h1 { font-size: 28px; line-height: 34px; margin: 0 0 20px; font-weight: 600; }
  #doc h2 { font-size: 20px; margin: 24px 0 10px; font-weight: 600; }
  #doc h3 { font-size: 16px; margin: 20px 0 8px; font-weight: 600; }
  #doc p { margin: 0 0 12px; }
  #doc code { font-family: var(--vscode-editor-font-family); font-size: 13px; background: var(--bg-tertiary); border-radius: 4px; padding: 1px 5px; }
  #doc pre { background: var(--bg-quaternary); border: 1px solid var(--stroke-tertiary); border-radius: 6px; padding: 10px 12px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 13px; line-height: 20px; }
  #doc ul, #doc ol { padding-left: 24px; margin: 0 0 12px; }
  #doc li { margin: 4px 0; }
  #doc li.todo { list-style: none; margin-left: -24px; display: flex; gap: 10px; align-items: flex-start; padding: 3px 6px; border-radius: 6px; cursor: pointer; }
  #doc li.todo:hover { background: var(--bg-quaternary); }
  #doc li.todo .o { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--fg) 30%, transparent); flex: 0 0 auto; margin-top: 3px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }
  #doc li.todo.sel .o { background: var(--amber); border-color: var(--amber); color: #1a1a1a; }
  #doc li.todo.done { color: var(--text-tertiary); text-decoration: line-through; }
  #doc blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 2px solid var(--stroke-secondary); color: var(--text-secondary); }
  #doc table { border-collapse: collapse; margin: 0 0 12px; } #doc th, #doc td { border: 1px solid var(--stroke-secondary); padding: 4px 10px; text-align: left; }
  #doc hr { border: 0; border-top: 1px solid var(--stroke-secondary); margin: 16px 0; }
  .menu { position: fixed; top: 0; left: 0; visibility: hidden; min-width: 220px; background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--stroke-secondary); border-radius: 8px; box-shadow: 0 6px 24px var(--vscode-widget-shadow); padding: 4px; z-index: 20; display: none; font-size: 13px; }
  .menu.open { display: block; visibility: visible; }
  .menu .group { padding: 6px 10px 2px; font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: .3px; }
  .menu .item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
  .menu .item:hover { background: var(--bg-tertiary); }
  .menu .item .lbl { flex: 1; } .menu .item .check { width: 14px; visibility: hidden; } .menu .item.on .check { visibility: visible; }
  .menu .item .kbd { color: var(--text-tertiary); font-size: 11px; }
  #sel { color: var(--text-tertiary); font-size: 12px; }
</style></head>
<body>
  <div id="bar" style="display:none">
    <span class="crumb"><span class="ic">☰</span><span id="name">plan.md</span></span>
    <span class="spacer"></span>
    <span id="sel"></span>
    <span class="pill" id="view">Preview <span class="chev">▼</span></span>
    <span class="sep"></span>
    <span class="pill" id="model" title="Model used to build this plan"><span id="model-name">Model</span> <span class="chev">▼</span></span>
    <span class="split"><button class="build" id="build">Build <kbd>⌘⏎</kbd></button><span class="more" id="build-more">▼</span></span>
  </div>
  <div id="doc"></div>
  <div class="menu" id="menu"></div>
<script>const vscode = acquireVsCodeApi(); vscode.postMessage({ type: "boot" });</script>
<script>
  const $ = (id) => document.getElementById(id);
  const menu = $("menu"), doc = $("doc");
  let plan = { text: "", name: "plan.md", models: [], model: "" }, model = "", sel = new Set(), todoCount = 0;
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  function inline(t) {
    return escape(t).replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<b>$1</b>").replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, "$1<i>$2</i>").replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
  }
  function render(text) {
    const lines = text.split("\\n"); let html = "", i = 0, para = [], todoIndex = 0;
    const flush = () => { if (para.length) html += "<p>" + inline(para.join(" ")) + "</p>"; para = []; };
    while (i < lines.length) {
      const l = lines[i];
      const fence = /^\`\`\`(\\w*)\\s*$/.exec(l);
      if (fence) { flush(); const code = []; i++; while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) code.push(lines[i++]); i++; html += "<pre>" + escape(code.join("\\n")) + "</pre>"; continue; }
      const h = /^(#{1,3})\\s+(.*)$/.exec(l);
      if (h) { flush(); html += "<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
      if (/^\\s*([-*]|\\d+\\.)\\s+/.test(l)) { flush(); const ordered = /^\\s*\\d+\\./.test(l); const items = []; while (i < lines.length && /^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i])) items.push(lines[i++].replace(/^\\s*([-*]|\\d+\\.)\\s+/, ""));
        html += (ordered ? "<ol>" : "<ul>") + items.map((t) => { const box = /^\\[( |x|X)\\]\\s*/.exec(t); const idx = todoIndex++; const done = box && box[1] !== " "; return '<li class="todo' + (done ? " done" : "") + (sel.has(idx) ? " sel" : "") + '" data-i="' + idx + '"><span class="o">' + (sel.has(idx) ? "✓" : "") + '</span><span>' + inline(t.replace(/^\\[( |x|X)\\]\\s*/, "")) + "</span></li>"; }).join("") + (ordered ? "</ol>" : "</ul>"); continue; }
      if (/^\\s*>/.test(l)) { flush(); const q = []; while (i < lines.length && /^\\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\\s*>\\s?/, "")); html += "<blockquote>" + inline(q.join(" ")) + "</blockquote>"; continue; }
      if (/^\\s*\\|/.test(l) && /^\\s*\\|/.test(lines[i + 1] || "")) { flush(); const rows = []; while (i < lines.length && /^\\s*\\|/.test(lines[i])) rows.push(lines[i++]); const cells = (r) => r.trim().replace(/^\\||\\|$/g, "").split("|").map((c) => c.trim()); const head = cells(rows[0]); const body = rows.slice(1).filter((r) => !/^\\s*\\|?\\s*:?-+/.test(r)); html += "<table><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr>" + body.map((r) => "<tr>" + cells(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</table>"; continue; }
      if (/^\\s*(-{3,}|\\*{3,})\\s*$/.test(l)) { flush(); html += "<hr>"; i++; continue; }
      if (!l.trim()) { flush(); i++; continue; }
      para.push(l); i++;
    }
    flush(); todoCount = todoIndex; return html;
  }
  function paint() {
    $("name").textContent = plan.name;
    const m = plan.models.find((x) => x.id === model) || plan.models.find((x) => x.id === plan.model); $("model-name").textContent = m ? m.name : (plan.models.length ? "Model" : "…");
    doc.innerHTML = render(plan.text);
    $("sel").textContent = sel.size ? sel.size + " of " + todoCount + " to-dos selected" : "";
    $("build").innerHTML = "Build" + (sel.size && sel.size < todoCount ? " " + sel.size : "") + " <kbd>⌘⏎</kbd>";
    doc.querySelectorAll("li.todo").forEach((el) => el.addEventListener("click", () => { const i = Number(el.dataset.i); if (sel.has(i)) sel.delete(i); else sel.add(i); paint(); }));
    vscode.postMessage({ type: "selection", todos: [...sel].sort((a, b) => a - b), count: todoCount });
  }
  function build(newThread) { vscode.postMessage({ type: "build", todos: [...sel].sort((a, b) => a - b), model: model || plan.model || undefined, newThread: !!newThread }); }
  function place(anchor) { const a = anchor.getBoundingClientRect(); menu.style.top = (a.bottom + 4) + "px"; menu.style.left = Math.max(6, Math.min(a.left, window.innerWidth - menu.offsetWidth - 6)) + "px"; }
  function open(anchor, items, onPick) { menu.innerHTML = items; menu.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => { onPick(el); close(); })); menu.classList.add("open"); place(anchor); }
  function close() { menu.classList.remove("open"); }
  $("view").addEventListener("click", (e) => { e.stopPropagation(); open(e.currentTarget, '<div class="item on"><span class="lbl">Preview</span><span class="check">✓</span></div><div class="item" data-act="source"><span class="lbl">Markdown source</span><span class="check"></span></div>', (el) => { if (el.dataset.act === "source") vscode.postMessage({ type: "source" }); }); });
  $("model").addEventListener("click", (e) => { e.stopPropagation(); let html = ""; for (const [prov, title] of [["codex", "Codex"], ["claude", "Claude Code"]]) { const ms = plan.models.filter((x) => x.provider === prov); if (!ms.length) continue; html += '<div class="group">' + title + '</div>' + ms.map((x) => '<div class="item' + (x.id === (model || plan.model) ? " on" : "") + '" data-id="' + escape(x.id) + '"><span class="lbl">' + escape(x.name) + '</span><span class="check">✓</span></div>').join(""); } open(e.currentTarget, html || '<div class="item"><span class="lbl">No models yet</span></div>', (el) => { if (el.dataset.id) { model = el.dataset.id; paint(); } }); });
  $("build").addEventListener("click", () => build(false));
  $("build-more").addEventListener("click", (e) => { e.stopPropagation(); open(e.currentTarget, '<div class="item" data-act="here"><span class="lbl">Build in this thread</span><span class="kbd">⌘⏎</span></div><div class="item" data-act="new"><span class="lbl">Build in a new agent thread</span></div>', (el) => build(el.dataset.act === "new")); });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); build(false); } });
  window.addEventListener("message", (event) => { const m = event.data; if (m.type === "plan") { plan = m; paint(); } });
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
