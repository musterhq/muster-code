// Muster Settings — Cursor's settings page shape (sidebar of sections, content on
// the right): General (account, usage, defaults), Models, Rules, MCP, Skills,
// Plugins, Hooks, Docs. Everything shown comes from the app-server or the
// workspace; nothing is hardcoded.
import * as vscode from "vscode";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_MODES } from "./agent-pane.js";
import { CLAUDE_EFFORTS, cachedQuery, catalogAge, listAccessModes, listModels, listPlugins, listRuleFiles, listSkills, queryCodex, setDisabledMcpServers } from "./codex.js";

type Section = "general" | "models" | "rules" | "mcp" | "skills" | "plugins" | "hooks" | "modes" | "docs";

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
      case "refresh": await this.push(m.section ?? "general", true); return;
      case "set": await config.update(String(m.key), m.value, vscode.ConfigurationTarget.Global); await this.push(m.section ?? "general"); return;
      case "open": if (m.path) await vscode.window.showTextDocument(vscode.Uri.file(m.path)); return;
      case "newRule": {
        const name = await vscode.window.showInputBox({ prompt: "Rule name", placeHolder: "coding-style" });
        if (!name) return;
        const dir = join(this.cwd(), ".muster", "rules"); mkdirSync(dir, { recursive: true });
        const path = join(dir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`);
        if (!existsSync(path)) writeFileSync(path, `---\ndescription: ${name}\nglobs:\nalwaysApply: true\n---\n\n# ${name}\n\n`);
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
      case "toggleRule": { const disabled = config.get<string[]>("rules.disabled", []); const name = String(m.name); await config.update("rules.disabled", disabled.includes(name) ? disabled.filter((n) => n !== name) : [...disabled, name], vscode.ConfigurationTarget.Workspace); await this.push("rules"); return; }
      case "toggleMcp": { const disabled = config.get<string[]>("mcp.disabled", []); const name = String(m.name); const next = disabled.includes(name) ? disabled.filter((n) => n !== name) : [...disabled, name]; await config.update("mcp.disabled", next, vscode.ConfigurationTarget.Global); setDisabledMcpServers(next); await this.push("mcp"); return; }
      case "mcpLogin": { const t = vscode.window.createTerminal({ name: `codex mcp login ${String(m.name)}` }); t.show(); t.sendText(`codex mcp login ${String(m.name)}`); return; }
      case "mcpLogs": { const dir = join(process.env.HOME ?? "", ".codex", "log"); if (existsSync(dir)) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir)); else void vscode.window.showInformationMessage("No ~/.codex/log directory yet."); return; }
      case "saveMode": { const mode = (m.value ?? {}) as { id?: string }; if (!mode.id) return; const list = config.get<{ id?: string }[]>("modes", []); await config.update("modes", [...list.filter((x) => x.id !== mode.id), mode], vscode.ConfigurationTarget.Global); await this.push("modes"); return; }
      case "deleteMode": { const list = config.get<{ id?: string }[]>("modes", []); await config.update("modes", list.filter((x) => x.id !== String(m.name)), vscode.ConfigurationTarget.Global); await this.push("modes"); return; }
      case "openSkills": { const dir = join(process.env.HOME ?? "", ".codex", "skills"); if (existsSync(dir)) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir)); return; }
    }
  }

  /** Harness: the data a section renders from. */
  debugData(section: string): Promise<unknown> { return this.data(section as Section); }

  private refresh = false;
  private async push(section: Section, refresh = false): Promise<void> {
    if (!this.panel) return;
    this.refresh = refresh;
    try {
      const data = await this.data(section).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      const age = catalogAge({ general: "account/read", models: "model/list", mcp: "mcpServerStatus/list", skills: "skills/list", plugins: "plugin/list", hooks: "hooks/list" }[section as string] ?? "", section === "models" ? { includeHidden: false } : {}, this.cwd());
      await this.panel.webview.postMessage({ type: "section", section, data, ...(age !== undefined ? { age } : {}) });
    } finally { this.refresh = false; }
  }

  private async data(section: Section): Promise<unknown> {
    const cwd = this.cwd();
    const config = vscode.workspace.getConfiguration("muster");
    switch (section) {
      case "general": {
        const [account, limits, access] = await Promise.all([cachedQuery("account/read", {}, cwd, { refresh: this.refresh }).catch((): Record<string, unknown> => ({})), cachedQuery("account/rateLimits/read", {}, cwd, { refresh: this.refresh, ttlMs: 2 * 60_000 }).catch((): Record<string, unknown> => ({})), listAccessModes(cwd).catch(() => [])]);
        return { account: account.account ?? null, limits: limits.rateLimits ?? null, access, settings: { model: config.get("codex.model"), effort: config.get("codex.effort"), completions: config.get("completions.enabled"), claudeModels: config.get("claude.models") } };
      }
      case "models": return { models: await listModels(cwd, config.get<string[]>("claude.models", [])), claudeEfforts: CLAUDE_EFFORTS };
      case "rules": {
        const disabled = new Set(config.get<string[]>("rules.disabled", []));
        const rules = listRuleFiles(cwd).map((r) => ({ name: r.name, path: r.path, source: r.source, kind: r.kind, description: r.description, globs: r.globs, preview: r.body.slice(0, 160), enabled: !disabled.has(r.name) }));
        const agents = join(cwd, "AGENTS.md"); const user = join(process.env.HOME ?? "", ".codex", "AGENTS.md");
        return { rules, agentsMd: existsSync(agents) ? { path: agents, preview: readFileSync(agents, "utf8").slice(0, 300) } : null, userRules: existsSync(user) ? { path: user, preview: readFileSync(user, "utf8").slice(0, 300) } : null };
      }
      case "mcp": {
        const disabled = new Set(config.get<string[]>("mcp.disabled", []));
        const raw = await cachedQuery("mcpServerStatus/list", {}, cwd, { refresh: this.refresh }).catch((): Record<string, unknown> => ({}));
        const rows = (Array.isArray(raw.data) ? raw.data : []) as Record<string, unknown>[];
        const servers = rows.map((r) => { const tools = r.tools && typeof r.tools === "object" ? Object.keys(r.tools as Record<string, unknown>) : []; const info = (r.serverInfo ?? {}) as Record<string, unknown>; return { name: String(r.name ?? r.id), status: String(r.runtimeStatus ?? ""), auth: String(r.authStatus ?? ""), version: String(info.version ?? ""), tools, plugin: r.pluginId ? String(r.pluginId) : "", enabled: !disabled.has(String(r.name ?? r.id)) }; });
        return { servers, configPath: join(process.env.HOME ?? "", ".codex", "config.toml") };
      }
      case "skills": return { skills: await listSkills(cwd) };
      case "modes": { const custom = config.get<Record<string, unknown>[]>("modes", []); return { builtin: BUILTIN_MODES, custom }; }
      case "plugins": return { plugins: (await listPlugins(cwd)).filter((p) => p.kind === "plugin") };
      case "hooks": {
        const result = await cachedQuery("hooks/list", {}, cwd, { refresh: this.refresh }).catch(() => ({} as Record<string, unknown>));
        const groups = (Array.isArray(result.data) ? result.data : []) as { cwd?: string; hooks?: Record<string, unknown>[] }[];
        const hooks = groups.flatMap((g) => (g.hooks ?? []).map((h) => ({ event: String(h.eventName ?? ""), matcher: String(h.matcher ?? ""), command: String(h.command ?? h.handlerType ?? ""), source: String(h.sourcePath ?? ""), async: !!h.async, timeout: h.timeoutSec ? Number(h.timeoutSec) : 0 })));
        return { hooks, raw: hooks.length ? "" : JSON.stringify(result, null, 1).slice(0, 2000) };
      }
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
  .fresh { float: right; font-size: 11px; color: var(--t3); margin-top: 4px; } .fresh a { color: var(--t2); }
  .pill.warn { background: color-mix(in srgb, var(--vscode-charts-yellow, #D2943E) 20%, transparent); color: var(--vscode-charts-yellow, #D2943E); }
  .row details { font-size: 12px; color: var(--t2); } .row details code { font-size: 11px; background: var(--b4); padding: 1px 4px; border-radius: 3px; margin: 2px 2px 0 0; display: inline-block; } .row summary { cursor: pointer; }
  .row .l + .toggle, .row .l + button, .row .l + span { flex: 0 0 auto; }
  .form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; } .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--t2); } .form label input, .form label textarea { font: inherit; color: var(--fg); background: var(--vscode-input-background); border: 1px solid var(--s2); border-radius: 6px; padding: 5px 8px; }
  .form label:has(textarea), .form .flags, .form > div { grid-column: 1 / -1; } .form .flags { display: flex; flex-wrap: wrap; gap: 6px 14px; } .form .flag { flex-direction: row; align-items: center; gap: 6px; }
</style></head>
<body>
  <nav><h1>Muster Settings</h1></nav>
  <main id="main"></main>
<script>const vscode = acquireVsCodeApi();</script>
<script>
  const SECTIONS = [["general","General"],["models","Models"],["modes","Modes"],["rules","Rules"],["mcp","MCP"],["skills","Skills"],["plugins","Plugins"],["hooks","Hooks"],["docs","Docs"]];
  const nav = document.querySelector("nav"), main = document.getElementById("main");
  let current = "general";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  for (const [id, label] of SECTIONS) { const el = document.createElement("div"); el.className = "item" + (id === current ? " on" : ""); el.textContent = label; el.dataset.id = id; el.addEventListener("click", () => { current = id; [...nav.querySelectorAll(".item")].forEach((n) => n.classList.toggle("on", n.dataset.id === id)); vscode.postMessage({ type: "section", section: id }); }); nav.appendChild(el); }
  const row = (t, d, right) => '<div class="row"><div class="l"><div class="t">' + t + '</div>' + (d ? '<div class="d">' + d + '</div>' : "") + '</div>' + (right || "") + '</div>';
  function render(section, data, age) {
    if (data && data.error) { main.innerHTML = '<h2>' + esc(section) + '</h2><div class="empty">' + esc(data.error) + '</div>'; return; }
    let h = "";
    if (age !== undefined) h += '<div class="fresh">' + (age < 60000 ? "updated just now" : "updated " + Math.round(age / 60000) + " min ago") + ' · <a href="#" id="refresh">Refresh</a></div>';
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
      h += '<h2>Rules</h2><div class="sub">How Cursor attaches them: <b>Always</b> every turn · <b>Auto</b> when a mentioned file matches the globs · <b>Agent</b> offered by description (@rule:name loads it) · <b>Manual</b> only when mentioned. Files: .muster/rules/*.md, .cursor/rules/*.mdc.</div>';
      h += '<div style="margin:0 0 10px"><button class="primary" id="newRule">New rule</button></div>';
      if (data.userRules) h += row("User rules <span class=\\"pill\\">~/.codex/AGENTS.md</span>", esc(data.userRules.preview), '<button data-open="' + esc(data.userRules.path) + '">Open</button>');
      if (data.agentsMd) h += row("AGENTS.md <span class=\\"pill\\">project</span>", esc(data.agentsMd.preview), '<button data-open="' + esc(data.agentsMd.path) + '">Open</button>');
      const KIND = { always: "Always", auto: "Auto", agent: "Agent", manual: "Manual" };
      for (const r of data.rules) h += row(esc(r.name) + ' <span class="pill">' + esc(r.source) + '</span> <span class="pill ' + (r.kind === "always" ? "ok" : "") + '">' + KIND[r.kind] + (r.kind === "auto" ? ": " + esc(r.globs.join(", ")) : "") + '</span>', esc(r.description || r.preview), '<div class="toggle' + (r.enabled ? " on" : "") + '" data-rule="' + esc(r.name) + '" title="' + (r.enabled ? "Enabled" : "Disabled") + '"></div><button data-open="' + esc(r.path) + '">Open</button>');
      if (!data.rules.length) h += '<div class="empty">No rules yet.</div>';
    } else if (section === "mcp") {
      h += '<h2>MCP</h2><div class="sub">Servers Codex has loaded for this folder (mcpServerStatus/list). Switching one off here passes <code>mcp_servers.&lt;name&gt;.enabled=false</code> to Muster’s turns only; ~/.codex/config.toml stays yours.</div>';
      h += '<div style="margin:0 0 10px;display:flex;gap:8px"><button id="openConfig">Open ~/.codex/config.toml</button><button id="mcpLogs">Reveal logs</button></div>';
      for (const s of data.servers) {
        const health = !s.enabled ? '<span class="pill">disabled</span>' : s.auth === "notLoggedIn" ? '<span class="pill warn">needs login</span>' : (s.status && /error|fail/i.test(s.status)) ? '<span class="pill warn">' + esc(s.status) + '</span>' : '<span class="pill ok">' + esc(s.status || "connected") + '</span>';
        const tools = s.tools.length ? '<details><summary>' + s.tools.length + ' tool' + (s.tools.length === 1 ? "" : "s") + '</summary>' + s.tools.map((t) => '<code>' + esc(t) + '</code>').join(" ") + '</details>' : '<span class="d">no tools reported</span>';
        h += row(esc(s.name) + (s.version ? ' <span class="pill">v' + esc(s.version) + '</span>' : "") + (s.plugin ? ' <span class="pill">plugin</span>' : ""), tools, health + (s.auth === "notLoggedIn" ? '<button data-login="' + esc(s.name) + '">Login</button>' : "") + '<div class="toggle' + (s.enabled ? " on" : "") + '" data-mcp="' + esc(s.name) + '"></div>');
      }
      if (!data.servers.length) h += '<div class="empty">No MCP servers reported.</div>';
    } else if (section === "skills") {
      h += '<h2>Skills</h2><div class="sub">From skills/list; type / in the composer to use one.</div><div style="margin:0 0 10px"><button id="openSkills">Reveal ~/.codex/skills</button></div>';
      for (const s of data.skills) h += row(esc(s.name), esc(s.description), s.path ? '<button data-open="' + esc(s.path) + '">Open</button>' : "");
      if (!data.skills.length) h += '<div class="empty">No skills reported.</div>';
    } else if (section === "plugins") {
      h += '<h2>Plugins</h2><div class="sub">From plugin/list. Your Codex plugins work as they are; computer use answers its permission prompts in the chat.</div>';
      for (const p of data.plugins) h += row(esc(p.name), esc(p.detail), '<span class="pill ok">enabled</span>');
      if (!data.plugins.length) h += '<div class="empty">No plugins reported.</div>';
    } else if (section === "hooks") {
      h += '<h2>Hooks</h2><div class="sub">hooks/list as Codex reports it: user, project and plugin hooks in the order they run.</div>';
      for (const k of data.hooks) h += row('<span class="pill">' + esc(k.event) + '</span> ' + esc(k.command), (k.matcher ? "matcher " + esc(k.matcher) + " · " : "") + (k.async ? "async · " : "") + (k.timeout ? k.timeout + "s · " : "") + esc(k.source), k.source ? '<button data-open="' + esc(k.source) + '">Open</button>' : "");
      if (!data.hooks.length) h += '<div class="empty">No hooks.</div>' + (data.raw ? '<pre>' + esc(data.raw) + '</pre>' : "");
    } else if (section === "modes") {
      h += '<h2>Modes</h2><div class="sub">Built-in modes and your own. A custom mode carries the same behaviours as the built-ins (read-only, plan, auto-fix, parallel, board, spec, debug), a system prompt, an effort and a placeholder — ⌘. cycles them in the composer.</div>';
      const FLAGS = ["readOnly", "plan", "autoFix", "parallel", "board", "spec", "debug"];
      const flags = (m) => FLAGS.filter((f) => m[f]).map((f) => '<span class="pill">' + f + '</span>').join(" ");
      for (const m of data.builtin) h += row(esc(m.icon) + " " + esc(m.name) + ' <span class="pill">built-in</span>', esc(m.description || "") + (m.effort ? " · effort " + esc(m.effort) : ""), flags(m));
      for (const m of data.custom) h += row(esc(m.icon || "◆") + " " + esc(m.name) + ' <span class="pill ok">custom</span>', esc(m.description || m.placeholder || ""), flags(m) + ' <button data-editmode="' + esc(m.id) + '">Edit</button><button data-deletemode="' + esc(m.id) + '">Delete</button>');
      h += '<h3 style="margin:18px 0 6px;font-size:14px">Add or edit a mode</h3><form id="modeForm" class="form">';
      h += '<label>Id <input name="id" placeholder="review" required pattern="[a-z0-9-]+"></label><label>Name <input name="name" placeholder="Review" required></label><label>Icon <input name="icon" placeholder="◆" style="width:60px"></label>';
      h += '<label>Description <input name="description" placeholder="What this mode is for"></label><label>Placeholder <input name="placeholder" placeholder="Composer placeholder"></label><label>Effort <input name="effort" placeholder="low · medium · high · xhigh · max · ultra"></label>';
      h += '<label>System prompt <textarea name="prompt" rows="4" placeholder="Extra instructions sent with every turn in this mode"></textarea></label>';
      h += '<div class="flags">' + FLAGS.map((f) => '<label class="flag"><input type="checkbox" name="' + f + '"> ' + f + '</label>').join("") + '</div>';
      h += '<div style="margin-top:10px"><button class="primary" type="submit">Save mode</button></div></form>';
    } else if (section === "docs") {
      h += '<h2>Docs</h2><div class="sub">@Docs mentions: fetched once, cached under .muster/docs.</div>';
      h += '<div class="row"><input id="docName" placeholder="Name"><input id="docUrl" placeholder="https://…" style="flex:1"><button class="primary" id="addDoc">Add</button></div>';
      for (const d of data.docs) h += row(esc(d.name), esc(d.url), '<button data-removedoc="' + esc(d.name) + '">Remove</button>');
    }
    main.innerHTML = h;
    const rf = document.getElementById("refresh"); if (rf) rf.addEventListener("click", (e) => { e.preventDefault(); rf.textContent = "Refreshing…"; vscode.postMessage({ type: "refresh", section }); });
    main.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "open", path: b.dataset.open })));
    main.querySelectorAll("[data-rule]").forEach((t) => t.addEventListener("click", () => vscode.postMessage({ type: "toggleRule", name: t.dataset.rule })));
    main.querySelectorAll("[data-mcp]").forEach((t) => t.addEventListener("click", () => vscode.postMessage({ type: "toggleMcp", name: t.dataset.mcp })));
    main.querySelectorAll("[data-login]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "mcpLogin", name: b.dataset.login })));
    const ml = document.getElementById("mcpLogs"); if (ml) ml.addEventListener("click", () => vscode.postMessage({ type: "mcpLogs" }));
    main.querySelectorAll("[data-deletemode]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "deleteMode", name: b.dataset.deletemode })));
    main.querySelectorAll("[data-editmode]").forEach((b) => b.addEventListener("click", () => { const m = (data.custom || []).find((x) => x.id === b.dataset.editmode); const f = document.getElementById("modeForm"); if (!m || !f) return; for (const el of f.elements) { if (!el.name) continue; if (el.type === "checkbox") el.checked = !!m[el.name]; else el.value = m[el.name] || ""; } f.scrollIntoView({ block: "center" }); }));
    const mf = document.getElementById("modeForm"); if (mf) mf.addEventListener("submit", (e) => { e.preventDefault(); const mode = {}; for (const el of mf.elements) { if (!el.name) continue; if (el.type === "checkbox") { if (el.checked) mode[el.name] = true; } else if (el.value.trim()) mode[el.name] = el.value.trim(); } if (mode.id && mode.name) vscode.postMessage({ type: "saveMode", section: "modes", value: mode }); });
    main.querySelectorAll(".toggle").forEach((t) => t.addEventListener("click", () => vscode.postMessage({ type: "set", section, key: t.dataset.key, value: t.dataset.value === "true" })));
    const nr = document.getElementById("newRule"); if (nr) nr.addEventListener("click", () => vscode.postMessage({ type: "newRule" }));
    const oc = document.getElementById("openConfig"); if (oc) oc.addEventListener("click", () => vscode.postMessage({ type: "openConfig" }));
    const os = document.getElementById("openSkills"); if (os) os.addEventListener("click", () => vscode.postMessage({ type: "openSkills" }));
    const ad = document.getElementById("addDoc"); if (ad) ad.addEventListener("click", () => vscode.postMessage({ type: "addDoc", name: document.getElementById("docName").value.trim(), url: document.getElementById("docUrl").value.trim() }));
    main.querySelectorAll("[data-removedoc]").forEach((b) => b.addEventListener("click", () => vscode.postMessage({ type: "removeDoc", name: b.dataset.removedoc })));
  }
  window.addEventListener("message", (e) => { const m = e.data; if (m.type === "section") { current = m.section; [...nav.querySelectorAll(".item")].forEach((n) => n.classList.toggle("on", n.dataset.id === current)); render(m.section, m.data, m.age); } });
  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
