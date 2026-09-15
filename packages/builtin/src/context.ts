// Context kinds for the composer's "@" picker, after Cursor's mention sections:
// Files & Folders, Docs, Git (branch diff, working tree, commits), Terminals,
// Past Chats, Web, images. Tokens stay in the prompt (the model sees what was
// meant); their contents are appended as <context> blocks.
import { createHash } from "node:crypto";
import { uniqueMentions } from "./conversation-state.js";
import * as vscode from "vscode";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { formatAge, listThreads, readHistory, readRules, threadsForWorkspace } from "./codex.js";
import type { BrowserPick } from "./browser.js";

// ── browser: the last picked element / screenshot, and the live page context from the workbench guest ──
let lastPick: BrowserPick | undefined;
export function rememberPick(pick: BrowserPick): void { lastPick = pick; }
let browserProvider: (() => { url: string; title: string; console: { level: string; message: string; line?: number; source?: string }[] } | undefined) | undefined;
export function setBrowserProvider(fn: typeof browserProvider): void { browserProvider = fn; }
/** Frozen selections survive subsequent picks, navigation, and extension reloads. */
export function saveBrowserPick(cwd: string, pick: BrowserPick): string {
  const data = JSON.stringify(pick);
  const id = createHash("sha256").update(data).digest("hex").slice(0, 20);
  const dir = join(cwd, ".muster", "browser"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `context-${id}.json`), data);
  return `@browser:${id}`;
}
async function browserContext(pick?: BrowserPick): Promise<string | undefined> {
  const live = browserProvider?.() ?? ((await Promise.resolve(vscode.commands.executeCommand("muster.browser.context", {})).catch(() => null)) as { url?: string; title?: string; console?: { level: string | number; message: string; line?: number; source?: string }[] } | null);
  const parts: string[] = [];
  if (pick) parts.push(`url: ${pick.url}\ntitle: ${pick.title}`);
  else if (live?.url) parts.push(`url: ${live.url}${live.title ? `\ntitle: ${live.title}` : ""}`);
  const selected = pick ?? (lastPick?.url === live?.url ? lastPick : undefined);
  if (selected?.picked) { const p = selected.picked; parts.push(`selected element: ${p.selector}\nhtml: ${p.html.slice(0, 1200)}\ntext: ${p.text.slice(0, 200)}\nrect: ${JSON.stringify(p.rect)}\nstyles: ${Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`).join("; ")}`); }
  const consoleTail = (pick ? [] : live?.console ?? []).slice(-40).map((c) => `[${typeof c.level === "number" ? ["log", "warn", "error"][c.level] ?? c.level : c.level}] ${c.message}${c.source ? ` (${c.source.split("/").pop()}:${c.line ?? ""})` : ""}`);
  if (consoleTail.length) parts.push(`console:\n${consoleTail.join("\n")}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

const run = promisify(execFile);
const MAX_LINES = 300;

export interface ContextReference {
  readonly token: string;
  readonly kind: string;
  readonly source?: string;
  readonly sourceMtimeMs?: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly includedLines?: number;
  readonly truncated?: boolean;
  readonly unavailable?: boolean;
  readonly tokenEstimate: number;
}

export interface Suggestion { readonly label: string; readonly detail: string; readonly insert: string; readonly group?: string }
/** One row of the composer typeahead (Cursor's mention menu): a mention to insert, a navigation row into a mode, or an action. */
export interface MenuItem { readonly id: string; readonly label: string; readonly detail: string; readonly insert?: string; readonly icon: string; readonly iconKind: "cod" | "badge" | "slash"; readonly nav?: string; readonly action?: string }
export interface MenuSection { readonly title: string; readonly items: MenuItem[] }
export interface MenuData { readonly mode: string; readonly title: string; readonly sections: MenuSection[] }

// ── terminals: a ring buffer of what each terminal printed (terminalDataWriteEvent) ──
const terminalBuffers = new Map<vscode.Terminal, string>();
export function watchTerminals(context: vscode.ExtensionContext): void {
  try {
    context.subscriptions.push(vscode.window.onDidWriteTerminalData((e) => {
      const next = ((terminalBuffers.get(e.terminal) ?? "") + e.data).slice(-40_000);
      terminalBuffers.set(e.terminal, next);
    }));
    context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => terminalBuffers.delete(t)));
  } catch { /* proposal unavailable: no terminal context */ }
}
function terminalTail(name: string): string | undefined {
  const terminal = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.activeTerminal;
  if (!terminal) return undefined;
  const raw = terminalBuffers.get(terminal) ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
  return clean.split("\n").slice(-120).join("\n");
}

// ── git ──
async function git(cwd: string, args: string[]): Promise<string> {
  try { const { stdout } = await run("git", args, { cwd, maxBuffer: 4_000_000 }); return stdout; } catch { return ""; }
}
async function defaultBranch(cwd: string): Promise<string> {
  const ref = (await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
  if (ref) return ref.replace(/^refs\/remotes\/origin\//, "");
  for (const candidate of ["main", "master"]) if ((await git(cwd, ["rev-parse", "--verify", candidate])).trim()) return candidate;
  return "main";
}

// ── docs: user-configured URLs, fetched once and cached under .muster/docs ──
function docsList(): { name: string; url: string }[] {
  return vscode.workspace.getConfiguration("muster").get<{ name: string; url: string }[]>("docs", []).filter((d) => d.name && d.url);
}
async function docText(cwd: string, name: string): Promise<string | undefined> {
  const doc = docsList().find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!doc) return undefined;
  const dir = join(cwd, ".muster", "docs");
  const file = join(dir, `${doc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  try {
    const response = await fetch(doc.url, { headers: { "user-agent": "muster-code" } });
    const html = await response.text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    return text;
  } catch { return undefined; }
}

// ── the "@" typeahead (Cursor's mention menu) ──
// Answers within a keystroke: files from an in-memory index (refreshed in the background), commits from a
// short-lived cache, past chats from the last listing — never a process spawn on the keystroke path.
const index = { files: [] as string[], at: 0, building: null as Promise<void> | null, log: [] as string[], logAt: 0, chats: [] as MenuItem[], chatsAt: 0, chatsBuilding: false };
async function fileIndex(): Promise<string[]> {
  if (Date.now() - index.at > 45_000 || !index.files.length) {
    index.building ??= (async () => {
      try { const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,build,out,.next,coverage,target,.muster}/**", 8000); index.files = uris.map((u) => vscode.workspace.asRelativePath(u)).filter((r) => !r.startsWith("..")).sort((a, b) => a.length - b.length); index.at = Date.now(); }
      finally { index.building = null; }
    })();
    if (!index.files.length) await index.building;
  }
  return index.files;
}
/** Cursor-style ranking: file-name prefix, then file-name substring, path substring, then subsequence; shorter paths first. */
function score(rel: string, q: string): number {
  const name = (rel.split("/").pop() ?? rel).toLowerCase(); const lower = rel.toLowerCase(); const tie = rel.length / 1000;
  if (name.startsWith(q)) return 100 - tie; if (name.includes(q)) return 80 - tie; if (lower.includes(q)) return 60 - tie;
  let i = 0; for (const ch of lower) if (i < q.length && ch === q[i]) i++;
  return i === q.length ? 30 - tie : -1;
}
export function refreshMentionIndex(): void { index.at = 0; void fileIndex(); }
const openFiles = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => (t.input as { uri?: vscode.Uri })?.uri).filter((u): u is vscode.Uri => !!u && u.scheme === "file").map((u) => vscode.workspace.asRelativePath(u)).filter((r) => !r.startsWith(".."));
const fileItem = (r: string): MenuItem => { const name = r.split("/").pop() ?? r; const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ""; return { id: `f:${r}`, label: name, detail: dir, insert: `@${encodeURI(r)}`, icon: name.includes(".") ? name.split(".").pop()! : "file", iconKind: "badge" }; };
const rankedFiles = (all: string[], q: string, limit: number) => all.map((r) => [score(r, q), r] as const).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, r]) => r);
function refreshChats(cwd: string): MenuItem[] {
  if (Date.now() - index.chatsAt > 60_000 && !index.chatsBuilding) {
    index.chatsBuilding = true;
    void listThreads().then((threads) => { index.chats = threadsForWorkspace(threads, [cwd]).slice(0, 20).map((t) => ({ id: `c:${t.id}`, label: t.name, detail: `${t.turnCount} turns · ${formatAge(t.lastActivityAt)}`, insert: `@chat:${t.id}`, icon: "comment-discussion", iconKind: "cod" as const })); index.chatsAt = Date.now(); }).finally(() => { index.chatsBuilding = false; });
  }
  return index.chats;
}
async function commits(cwd: string): Promise<MenuItem[]> {
  if (Date.now() - index.logAt > 15_000) { index.log = (await git(cwd, ["log", "--oneline", "-12"])).split("\n").filter(Boolean); index.logAt = Date.now(); }
  return index.log.map((line) => { const [sha, ...rest] = line.split(" "); return { id: `g:${sha}`, label: rest.join(" ").slice(0, 60), detail: sha ?? "", insert: `@git:commit:${sha}`, icon: "git-commit", iconKind: "cod" as const }; });
}
const matches = (it: MenuItem, q: string) => !q || it.label.toLowerCase().includes(q) || it.detail.toLowerCase().includes(q) || (it.insert ?? "").toLowerCase().includes(q);

/** Menu data for a query and mode ("all", or a category entered from a navigation row). */
export async function suggestMentions(cwd: string, query: string, mode = "all"): Promise<MenuData> {
  const q = query.toLowerCase();
  const all = await fileIndex();
  const open = openFiles();
  const docs = docsList().map((d): MenuItem => ({ id: `d:${d.name}`, label: d.name, detail: d.url.replace(/^https?:\/\//, "").slice(0, 40), insert: `@docs:${d.name}`, icon: "book", iconKind: "cod" }));
  const terminals = vscode.window.terminals.map((t): MenuItem => ({ id: `t:${t.name}`, label: t.name, detail: t === vscode.window.activeTerminal ? "active terminal" : "terminal", insert: t === vscode.window.activeTerminal ? "@terminal" : `@terminal:${t.name}`, icon: "terminal", iconKind: "cod" }));
  const browser = browserProvider?.();
  const direct: MenuItem[] = [
    { id: "branch", label: "Branch (Diff with Main)", detail: "", insert: "@git:branch", icon: "git-branch", iconKind: "cod" },
    { id: "diff", label: "Working Tree", detail: "uncommitted changes", insert: "@git:diff", icon: "git-branch", iconKind: "cod" },
    { id: "web", label: "Web", detail: "search the web", insert: "@web", icon: "globe", iconKind: "cod" },
    { id: "pr", label: "Pull Request", detail: "the open PR (gh) or the branch diff", insert: "@git:pr", icon: "git-pull-request", iconKind: "cod" },
    ...(browser ? [{ id: "browser", label: "Browser", detail: (browser.title || browser.url || "").slice(0, 40), insert: "@browser", icon: "browser", iconKind: "cod" as const }] : []),
  ];
  const chats = refreshChats(cwd);
  const rules = listRules(cwd).map((r): MenuItem => ({ id: `r:${r.name}`, label: r.name, detail: relative(cwd, r.path), insert: `@rule:${r.name}`, icon: "note", iconKind: "cod" }));
  const dirs = [...new Set(all.filter((r) => r.includes("/")).map((r) => r.slice(0, r.lastIndexOf("/"))))];
  const folderItem = (d: string): MenuItem => ({ id: `dir:${d}`, label: d.split("/").pop() ?? d, detail: d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "", insert: `@${d}/`, icon: "folder", iconKind: "cod" });
  const rankedDirs = (limit: number) => (q ? dirs.map((d) => [score(d, q), d] as const).filter(([sc]) => sc >= 0).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, d]) => d) : dirs.slice(0, limit)).map(folderItem);
  const isUrl = /^(https?:\/\/|www\.)\S+$/i.test(query);
  const linkItem: MenuItem[] = isUrl ? [{ id: "link", label: "Link", detail: query.slice(0, 60), insert: `@link:${query.startsWith("www.") ? "https://" + query : query}`, icon: "link", iconKind: "cod" }] : [];
  const codeItems = async (): Promise<MenuItem[]> => {
    if (q.length < 2 || isUrl) return [];
    const symbols = await Promise.race([vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query), new Promise<vscode.SymbolInformation[]>((r) => setTimeout(() => r([]), 250))]).catch(() => [] as vscode.SymbolInformation[]);
    const fromService = (symbols ?? []).filter((sym) => sym.location.uri.scheme === "file" && !vscode.workspace.asRelativePath(sym.location.uri).startsWith("..")).slice(0, 5).map((sym): MenuItem => ({ id: `sym:${sym.name}:${sym.location.uri.fsPath}`, label: sym.name, detail: `${vscode.workspace.asRelativePath(sym.location.uri)}:${sym.location.range.start.line + 1}`, insert: `@code:${sym.name}`, icon: "symbol-method", iconKind: "cod" }));
    if (fromService.length) return fromService;
    return (await grepDefinitions(cwd, query, 5, true)).map((h): MenuItem => ({ id: `sym:${h.name}:${h.file}`, label: h.name, detail: `${h.file}:${h.line}`, insert: `@code:${h.name}`, icon: "symbol-method", iconKind: "cod" }));
  };
  switch (mode) {
    case "files": return { mode, title: "Files & Folders", sections: [{ title: "", items: [...(q ? rankedFiles(all, q, 12) : [...new Set([...open, ...all])].slice(0, 12)).map(fileItem), ...rankedDirs(q ? 4 : 3)] }] };
    case "rules": return { mode, title: "Rules", sections: [{ title: "", items: [{ id: "rules-all", label: "All rules", detail: `${rules.length} file(s)`, insert: "@rules", icon: "note", iconKind: "cod" }, ...rules.filter((r) => matches(r, q))] }] };
    case "code": return { mode, title: "Code", sections: [{ title: "", items: await codeItems() }] };
    case "chats": return { mode, title: "Past Chats", sections: [{ title: "", items: chats.filter((c) => matches(c, q)).slice(0, 12) }] };
    case "docs": return { mode, title: "Docs", sections: [{ title: "", items: docs.filter((d) => matches(d, q)) }] };
    case "terminals": return { mode, title: "Terminals", sections: [{ title: "", items: terminals.filter((t) => matches(t, q)) }] };
    case "commits": return { mode, title: "Commits", sections: [{ title: "", items: (await commits(cwd)).filter((c) => matches(c, q)) }] };
    default: {
      if (!q) {
        // Cursor's empty state: a few recent files on top, then the categories as navigation rows and the direct kinds.
        const top = [...new Set(open)].slice(0, 3).map(fileItem);
        const nav: MenuItem[] = [
          { id: "nav:files", label: "Files & Folders", detail: "", icon: "folder", iconKind: "cod", nav: "files" },
          { id: "nav:chats", label: "Past Chats", detail: "", icon: "comment-discussion", iconKind: "cod", nav: "chats" },
          ...(docs.length ? [{ id: "nav:docs", label: "Docs", detail: "", icon: "book", iconKind: "cod" as const, nav: "docs" }] : []),
          ...(terminals.length ? [{ id: "nav:terminals", label: "Terminals", detail: "", icon: "terminal", iconKind: "cod" as const, nav: "terminals" }] : []),
          { id: "nav:commits", label: "Commits", detail: "", icon: "git-commit", iconKind: "cod", nav: "commits" },
          { id: "nav:code", label: "Code", detail: "symbols", icon: "symbol-method", iconKind: "cod", nav: "code" },
          ...(rules.length ? [{ id: "nav:rules", label: "Rules", detail: "", icon: "note", iconKind: "cod" as const, nav: "rules" }] : []),
        ];
        return { mode: "all", title: "Mentions", sections: [...(top.length ? [{ title: "", items: top }] : []), { title: "", items: [...nav, ...direct] }] };
      }
      const items: MenuItem[] = [
        ...linkItem,
        ...rankedFiles(all, q, 8).map(fileItem),
        ...rankedDirs(2),
        ...(await codeItems()),
        ...rules.filter((r) => matches(r, q)).slice(0, 3),
        ...direct.filter((d) => matches(d, q)),
        ...docs.filter((d) => matches(d, q)).slice(0, 3),
        ...terminals.filter((t) => matches(t, q)).slice(0, 3),
        ...chats.filter((c) => matches(c, q)).slice(0, 3),
        ...(/^[0-9a-f]{3,}$/.test(q) || /^(git|com|log)/.test(q) ? (await commits(cwd)).filter((c) => matches(c, q)).slice(0, 3) : []),
      ];
      return { mode: "all", title: "Results", sections: [{ title: "Results", items }] };
    }
  }
}

// ── the "/" typeahead: commands, custom commands, skills ──
export interface CustomCommand { readonly name: string; readonly path: string; readonly source: "project" | "user"; readonly subdir?: string; readonly description: string }
const commandCache = { at: 0, cwd: "", list: [] as CustomCommand[] };
/** `.cursor/commands`, `.claude/commands`, `.muster/commands` in the workspace and the home directory (*.md / *.txt), the way Cursor loads them. */
export function listCommands(cwd: string): CustomCommand[] {
  if (commandCache.cwd === cwd && Date.now() - commandCache.at < 30_000) return commandCache.list;
  const out: CustomCommand[] = [];
  const dirs = [".cursor/commands", ".claude/commands", ".muster/commands"];
  const roots: { dir: string; source: "project" | "user" }[] = [...dirs.map((d) => ({ dir: join(cwd, d), source: "project" as const })), ...dirs.map((d) => ({ dir: join(homedir(), d), source: "user" as const }))];
  const walk = (dir: string, rel: string, source: "project" | "user") => {
    let entries: string[] = []; try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e); let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, rel ? `${rel}/${e}` : e, source); continue; }
      if (!/\.(md|txt)$/i.test(e)) continue;
      const name = e.replace(/\.(md|txt)$/i, "");
      if (out.some((c) => c.name === name)) continue;
      let description = ""; try { const text = readFileSync(full, "utf8"); const fm = /^---\n([\s\S]*?)\n---/.exec(text); const d = fm && /^description:\s*(.+)$/m.exec(fm[1]!); description = (d?.[1] ?? text.replace(/^---[\s\S]*?---\s*/, "").split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim().slice(0, 80); } catch { /* unreadable */ }
      out.push({ name, path: full, source, ...(rel ? { subdir: rel } : {}), description });
    }
  };
  for (const r of roots) walk(r.dir, "", r.source);
  commandCache.at = Date.now(); commandCache.cwd = cwd; commandCache.list = out;
  return out;
}
export function suggestSlash(cwd: string, query: string, skills: { name: string; description: string }[]): MenuData {
  const q = query.toLowerCase();
  const builtins: MenuItem[] = [
    { id: "reset", label: "Reset", detail: "Start a new chat", icon: "refresh", iconKind: "cod", action: "reset" },
    { id: "summarize", label: "Summarize", detail: "Summarize the chat so far", icon: "note", iconKind: "cod", action: "summarize" },
    { id: "review", label: "Agent Review", detail: "Review the working tree changes", icon: "checklist", iconKind: "cod", action: "review" },
    { id: "browser", label: "Open Browser", detail: "Open a browser tab", icon: "browser", iconKind: "cod", action: "browser" },
  ];
  const custom = listCommands(cwd).map((c): MenuItem => ({ id: `cmd:${c.path}`, label: `/${c.name}`, detail: c.description || (c.subdir ? `/${c.subdir}` : c.source === "project" ? "Project" : "User"), insert: `/${c.name}`, icon: "play", iconKind: "cod" }));
  const skillItems = skills.map((s): MenuItem => ({ id: `skill:${s.name}`, label: `/${s.name}`, detail: s.description, insert: `/${s.name}`, icon: "sparkle", iconKind: "cod" }));
  const sections: MenuSection[] = [
    { title: "Commands", items: [...builtins, ...custom].filter((it) => matches(it, q)).slice(0, 12) },
    { title: "Skills", items: skillItems.filter((it) => matches(it, q)).slice(0, 12) },
  ].filter((sec) => sec.items.length);
  return { mode: "all", title: "Commands", sections };
}

// ── expansion helpers for the newer kinds ──
function isDirectory(abs: string): boolean { try { return existsSync(abs) && statSync(abs).isDirectory(); } catch { return false; } }
/** `@link:` — the page as text (HTML stripped), 10 s budget. */
async function fetchText(url: string): Promise<string> {
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "muster-code" } }); clearTimeout(timer);
    const raw = await res.text(); const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return raw.slice(0, 60_000);
    return raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 60_000);
  } catch { return ""; }
}
/** `@code:Name` — the symbol's source from the language service (workspace symbols → document symbol range). */
async function symbolText(cwd: string, name: string): Promise<string> {
  const symbols = ((await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", name)) ?? []).filter((sym) => sym.name === name || sym.name.startsWith(name)).slice(0, 3);
  const out: string[] = [];
  for (const sym of symbols) {
    if (!sym.location.uri.fsPath.startsWith(cwd)) continue;
    const doc = await vscode.workspace.openTextDocument(sym.location.uri);
    const flat: vscode.DocumentSymbol[] = []; const walk = (list: vscode.DocumentSymbol[]) => { for (const d of list) { flat.push(d); walk(d.children); } };
    walk(((await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", sym.location.uri)) ?? []));
    const full = flat.find((d) => d.name === sym.name && d.range.contains(sym.location.range.start));
    const range = full?.range ?? sym.location.range;
    const text = doc.getText(new vscode.Range(range.start.line, 0, Math.min(range.end.line + 1, doc.lineCount), 0));
    out.push(`<symbol name="${sym.name}" file="${vscode.workspace.asRelativePath(sym.location.uri)}:${range.start.line + 1}-${range.end.line + 1}">\n${text.split("\n").slice(0, 200).join("\n")}\n</symbol>`);
  }
  if (out.length) return out.join("\n");
  // No language service answer (project not loaded yet): find the definition with git grep and take the lines around it.
  const hits = await grepDefinitions(cwd, name, 3);
  for (const h of hits) {
    try { const lines = readFileSync(join(cwd, h.file), "utf8").split("\n"); const from = Math.max(0, h.line - 1); const text = lines.slice(from, from + 120).join("\n"); out.push(`<symbol name="${h.name}" file="${h.file}:${h.line}">\n${text}\n</symbol>`); } catch { /* skip */ }
  }
  return out.join("\n");
}
const DEF_KEYWORDS = "function\\*?|class|interface|type|enum|const|let|var|def|fn|struct|trait|impl|func|module";
/** Definitions matching a name (or prefix) via `git grep`, as a fallback for `@code:` and the Code category. */
async function grepDefinitions(cwd: string, name: string, limit: number, prefix = false): Promise<{ name: string; file: string; line: number }[]> {
  if (!/^[\w$]+$/.test(name)) return [];
  // POSIX ERE for git grep (no (?:…) groups): optional export/default/async, a definition keyword, the name (or prefix).
  const pattern = `(^|[[:space:]])(export[[:space:]]+)?(default[[:space:]]+)?(async[[:space:]]+)?(pub[[:space:]]+)?(${DEF_KEYWORDS})[[:space:]]+${name}${prefix ? "[A-Za-z0-9_]*" : ""}([^A-Za-z0-9_]|$)`;
  const raw = await git(cwd, ["grep", "-n", "-I", "-E", "--", pattern, "--", ":!node_modules", ":!dist", ":!*.min.js", ":!*.map"]);
  const out: { name: string; file: string; line: number }[] = [];
  for (const line of raw.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line); if (!m) continue;
    const nm = new RegExp(`(?:${DEF_KEYWORDS})\\s+(${name}[A-Za-z0-9_]*)`).exec(m[3]!)?.[1] ?? name;
    if (out.some((o) => o.name === nm && o.file === m[1])) continue;
    out.push({ name: nm, file: m[1]!, line: Number(m[2]) }); if (out.length >= limit) break;
  }
  return out;
}
const RULE_DIRS = (cwd: string) => [join(cwd, ".muster", "rules"), join(cwd, ".cursor", "rules")];
function readRule(cwd: string, name: string): string { for (const dir of RULE_DIRS(cwd)) for (const ext of ["", ".md", ".mdc"]) { const p = join(dir, name + ext); try { if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, "utf8"); } catch { /* skip */ } } return ""; }
export function listRules(cwd: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const dir of RULE_DIRS(cwd)) { if (!existsSync(dir)) continue; for (const f of readdirSync(dir).sort()) if (/\.(md|mdc)$/.test(f)) out.push({ name: f.replace(/\.(md|mdc)$/, ""), path: join(dir, f) }); }
  return out;
}
/** `@git:pr` — the pull request through `gh` (title, body, diff); without gh, the branch diff against the default branch. */
async function prContext(cwd: string): Promise<string> {
  const gh = (args: string[]) => new Promise<string>((r) => execFile("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (e, out) => r(e ? "" : String(out))));
  const view = await gh(["pr", "view", "--json", "number,title,body,baseRefName,headRefName,url"]);
  if (!view) { const base = await defaultBranch(cwd); const d = await git(cwd, ["diff", `${base}...HEAD`]); return d.trim() ? `<pull-request note="no gh pull request; branch diff vs ${base}">\n${d.split("\n").slice(0, MAX_LINES).join("\n")}\n</pull-request>` : ""; }
  const diff = await gh(["pr", "diff"]);
  return `<pull-request>\n${view.trim()}\n${diff.split("\n").slice(0, MAX_LINES).join("\n")}\n</pull-request>`;
}
/** `@folder` — the tree (3 levels, 200 entries) with sizes. */
function folderListing(cwd: string, rel: string): string {
  const abs = join(cwd, rel); const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= 200 || depth > 3) return;
    let entries: string[] = []; try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const e of entries) {
      if (/^(node_modules|\.git|dist|build|out|coverage)$/.test(e)) continue;
      const p = join(dir, e); let st; try { st = statSync(p); } catch { continue; }
      const r = relative(abs, p);
      if (st.isDirectory()) { out.push(`${r}/`); walk(p, depth + 1); } else out.push(`${r} (${st.size} B)`);
      if (out.length >= 200) { out.push("…"); return; }
    }
  };
  walk(abs, 0); return out.join("\n");
}

// ── expansion: every mention kind becomes a context block ──
export async function expandContext(prompt: string, cwd: string): Promise<{ prompt: string; images: string[]; references: ContextReference[] }> {
  // A leading /command from .cursor|.claude|.muster/commands becomes its file content ($ARGUMENTS or appended arguments).
  const slash = /^\s*\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (slash) { const cmd = listCommands(cwd).find((c) => c.name === slash[1]); if (cmd) { try { const body = readFileSync(cmd.path, "utf8").replace(/^---[\s\S]*?---\s*/, ""); const args = slash[2]?.trim() ?? ""; prompt = body.includes("$ARGUMENTS") ? body.replace(/\$ARGUMENTS/g, args) : args ? `${body}\n\n${args}` : body; } catch { /* keep the prompt */ } } }
  const blocks: string[] = [];
  const images: string[] = [];
  const references: ContextReference[] = [];
  const addReference = (token: string, kind: string, text: string, meta: Omit<ContextReference, "token" | "kind" | "tokenEstimate"> = {}) => {
    blocks.push(text);
    references.push({ token, kind, ...meta, tokenEstimate: Math.ceil(text.length / 4) });
  };
  const clip = (text: string, path = "") => { const lines = text.split("\n"); return `${lines.slice(0, MAX_LINES).join("\n")}${lines.length > MAX_LINES ? `\n… (${lines.length - MAX_LINES} more lines${path ? ` in ${path}` : ""})` : ""}`; };
  for (const rawToken of uniqueMentions(prompt)) {
    let token: string; try { token = decodeURIComponent(rawToken); } catch { token = rawToken; }
    if (token.startsWith("link:") || /^https?:\/\//.test(token)) { const url = token.startsWith("link:") ? token.slice(5) : token; const text = await fetchText(url); if (text) { const body = clip(text); addReference(token, "link", `<link url="${url}">\n${body}\n</link>`, { source: url, truncated: body.length < text.length }); } else references.push({ token, kind: "link", source: url, unavailable: true, tokenEstimate: 0 }); continue; }
    if (token.startsWith("code:") || token.startsWith("symbol:")) { const found = await symbolText(cwd, token.slice(token.indexOf(":") + 1)); if (found) addReference(token, "symbol", found); else references.push({ token, kind: "symbol", unavailable: true, tokenEstimate: 0 }); continue; }
    if (token === "rules" || token.startsWith("rule:")) { const text = token === "rules" ? readRules(cwd) : readRule(cwd, token.slice(5)); if (text) { const body = clip(text); addReference(token, "rules", `<rules${token === "rules" ? "" : ` name="${token.slice(5)}"`}>\n${body}\n</rules>`, { truncated: body.length < text.length }); } else references.push({ token, kind: "rules", unavailable: true, tokenEstimate: 0 }); continue; }
    if (token === "git:pr") { const pr = await prContext(cwd); if (pr) addReference(token, "git-pr", pr); continue; }
    if (token.startsWith("folder:") || (isDirectory(join(cwd, token.replace(/\/$/, ""))) && !/:\d+-\d+$/.test(token))) { const rel = (token.startsWith("folder:") ? token.slice(7) : token).replace(/\/$/, ""); const listing = folderListing(cwd, rel); if (listing) addReference(token, "folder", `<folder path="${rel}">\n${listing}\n</folder>`, { source: join(cwd, rel) }); continue; }
    if (/^browser:[a-f0-9]{20}$/.test(token)) {
      try { const snapshot = join(cwd, ".muster", "browser", `context-${token.slice(8)}.json`); const pick = JSON.parse(readFileSync(snapshot, "utf8")) as BrowserPick; const ctx = await browserContext(pick); if (ctx) addReference(token, "browser", `<browser selection="${token}">\n${ctx}\n</browser>`, { source: snapshot, sourceMtimeMs: statSync(snapshot).mtimeMs }); }
      catch { addReference(token, "browser", `<context-unavailable ref="${token}">Saved selection is unavailable. Ask to attach it again if needed.</context-unavailable>`, { source: join(cwd, ".muster", "browser", `context-${token.slice(8)}.json`) }); }
      continue;
    }
    if (token === "browser" || token === "browser:console") { const ctx = await browserContext(); if (ctx) addReference(token, "browser", `<browser>\n${ctx}\n</browser>`); continue; }
    if (token === "web") { addReference(token, "instruction", "<instruction>Use web search for anything that needs current or external information.</instruction>"); continue; }
    if (token === "terminal" || token.startsWith("terminal:")) { const tail = terminalTail(token.slice("terminal:".length)); if (tail) addReference(token, "terminal", `<terminal>\n${tail}\n</terminal>`); continue; }
    if (token === "git:diff") { const d = await git(cwd, ["diff"]); if (d.trim()) { const body = clip(d); addReference(token, "git-diff", `<git-diff>\n${body}\n</git-diff>`, { truncated: body.length < d.length }); } continue; }
    if (token === "git:branch") { const base = await defaultBranch(cwd); const d = await git(cwd, ["diff", `${base}...HEAD`]); const body = clip(d || "(no differences)"); addReference(token, "git-branch", `<git-branch-diff base="${base}">\n${body}\n</git-branch-diff>`, { source: base, truncated: body.length < d.length }); continue; }
    if (token.startsWith("git:commit:")) { const sha = token.slice("git:commit:".length); const d = await git(cwd, ["show", "--stat", "--patch", sha]); if (d.trim()) { const body = clip(d); addReference(token, "git-commit", `<git-commit sha="${sha}">\n${body}\n</git-commit>`, { source: sha, truncated: body.length < d.length }); } continue; }
    if (token.startsWith("docs:")) { const text = await docText(cwd, token.slice(5)); if (text) { const body = clip(text); addReference(token, "docs", `<doc name="${token.slice(5)}">\n${body}\n</doc>`, { source: token.slice(5), truncated: body.length < text.length }); } continue; }
    if (token.startsWith("chat:")) { const id = token.slice(5); const thread = threadsForWorkspace(await listThreads(), [cwd]).find((t) => t.id === id); if (thread) { const history = await readHistory(thread); const tail = history.slice(-4).map((m) => `${m.role}: ${m.text.slice(0, 1500)}`).join("\n\n"); addReference(token, "chat", `<past-chat name="${thread.name}">\n${tail}\n</past-chat>`, { source: thread.id }); } continue; }
    if (token.startsWith("image:")) { const path = token.slice(6); if (existsSync(path)) { images.push(path); references.push({ token, kind: "image", source: path, sourceMtimeMs: statSync(path).mtimeMs, tokenEstimate: 0 }); } else references.push({ token, kind: "image", source: path, unavailable: true, tokenEstimate: 0 }); continue; }
    const rel = token.replace(/:\d+-\d+$/, "");
    const range = /:(\d+)-(\d+)$/.exec(token);
    const abs = join(cwd, rel);
    if (!existsSync(abs)) { references.push({ token, kind: "file", source: abs, unavailable: true, tokenEstimate: 0 }); continue; }
    try {
      const lines = readFileSync(abs, "utf8").split("\n");
      const slice = range ? lines.slice(Number(range[1]) - 1, Number(range[2])) : lines.slice(0, 400);
      const truncated = !range && lines.length > 400;
      addReference(token, "file", `<file path="${rel}"${range ? ` lines="${range[1]}-${range[2]}"` : ""}>\n${slice.join("\n")}${truncated ? "\n… (truncated)" : ""}\n</file>`, { source: abs, sourceMtimeMs: statSync(abs).mtimeMs, ...(range ? { startLine: Number(range[1]), endLine: Number(range[2]) } : {}), includedLines: slice.length, truncated });
    } catch { /* directories and binaries are skipped */ }
  }
  // Keep the inspector truthful: a supported mention that produced no block
  // is still visible as unavailable rather than silently disappearing.
  const included = new Set(references.map((reference) => reference.token));
  for (const rawToken of uniqueMentions(prompt)) {
    let token: string; try { token = decodeURIComponent(rawToken); } catch { token = rawToken; }
    if (included.has(token)) continue;
    const kind = token.startsWith("link:") || /^https?:\/\//.test(token) ? "link" : token.startsWith("image:") ? "image" : token.startsWith("browser") ? "browser" : token.startsWith("git:") ? "git" : token.startsWith("terminal") ? "terminal" : token.startsWith("docs:") ? "docs" : token.startsWith("chat:") ? "chat" : token.startsWith("code:") || token.startsWith("symbol:") ? "symbol" : token.startsWith("rule") ? "rules" : token.startsWith("folder:") ? "folder" : "file";
    references.push({ token, kind, unavailable: true, tokenEstimate: 0 });
  }
  const cleaned = prompt.replace(/(^|\s)@image:[^\s]+/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { prompt: blocks.length ? `${cleaned}\n\nContext:\n${blocks.join("\n")}` : cleaned, images, references };
}
