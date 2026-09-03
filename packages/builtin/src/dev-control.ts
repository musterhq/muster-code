// Dev harness: when MUSTER_CODE_DEV_SOCK is set, the extension listens on that
// unix socket for JSON lines so the running app can be driven from a shell:
//   {"cmd":"replay","patch":"*** Begin Patch…","pace":15,"chunk":4,"write":true}
//   {"cmd":"exec","command":"muster.edit.accept","args":[]}
//   {"cmd":"state"}   {"cmd":"text","path":"server.js"}
// Never active in a user's build: the env var is only set by the dev launcher.
import * as vscode from "vscode";
import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { LiveEditController } from "./live-edit.js";
import { queryCodex } from "./codex.js";

interface Deps { readonly live: LiveEditController; readonly log: (line: string) => void }

export function startDevControl(context: vscode.ExtensionContext, deps: Deps): void {
  const path = process.env.MUSTER_CODE_DEV_SOCK;
  if (!path) return;
  if (existsSync(path)) unlinkSync(path);
  const server = createServer((socket) => serve(socket, deps));
  server.on("error", (error) => deps.log(`dev control error: ${error.message}`));
  server.listen(path, () => deps.log(`dev control listening on ${path}`));
  context.subscriptions.push({ dispose: () => { server.close(); if (existsSync(path)) unlinkSync(path); } });
}

function serve(socket: Socket, deps: Deps): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      void handle(line, deps).then((reply) => socket.write(`${JSON.stringify(reply)}\n`), (error) => socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`));
    }
  });
}

async function handle(line: string, deps: Deps): Promise<unknown> {
  const message = JSON.parse(line) as Record<string, unknown>;
  const started = Date.now();
  switch (message.cmd) {
    case "replay": {
      const patch = String(message.patch ?? "");
      const itemId = String(message.itemId ?? `dev-${started}`);
      const chunk = Math.max(1, Number(message.chunk ?? 4));
      const pace = Math.max(0, Number(message.pace ?? 15));
      for (let i = 0; i < patch.length; i += chunk) {
        deps.live.onEvent("item/fileChange/outputDelta", { delta: patch.slice(i, i + chunk), itemId, threadId: "dev", turnId: "dev" });
        if (pace) await new Promise((r) => setTimeout(r, pace));
      }
      await new Promise((r) => setTimeout(r, 120));
      const written = message.write === false ? [] : deps.live.simulateWrite(itemId);
      return { ok: true, ms: Date.now() - started, written };
    }
    case "exec": {
      const result = await vscode.commands.executeCommand(String(message.command), ...((message.args as unknown[]) ?? []));
      return { ok: true, result: result ?? null };
    }
    case "query": {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const result = await queryCodex(String(message.method), (message.params as Record<string, unknown>) ?? {}, cwd);
      return { ok: true, result };
    }
    case "state":
      return {
        ok: true,
        review: deps.live.review(),
        active: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
        visible: vscode.window.visibleTextEditors.map((e) => ({ path: e.document.uri.fsPath, dirty: e.document.isDirty, lines: e.document.lineCount })),
        tabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)),
      };
    case "text": {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith(String(message.path)));
      return { ok: !!doc, text: doc?.getText() ?? null, dirty: doc?.isDirty ?? null };
    }
    default:
      return { ok: false, error: `unknown cmd ${String(message.cmd)}` };
  }
}
