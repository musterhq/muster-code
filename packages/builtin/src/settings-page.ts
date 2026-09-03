// Muster Settings — Cursor's settings page shape (sidebar of sections, content on
// the right): General (account, usage, defaults), Models, Rules, MCP, Skills,
// Plugins, Hooks, Docs. Everything shown comes from the app-server or the
// workspace; nothing is hardcoded.
import * as vscode from "vscode";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_EFFORTS, listAccessModes, listModels, listPlugins, listSkills, queryCodex } from "./codex.js";

type Section = "general" | "models" | "rules" | "mcp" | "skills" | "plugins" | "hooks" | "docs";

export class SettingsPage {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly cwd: () => string) {}

  async open(section: Section = "general"): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("muster.settings", "Muster Settings", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "muster.svg");
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.html = html(this.panel.webview.cspSource);
      this.panel.webview.onDidReceiveMessage((m: { type: string; section?: Section; key?: string; value?: unknown; path?: string; name?: string; url?: string }) => void this.onMessage(m));
    }
    this.panel.reveal();
    await this.push(section);
  }

  private async onMessage(m: { type: string; section?: Section; key?: string; value?: unknown; path?: string; name?: string; url?: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration("muster");
    switch (m.type) {
      case "ready": case "section": await this.push(m.section ?? "general"); return;
      case "set": await config.update(String(m.key), m.value, vscode.ConfigurationTarget.Global); await this.push(m.section ?? "general"); return;
      case "open": if (m.path) await vscode.window.showTextDocument(vscode.Uri.file(m.path)); return;
      case "newRule": {
        const name = await vscode.window.showInputBox({ prompt: "Rule name", placeHolder: "coding-style" });
        if (!name) return;
        const dir = join(this.cwd(), ".muster", "rules"); mkdirSync(dir, { recursive: true });
        const path = join(dir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`);
        if (!existsSync(path)) writeFileSync(path, `# ${name}\n\n`);
        await vscode.window.showTextDocument(vscode.Uri.file(path));
        await this.push("rules");
        return;
      }
      case "addDoc": {
        const docs = config.get<{ name: string; url: string }[]>("docs", []);
        if (m.name && m.url) { await config.update("docs", [...docs.filter((d) => d.name !== m.name), { name: m.name, url: m.url }], vscode.ConfigurationTarget.Global); }
        await this.push("docs"); return;
      }
      case "removeDoc": { const docs = config.get<{ name: string; url: string }[]>("docs", []); await config.update("docs", docs.filter((d) => d.name !== m.name), vscode.ConfigurationTarget.Global); await this.push("docs"); return; }
      case "openConfig": { const path = join(process.env.HOME ?? "", ".codex", "config.toml"); if (existsSync(path)) await vscode.window.showTextDocument(vscode.Uri.file(path)); return; }
      case "openSkills": { const dir = join(process.env.HOME ?? "", ".codex", "skills"); if (existsSync(dir)) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir)); return; }
    }
  }

  private async push(section: Section): Promise<void> {
    if (!this.panel) return;
    const data = await this.data(section).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    await this.panel.webview.postMessage({ type: "section", section, data });
  }

  private async data(section: Section): Promise<unknown> {
    const cwd = this.cwd();
    const config = vscode.workspace.getConfiguration("muster");
    switch (section) {
      case "general": {
        const [account, limits, access] = await Promise.all([queryCodex("account/read", {}, cwd).catch((): Record<string, unknown> => ({})), queryCodex("account/rateLimits/read", {}, cwd).catch((): Record<string, unknown> => ({})), listAccessModes(cwd).catch(() => [])]);
        return { account: account.account ?? null, limits: limits.rateLimits ?? null, access, settings: { model: config.get("codex.model"), effort: config.get("codex.effort"), completions: config.get("completions.enabled"), claudeModels: config.get("claude.models") } };
      }
      case "models": return { models: await listModels(cwd, config.get<string[]>("claude.models", [])), claudeEfforts: CLAUDE_EFFORTS };
      case "rules": {
        const rules: { path: string; name: string; source: string; preview: string }[] = [];
        for (const [dir, source] of [[join(cwd, ".muster", "rules"), "muster"], [join(cwd, ".cursor", "rules"), "cursor"]] as const) {
          if (!existsSync(dir)) continue;
          for (const name of readdirSync(dir).sort()) { const path = join(dir, name); if (!statSync(path).isFile()) continue; rules.push({ path, name, source, preview: readFileSync(path, "utf8").slice(0, 160) }); }
        }
        const agents = join(cwd, "AGENTS.md");
        return { rules, agentsMd: existsSync(agents) ? { path: agents, preview: readFileSync(agents, "utf8").slice(0, 300) } : null };
      }
      case "mcp": return { servers: (await listPlugins(cwd)).filter((p) => p.kind === "mcp"), configPath: join(process.env.HOME ?? "", ".codex", "config.toml") };
      case "skills": return { skills: await listSkills(cwd) };
      case "plugins": return { plugins: (await listPlugins(cwd)).filter((p) => p.kind === "plugin") };
      case "hooks": { const result = await queryCodex("hooks/list", {}, cwd).catch(() => ({} as Record<string, unknown>)); return { raw: JSON.stringify(result, null, 1).slice(0, 4000) }; }
      case "docs": return { docs: config.get("docs", []) };
    }
  }
}

function html(csp: string): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'unsafe-inline' ${csp};">
<style>
  :root { --fg: var(--vscode-editor-foreground); --t2: color-mix(in srgb, var(--fg) 66%, transparent); --t3: color-mix(in srgb, var(--fg) 36%, transparent); --s2: color-mix(in srgb, var(--fg) 12%, transparent); --s3: color-mix(in srgb, var(--fg) 8%, transparent); --b3: color-mix(in srgb, var(--fg) 8%, transparent); --b4: color-mix(in srgb, var(--fg) 6%, transparent); }
  * { box-sizing: border-box; } html, body { margin: 0; height: 100%; }
  body { display: flex; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--vscode-editor-background); }
  nav { width: 200px; padding: 20px 10px; border-right: 1px solid var(--s3); display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
  nav h1 { font-size: 15px; font-weight: 600; margin: 0 8px 12px; }
  nav .item { padding: 6px 10px; border-radius: 6px; cursor: pointer; color: var(--t2); }
  nav .item:hover { background: var(--b4); color: var(--fg); } nav .item.on { background: var(--b3); color: var(--fg); }
  main { flex: 1; overflow: auto; padding: 24px 32px 60px; max-width: 860px; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; } .sub { color: var(--t2); margin-bottom: 18px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--s3); }
  .row .l { flex: 1; min-width: 0; } .row .t { font-weight: 500; } .row .d { color: var(--t2); font-size: 12px; margin-top: 2px; white-space: pre-wrap; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--b3); color: var(--t2); }
  .pill.ok { background: color-mix(in srgb, var(--vscode-charts-green) 20%, transparent); color: var(--vscode-charts-green); }
  button { font: inherit; color: var(--fg); background: var(--b3); border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; } button:hover { background: var(--s2); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  input, select { font: inherit; color: var(--fg); background: var(--vscode-input-background); border: 1px solid var(--s2); border-radius: 6px; padding: 5px 8px; }
  .toggle { width: 34px; height: 18px; border-radius: 999px; background: var(--s2); position: relative; cursor: pointer; }
  .toggle.on { background: var(--vscode-button-background); } .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .12s; } .toggle.on::after { left: 18px; }
  .bar { height: 6px; border-radius: 3px; background: var(--s3); overflow: hidden; margin-top: 6px; } .bar > i { display: block; height: 100%; background: var(--vscode-charts-green); }
  pre { background: var(--b4); border-radius: 6px; padding: 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: auto; }
  .empty { color: var(--t3); padding: 12px 0; }
</style></head>
<body>
  <nav><h1>Muster Settings</h1></nav>
  <main id="main"></main>
<script>const vscode = acquireVsCodeApi();</script>
<script>
  const SECTIONS = [["general","General"],["models","Models"],["rules","Rules"],["mcp","MCP"],["skills","Skills"],["plugins","Plugins"],["hooks","Hooks"],["docs","Docs"]];
  const nav = document.querySelector("nav"), main = document.getElementById("main");
  let current = "general";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  for (const [id, label] of SECTIONS) { const el = document.createElement("div"); el.className = "item" + (id === current ? " on" : ""); el.textContent = label; el.dataset.id = id; el.addEventListener("click", () => { current = id; [...nav.querySelectorAll(".item")].forEach((n) => n.classList.toggle("on", n.dataset.id === id)); vscode.postMessage({ type: "section", section: id }); }); nav.appendChild(el); }
  const row = (t, d, right) => '<div class="row"><div class="l"><div class="t">' + t + '</div>' + (d ? '<div class="d">' + d + '</div>' : "") + '</div>' + (right || "") + '</div>';
  function render(section, data) {
    if (data && data.error) { main.innerHTML = '<h2>' + esc(section) + '</h2><div class="empty">' + esc(data.error) + '</div>'; return; }
    let h = "";
    if (section === "general") {
      const a = data.account, l = data.limits, p = l && l.primary;
      h += '<h2>General</h2><div class="sub">Account, usage and defaults for new agents.</div>';
      h += row("Codex account", a ? esc(a.email) + " · " + esc(a.planType) : "Not signed in (run codex login)", a ? '<span class="pill ok">' + esc(a.type) + '</span>' : "");
      if (p) h += row("Usage", esc(p.usedPercent) + "% of the " + Math.round(p.windowDurationMins / 1440) + "-day window · resets " + new Date(p.resetsAt * 1000).toLocaleString() + '<div class="bar"><i style="width:' + esc(p.usedPercent) + '%"></i></div>');
      h += row("Default model", esc(data.settings.model) + " · effort " + esc(data.settings.effort), '<span class="pill">per thread in the composer</span>');
      h += row("Default access", "Manual approval unless a thread chooses otherwise", '<select id="acc">' + (data.access || []).map((x) => '<option value="' + esc(x.id) + '">' + esc(x.label) + '</option>').join("") + '</select>');
      h += row("Muster Tab", "Inline completions from Codex as you pause typing (uses your plan)", '<div class="toggle' + (data.settings.completions ? " on" : "") + '" data-key="completions.enabled" data-value="' + (data.settings.completions ? "false" : "true") + '"></div>');
    } else if (section === "models") {
      h += '<h2>Models</h2><div class="sub">From model/list (Codex) and your Claude Code models. Efforts are each provider’s own.</div>';
      for (const m of data.models) h += row(esc(m.name) + (m.isDefault ? ' <span class="pill">default</span>' : ""), esc(m.description) + "<br>" + m.efforts.map((e) => esc(e.id)).join(" · "), '<span class="pill">' + (m.provider === "claude" ? "Claude Code" : "Codex") + '</span>');
    } else if (section === "rules") {
      h += '<h2>Rules</h2><div class="sub">Sent as developer instructions on every turn. .muster/rules/*.md and Cursor’s .cursor/rules/*.mdc; AGENTS.md is read by Codex itself.</div>';
      h += '<div style="margin:0 0 10px"><button class="primary" id="newRule">New rule</button></div>';
      if (data.agentsMd) h += row("AGENTS.md", esc(data.agentsMd.preview), '<button data-open="' + esc(data.agentsMd.path) + '">Open</button>');
      for (const r of data.rules) h += row(esc(r.name) + ' <span class="pill">' + esc(r.source) + '</span>', esc(r.preview), '<button data-open="' + esc(r.path) + '">Open</button>');
      if (!data.rules.length) h += '<div class="empty">No rules yet.</div>';
    } else if (section === "mcp") {
      h += '<h2>MCP</h2><div class="sub">Servers Codex has loaded for this folder (mcpServerStatus/list) — the same config as the Codex app.</div>';
      h += '<div style="margin:0 0 10px"><button id="openConfig">Open ~/.codex/config.toml</button></div>';
      for (const s of data.servers) h += row(esc(s.name), esc(s.detail), '<span class="pill ok">connected</span>');
      if (!data.servers.length) h += '<div class="empty">No MCP servers reported.</div>';
    } else if (section === "skills") {
      h += '<h2>Skills</h2><div class="sub">From skills/list; type / in the composer to use one.</div><div style="margin:0 0 10px"><button id="openSkills">Reveal ~/.codex/skills</button></div>';
      for (const s of data.skills) h += row(esc(s.name), esc(s.description));
      if (!data.skills.length) h += '<div class="empty">No skills reported.</div>';
    } else if (section === "plugins") {
      h += '<h2>Plugins</h2><div class="sub">From plugin/list. Your Codex plugins work as they are; computer use answers its permission prompts in the app.</div>';
      for (const p of data.plugins) h += row(esc(p.name), esc(p.detail), '<span class="pill ok">enabled</span>');
      if (!data.plugins.length) h += '<div class="empty">No plugins reported.</div>';
    } else if (section === "hooks") {
      h += '<h2>Hooks</h2><div class="sub">hooks/list as Codex reports it.</div><pre>' + esc(data.raw) + '</pre>';
    } else if (section === "docs") {
      h += '<h2>Docs</h2><div class="sub">@Docs mentions: fetched once, cached under .muster/docs.</div>';
      h += '<div class="row"><input id="docName" placeholder="Name"><input id="docUrl" placeholder="https://…" style="flex:1"><button class="primary" id="addDoc">Add</button></div>';
      for (const d of data.docs) h += row(esc(d.name), esc(d.url), '<button data-removedoc="' + esc(d.name) + '">Remove</button>');
    }
    main.innerHTML = h;
    main.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "open", path: b.dataset.open })));
    main.querySelectorAll(".toggle").forEach((t) => t.addEventListener("click", () => vscode.postMessage({ type: "set", section, key: t.dataset.key, value: t.dataset.value === "true" })));
    const nr = document.getElementById("newRule"); if (nr) nr.addEventListener("click", () => vscode.postMessage({ type: "newRule" }));
    const oc = document.getElementById("openConfig"); if (oc) oc.addEventListener("click", () => vscode.postMessage({ type: "openConfig" }));
    const os = document.getElementById("openSkills"); if (os) os.addEventListener("click", () => vscode.postMessage({ type: "openSkills" }));
    const ad = document.getElementById("addDoc"); if (ad) ad.addEventListener("click", () => vscode.postMessage({ type: "addDoc", name: document.getElementById("docName").value.trim(), url: document.getElementById("docUrl").value.trim() }));
    main.querySelectorAll("[data-removedoc]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "removeDoc", name: b.dataset.removedoc })));
  }
  window.addEventListener("message", (e) => { const m = e.data; if (m.type === "section") { current = m.section; [...nav.querySelectorAll(".item")].forEach((n) => n.classList.toggle("on", n.dataset.id === current)); render(m.section, m.data); } });
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
