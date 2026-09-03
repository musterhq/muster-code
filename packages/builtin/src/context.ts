// Context kinds for the composer's "@" picker, after Cursor's mention sections:
// Files & Folders, Docs, Git (branch diff, working tree, commits), Terminals,
// Past Chats, Web, images. Tokens stay in the prompt (the model sees what was
// meant); their contents are appended as <context> blocks.
import * as vscode from "vscode";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { formatAge, listThreads, readHistory, threadsForWorkspace } from "./codex.js";
import type { BrowserPick } from "./browser.js";

// ── browser: the last picked element / screenshot, and the live page context from the workbench guest ──
let lastPick: BrowserPick | undefined;
export function rememberPick(pick: BrowserPick): void { lastPick = pick; }
let browserProvider: (() => { url: string; title: string; console: { level: string; message: string; line?: number; source?: string }[] } | undefined) | undefined;
export function setBrowserProvider(fn: typeof browserProvider): void { browserProvider = fn; }
async function browserContext(): Promise<string | undefined> {
  const live = browserProvider?.() ?? ((await Promise.resolve(vscode.commands.executeCommand("muster.browser.context", {})).catch(() => null)) as { url?: string; title?: string; console?: { level: string | number; message: string; line?: number; source?: string }[] } | null);
  const parts: string[] = [];
  if (live?.url) parts.push(`url: ${live.url}${live.title ? `\ntitle: ${live.title}` : ""}`);
  if (lastPick?.picked) { const p = lastPick.picked; parts.push(`selected element: ${p.selector}\nhtml: ${p.html.slice(0, 1200)}\ntext: ${p.text.slice(0, 200)}\nrect: ${JSON.stringify(p.rect)}\nstyles: ${Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`).join("; ")}`); }
  const consoleTail = (live?.console ?? []).slice(-40).map((c) => `[${typeof c.level === "number" ? ["log", "warn", "error"][c.level] ?? c.level : c.level}] ${c.message}${c.source ? ` (${c.source.split("/").pop()}:${c.line ?? ""})` : ""}`);
  if (consoleTail.length) parts.push(`console:\n${consoleTail.join("\n")}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

const run = promisify(execFile);
const MAX_LINES = 300;

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
const fileItem = (r: string): MenuItem => { const name = r.split("/").pop() ?? r; const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ""; return { id: `f:${r}`, label: name, detail: dir, insert: `@${r}`, icon: name.includes(".") ? name.split(".").pop()! : "file", iconKind: "badge" }; };
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
    ...(browser ? [{ id: "browser", label: "Browser", detail: (browser.title || browser.url || "").slice(0, 40), insert: "@browser", icon: "browser", iconKind: "cod" as const }] : []),
  ];
  const chats = refreshChats(cwd);
  switch (mode) {
    case "files": return { mode, title: "Files & Folders", sections: [{ title: "", items: (q ? rankedFiles(all, q, 15) : [...new Set([...open, ...all])].slice(0, 15)).map(fileItem) }] };
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
        ];
        return { mode: "all", title: "Mentions", sections: [...(top.length ? [{ title: "", items: top }] : []), { title: "", items: [...nav, ...direct] }] };
      }
      const items: MenuItem[] = [
        ...rankedFiles(all, q, 8).map(fileItem),
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

// ── expansion: every mention kind becomes a context block ──
export async function expandContext(prompt: string, cwd: string): Promise<{ prompt: string; images: string[] }> {
  // A leading /command from .cursor|.claude|.muster/commands becomes its file content ($ARGUMENTS or appended arguments).
  const slash = /^\s*\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (slash) { const cmd = listCommands(cwd).find((c) => c.name === slash[1]); if (cmd) { try { const body = readFileSync(cmd.path, "utf8").replace(/^---[\s\S]*?---\s*/, ""); const args = slash[2]?.trim() ?? ""; prompt = body.includes("$ARGUMENTS") ? body.replace(/\$ARGUMENTS/g, args) : args ? `${body}\n\n${args}` : body; } catch { /* keep the prompt */ } } }
  const blocks: string[] = [];
  const images: string[] = [];
  const clip = (text: string, path = "") => { const lines = text.split("\n"); return `${lines.slice(0, MAX_LINES).join("\n")}${lines.length > MAX_LINES ? `\n… (${lines.length - MAX_LINES} more lines${path ? ` in ${path}` : ""})` : ""}`; };
  for (const match of prompt.matchAll(/(?:^|\s)@([\w./:-]+)/g)) {
    const token = match[1]!;
    if (blocks.length >= 12) break;
    if (token === "browser" || token === "browser:console") { const ctx = await browserContext(); if (ctx) blocks.push(`<browser>\n${ctx}\n</browser>`); continue; }
    if (token === "web") { blocks.push("<instruction>Use web search for anything that needs current or external information.</instruction>"); continue; }
    if (token === "terminal" || token.startsWith("terminal:")) { const tail = terminalTail(token.slice("terminal:".length)); if (tail) blocks.push(`<terminal>\n${tail}\n</terminal>`); continue; }
    if (token === "git:diff") { const d = await git(cwd, ["diff"]); if (d.trim()) blocks.push(`<git-diff>\n${clip(d)}\n</git-diff>`); continue; }
    if (token === "git:branch") { const base = await defaultBranch(cwd); const d = await git(cwd, ["diff", `${base}...HEAD`]); blocks.push(`<git-branch-diff base="${base}">\n${clip(d || "(no differences)")}\n</git-branch-diff>`); continue; }
    if (token.startsWith("git:commit:")) { const sha = token.slice("git:commit:".length); const d = await git(cwd, ["show", "--stat", "--patch", sha]); if (d.trim()) blocks.push(`<git-commit sha="${sha}">\n${clip(d)}\n</git-commit>`); continue; }
    if (token.startsWith("docs:")) { const text = await docText(cwd, token.slice(5)); if (text) blocks.push(`<doc name="${token.slice(5)}">\n${clip(text)}\n</doc>`); continue; }
    if (token.startsWith("chat:")) { const id = token.slice(5); const thread = threadsForWorkspace(await listThreads(), [cwd]).find((t) => t.id === id); if (thread) { const history = await readHistory(thread); const tail = history.slice(-4).map((m) => `${m.role}: ${m.text.slice(0, 1500)}`).join("\n\n"); blocks.push(`<past-chat name="${thread.name}">\n${tail}\n</past-chat>`); } continue; }
    if (token.startsWith("image:")) { const path = token.slice(6); if (existsSync(path)) images.push(path); continue; }
    const rel = token.replace(/:\d+-\d+$/, "");
    const range = /:(\d+)-(\d+)$/.exec(token);
    const abs = join(cwd, rel);
    if (!existsSync(abs)) continue;
    try {
      const lines = readFileSync(abs, "utf8").split("\n");
      const slice = range ? lines.slice(Number(range[1]) - 1, Number(range[2])) : lines.slice(0, 400);
      blocks.push(`<file path="${rel}"${range ? ` lines="${range[1]}-${range[2]}"` : ""}>\n${slice.join("\n")}${!range && lines.length > 400 ? "\n… (truncated)" : ""}\n</file>`);
    } catch { /* directories and binaries are skipped */ }
  }
  return { prompt: blocks.length ? `${prompt}\n\nContext:\n${blocks.join("\n")}` : prompt, images };
}
