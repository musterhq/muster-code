import * as vscode from "vscode";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createDetachedWorkspace, gitRoot, isUsableWorktree, listGitWorktrees, type GitWorktree, type WorkspaceRef } from "./workspace-registry.js";

export interface WorkspaceHubOptions { readonly sourceRoot?: () => string | undefined; readonly storageRoot?: () => string | undefined }
type WorkspacePick = { label: string; description: string; detail?: string; id: string; worktree?: GitWorktree };
export class WorkspaceHub implements vscode.Disposable {
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly options: WorkspaceHubOptions = {}) {}

  async openHub(): Promise<WorkspaceRef | undefined> {
    try { return await this.openHubImpl(); }
    catch (error) { void vscode.window.showWarningMessage(`Workspace hub failed: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  }

  private async openHubImpl(): Promise<WorkspaceRef | undefined> {
    if (this.disposed) return undefined;
    let source: string | undefined;
    try { source = await this.sourceRoot(); } catch (error) { void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error)); return undefined; }
    if (!source) { void vscode.window.showInformationMessage("Open a Git workspace before using Workspaces."); return undefined; }
    let worktrees: GitWorktree[];
    try { worktrees = await listGitWorktrees(source); } catch (error) { void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error)); return undefined; }
    const create: WorkspacePick = { label: "$(add) Create isolated workspace", description: "Detached worktree at an explicit commit; opens a new window", id: "create" };
    const picks: WorkspacePick[] = [create, ...worktrees.map((worktree): WorkspacePick => ({ label: `$(folder) ${basename(worktree.path)}`, description: `${worktree.branch ? `branch ${worktree.branch}` : `detached ${worktree.head.slice(0, 12)}`} · ${worktree.path}`, detail: worktree.prunable ? `prunable: ${worktree.prunable}` : worktree.bare ? "bare" : "ready", id: worktree.path, worktree }))];
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Muster workspaces · choose a worktree or create one", matchOnDescription: true, matchOnDetail: true });
    if (!pick) return undefined;
    if (pick.id !== "create") { const worktree = pick.worktree; if (!worktree) return undefined; if (!isUsableWorktree(worktree)) { void vscode.window.showWarningMessage(`Worktree is unavailable: ${worktree.prunable ?? worktree.path}`); return undefined; } if (!await this.openWorktree(worktree.path)) return undefined; return { workspaceId: `existing-${Buffer.from(resolve(worktree.path)).toString("base64url").slice(0, 24)}`, sourceRoot: source, root: worktree.path, baseRef: worktree.head, ...(worktree.branch ? { branch: worktree.branch } : {}), state: "ready" }; }
    const ref = await vscode.window.showInputBox({ prompt: "Base commit or existing ref (blank uses current HEAD)", placeHolder: "HEAD", value: "HEAD", validateInput: (value) => value.includes("\n") ? "Ref must be one line." : undefined });
    if (ref === undefined) return undefined;
    const storageRoot = this.options.storageRoot?.() ?? this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath;
    const destination = join(storageRoot, "worktrees", `workspace-${randomUUID()}`);
    try {
      const created = await createDetachedWorkspace({ sourceRoot: source, destinationRoot: destination, baseRef: ref.trim() || "HEAD", workspaceId: `workspace-${randomUUID()}` });
      if (!await this.openWorktree(created.root)) return undefined;
      return created;
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return undefined; }
  }

  dispose(): void { this.disposed = true; }
  private async sourceRoot(): Promise<string | undefined> { const configured = this.options.sourceRoot?.(); const root = await gitRoot(configured ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""); return root; }
  private async openWorktree(path: string): Promise<boolean> { try { await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), true); return true; } catch (error) { void vscode.window.showWarningMessage(`Could not open worktree: ${error instanceof Error ? error.message : String(error)}`); return false; } }
}

export function registerWorkspaceHub(context: vscode.ExtensionContext, options: WorkspaceHubOptions = {}): WorkspaceHub {
  const hub = new WorkspaceHub(context, options);
  context.subscriptions.push(hub, vscode.commands.registerCommand("muster.workspace.hub", () => hub.openHub()));
  return hub;
}
