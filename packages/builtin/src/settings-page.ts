import { settingsHtml } from "./settings-view.js";
import { MUSTER_THEMES } from "./appearance.js";
// Muster Settings — Cursor's settings page shape (sidebar of sections, content on
// the right): General (account, usage, defaults), Models, Rules, MCP, Skills,
// Plugins, Hooks, Docs. Everything shown comes from the app-server or the
// workspace; nothing is hardcoded.
import * as vscode from "vscode";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_MODES } from "./agent-pane.js";
import { CLAUDE_EFFORTS, cachedQuery, catalogAge, listAccessModes, listModels, listPlugins, listRuleFiles, listSkills, queryCodex, setDisabledMcpServers } from "./codex.js";

type Section = "appearance" | "general" | "models" | "rules" | "mcp" | "skills" | "plugins" | "hooks" | "modes" | "docs";

export class SettingsPage {
  private panel: vscode.WebviewPanel | undefined;
  private activeSection: Section = "general";
  private renderRevision = 0;

  constructor(private readonly context: vscode.ExtensionContext, private readonly cwd: () => string) {}

  async open(section: Section = "general"): Promise<void> {
    this.activeSection = section;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("muster.settings", "Muster Settings", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "muster.svg");
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.html = settingsHtml(this.panel.webview.cspSource);
      this.panel.webview.onDidReceiveMessage((m: { type: string; section?: Section; key?: string; value?: unknown; path?: string; name?: string; url?: string }) => void this.onMessage(m));
    }
    this.panel.reveal();
    await this.push(section);
  }

  private async onMessage(m: { type: string; section?: Section; key?: string; value?: unknown; path?: string; name?: string; url?: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration("muster");
    switch (m.type) {
      case "theme": { if (MUSTER_THEMES.some(t => t.name === m.name)) await vscode.workspace.getConfiguration("workbench").update("colorTheme", m.name, vscode.ConfigurationTarget.Global); await this.push("appearance"); return; }
      case "resetAppearance": {
        await Promise.all(["ui.density", "ui.fontSize", "ui.accent", "ui.glass"].map((key) => config.update(key, undefined, vscode.ConfigurationTarget.Global)));
        await this.push("appearance"); return;
      }
      case "appearanceCommand": { if (["workbench.action.selectTheme", "workbench.action.selectIconTheme", "workbench.action.selectProductIconTheme", "workbench.action.openSettingsJson"].includes(String(m.name))) await vscode.commands.executeCommand(String(m.name)); return; }
      case "ready": await this.push(this.activeSection); return;
      case "section": await this.push(m.section ?? "general"); return;
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
    this.activeSection = section; const revision = ++this.renderRevision;
    this.refresh = refresh;
    try {
      const data = await this.data(section).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      const age = catalogAge({ general: "account/read", models: "model/list", mcp: "mcpServerStatus/list", skills: "skills/list", plugins: "plugin/list", hooks: "hooks/list" }[section as string] ?? "", section === "models" ? { includeHidden: false } : {}, this.cwd());
      if (revision !== this.renderRevision || !this.panel) return;
      await this.panel.webview.postMessage({ type: "section", section, data, ...(age !== undefined ? { age } : {}) });
    } finally { this.refresh = false; }
  }

  private async data(section: Section): Promise<unknown> {
    const cwd = this.cwd();
    const config = vscode.workspace.getConfiguration("muster");
    switch (section) {
      case "appearance": return { themes: MUSTER_THEMES, active: vscode.workspace.getConfiguration("workbench").get("colorTheme"), density: config.get("ui.density", "comfortable"), fontSize: config.get("ui.fontSize", 13), accent: config.get("ui.accent", ""), glass: config.get("ui.glass", true) };
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
