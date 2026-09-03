// Context kinds for the composer's "@" picker, after Cursor's mention sections:
// Files & Folders, Docs, Git (branch diff, working tree, commits), Terminals,
// Past Chats, Web, images. Tokens stay in the prompt (the model sees what was
// meant); their contents are appended as <context> blocks.
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { listThreads, readHistory, threadsForWorkspace } from "./codex.js";
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

// ── suggestions for the "@" popover ──
// The popover must answer within a keystroke: files come from an in-memory index (refreshed in the
// background), commits from a short-lived cache, past chats from the last listing — never a process spawn.
const index = { files: [] as string[], at: 0, building: null as Promise<void> | null, log: [] as string[], logAt: 0, chats: [] as Suggestion[], chatsAt: 0, chatsBuilding: false };
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

export async function suggestMentions(cwd: string, query: string): Promise<Suggestion[]> {
  const q = query.toLowerCase();
  const out: Suggestion[] = [];
  const all = await fileIndex();
  const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => (t.input as { uri?: vscode.Uri })?.uri).filter((u): u is vscode.Uri => !!u && u.scheme === "file").map((u) => vscode.workspace.asRelativePath(u)).filter((r) => !r.startsWith(".."));
  const files = q
    ? all.map((r) => [score(r, q), r] as const).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, 12).map(([, r]) => r)
    : [...new Set([...open, ...all])].slice(0, 8);
  for (const r of files) out.push({ group: "Files & Folders", label: r.split("/").pop() ?? r, detail: r, insert: `@${r}` });
  const fixed: Suggestion[] = [
    { group: "Git", label: "Branch (Diff with Main)", detail: "changes on this branch vs the default branch", insert: "@git:branch" },
    { group: "Git", label: "Working tree diff", detail: "uncommitted changes", insert: "@git:diff" },
    { group: "Terminals", label: "Terminal", detail: vscode.window.activeTerminal ? `last output of ${vscode.window.activeTerminal.name}` : "last output of the active terminal", insert: "@terminal" },
    { group: "Web", label: "Web", detail: "ask the agent to search the web", insert: "@web" },
    { group: "Browser", label: "Browser", detail: "the open browser tab: page, selected element, console", insert: "@browser" },
  ];
  for (const d of docsList()) fixed.push({ group: "Docs", label: d.name, detail: d.url, insert: `@docs:${d.name}` });
  if (!query || /^(git|com|log)/.test(q)) {
    if (Date.now() - index.logAt > 15_000) { index.log = (await git(cwd, ["log", "--oneline", "-8"])).split("\n").filter(Boolean); index.logAt = Date.now(); }
    for (const line of index.log) { const [sha, ...rest] = line.split(" "); out.push({ group: "Commits", label: rest.join(" ").slice(0, 60), detail: sha ?? "", insert: `@git:commit:${sha}` }); }
  }
  if (!query || /^(chat|past)/.test(q)) {
    if (Date.now() - index.chatsAt > 60_000 && !index.chatsBuilding) { index.chatsBuilding = true; void listThreads().then((threads) => { index.chats = threadsForWorkspace(threads, [cwd]).slice(0, 5).map((t) => ({ group: "Past Chats", label: t.name, detail: `${t.turnCount} turns`, insert: `@chat:${t.id}` })); index.chatsAt = Date.now(); }).finally(() => { index.chatsBuilding = false; }); }
    out.push(...index.chats);
  }
  for (const s of fixed) if (!query || s.label.toLowerCase().includes(q) || s.insert.includes(q)) out.push(s);
  return out.slice(0, 40);
}

// ── expansion: every mention kind becomes a context block ──
export async function expandContext(prompt: string, cwd: string): Promise<{ prompt: string; images: string[] }> {
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
