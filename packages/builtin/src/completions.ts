// Muster Tab: inline completions from Codex (ghost text), Cursor-style but
// quota-aware: off unless muster.completions.enabled, debounced, one request
// in flight, short prefix/suffix windows, and only the continuation is asked for.
import * as vscode from "vscode";
import { runTurn } from "./codex.js";

export function registerCompletions(context: vscode.ExtensionContext, cwd: () => string, model: () => string | undefined): void {
  let inflight = 0;
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const config = vscode.workspace.getConfiguration("muster");
      if (!config.get<boolean>("completions.enabled", false)) return [];
      if (inflight) return [];
      await new Promise((r) => setTimeout(r, 450));
      if (token.isCancellationRequested) return [];
      const before = document.getText(new vscode.Range(new vscode.Position(Math.max(0, position.line - 60), 0), position));
      const after = document.getText(new vscode.Range(position, new vscode.Position(Math.min(document.lineCount - 1, position.line + 20), 0)));
      if (before.trim().length < 12) return [];
      inflight++;
      let text = "";
      try {
        const chosen = model();
        const result = await runTurn({
          prompt: `Complete the code at <CURSOR>. Reply with ONLY the raw continuation (no fences, no prose, at most 6 lines); it must fit between the prefix and suffix.\nFile: ${vscode.workspace.asRelativePath(document.uri)} (${document.languageId})\n<prefix>\n${before}<CURSOR>\n</prefix>\n<suffix>\n${after}\n</suffix>`,
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
      const cleaned = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").replace(/\s+$/, "");
      if (!cleaned || token.isCancellationRequested) return [];
      return [new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position))];
    },
  };
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider));
}
