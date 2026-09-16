// Muster Tab: inline completions and next-edit prediction from Codex (ghost text and
// inline edits), reference-IDE-style but quota-aware: off unless muster.completions.enabled,
// snoozable, per-language, debounced, one request in flight, short windows, one JSON
// answer carrying both the continuation at the cursor and the edit it implies elsewhere.
import * as vscode from "vscode";
import { runTurn } from "./codex.js";

let snoozedUntil = 0;
/** the reference IDE's status-bar "Snooze": no requests until the time passes (0 resumes). */
export function snoozeCompletions(ms: number): void { snoozedUntil = ms > 0 ? Date.now() + ms : 0; }
export function completionsSnoozedFor(): number { return Math.max(0, snoozedUntil - Date.now()); }

/** The last edit per document: what the next-edit prediction reasons from (rename propagation, matching changes). */
const lastEdits = new Map<string, { at: number; line: number; text: string; removed: number }>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function parseJson(text: string): { completion?: unknown; nextEdit?: unknown } | null {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as { completion?: unknown; nextEdit?: unknown }; } catch { return null; }
}

export function registerCompletions(context: vscode.ExtensionContext, cwd: () => string, model: () => string | undefined): void {
  let inflight = 0;
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const c = e.contentChanges[0]; if (!c || e.document.uri.scheme !== "file") return;
    lastEdits.set(e.document.uri.toString(), { at: Date.now(), line: c.range.start.line, text: c.text.slice(0, 200), removed: c.rangeLength });
  }));
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const config = vscode.workspace.getConfiguration("muster");
      if (!config.get<boolean>("completions.enabled", false) || completionsSnoozedFor() > 0) return [];
      if (config.get<string[]>("completions.disabledLanguages", ["markdown", "plaintext"]).includes(document.languageId)) return [];
      if (inflight) return [];
      await sleep(450);
      if (token.isCancellationRequested) return [];
      const from = Math.max(0, position.line - 60);
      const before = document.getText(new vscode.Range(new vscode.Position(from, 0), position));
      const after = document.getText(new vscode.Range(position, new vscode.Position(Math.min(document.lineCount - 1, position.line + 20), 0)));
      if (before.trim().length < 12) return [];
      const edit = lastEdits.get(document.uri.toString());
      const recent = edit && Date.now() - edit.at < 60_000 ? `\nThe user's most recent edit was at line ${edit.line + 1}: inserted ${JSON.stringify(edit.text)}${edit.removed ? ` replacing ${edit.removed} characters` : ""}.` : "";
      const wantNext = config.get<boolean>("completions.nextEdit", true);
      inflight++;
      let text = "";
      try {
        const chosen = model();
        const result = await runTurn({
          prompt: `You are a code completion engine. File: ${vscode.workspace.asRelativePath(document.uri)} (${document.languageId}). Lines shown start at ${from + 1}.${recent}\n\nReply with ONLY a JSON object, no prose, no fences: {"completion": "<raw text to insert at <CURSOR>, at most 6 lines, empty string when nothing sensible follows>"${wantNext ? `, "nextEdit": null or {"line": <1-based line number in the shown code, not the cursor line, that the recent edit implies must change too>, "replace": "<that line's exact current content>", "with": "<its new content>"}` : ""}}\n\n<code>\n${before}<CURSOR>${after}\n</code>`,
          cwd: cwd(),
          ...(chosen && !chosen.startsWith("claude:") ? { model: chosen } : {}),
          reasoning: "low",
          access: { id: ":read-only", label: "Read only", sandbox: "read-only", approvalPolicy: "never" },
          handlers: { onDelta: (d) => { text += d; }, onReasoning: () => {} },
        });
        if (result.status === "failed") return [];
      } catch {
        return [];
      } finally {
        inflight--;
      }
      if (token.isCancellationRequested) return [];
      const parsed = parseJson(text);
      const items: vscode.InlineCompletionItem[] = [];
      const completion = (typeof parsed?.completion === "string" ? parsed.completion : parsed ? "" : text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "")).replace(/\s+$/, "");
      if (completion) items.push(new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)));
      const next = parsed?.nextEdit as { line?: unknown; replace?: unknown; with?: unknown } | null | undefined;
      if (wantNext && next && typeof next.line === "number" && typeof next.with === "string") {
        const line = next.line - 1;
        if (line >= 0 && line < document.lineCount && line !== position.line) {
          const current = document.lineAt(line);
          if (typeof next.replace !== "string" || current.text.trim() === next.replace.trim()) {
            // the reference IDE Tab's jump: an inline edit elsewhere — Tab jumps there and accepts, Esc dismisses.
            const item = new vscode.InlineCompletionItem(next.with, current.range) as vscode.InlineCompletionItem & { isInlineEdit?: boolean; showInlineEditMenu?: boolean };
            item.isInlineEdit = true; item.showInlineEditMenu = true;
            items.push(item);
          }
        }
      }
      return items;
    },
  };
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider));
}
