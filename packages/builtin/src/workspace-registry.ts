import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, dirname, join as joinPath, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
function canonicalPath(path: string): string { try { return realpathSync(path); } catch { try { return joinPath(realpathSync(dirname(path)), basename(path)); } catch { return resolve(path); } } }

export interface GitWorktree {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly locked?: string | undefined;
  readonly prunable?: string | undefined;
}
export interface WorkspaceRef {
  readonly workspaceId: string;
  readonly sourceRoot: string;
  readonly root: string;
  readonly baseRef: string;
  readonly branch?: string;
  readonly state: "ready" | "uncertain";
}
export interface CreateWorkspaceOptions {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly baseRef?: string;
  readonly workspaceId?: string;
  readonly timeoutMs?: number;
}
export class WorkspaceRegistryError extends Error { readonly code: "not-git" | "invalid-ref" | "duplicate-destination" | "invalid-destination" | "create-failed" | "create-uncertain"; constructor(code: WorkspaceRegistryError["code"], message: string) { super(message); this.name = "WorkspaceRegistryError"; this.code = code; } }

async function git(args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  try { const result = await exec("git", args, { cwd, timeout: timeoutMs, maxBuffer: 4_000_000 }); return String(result.stdout); }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); throw new Error(detail); }
}
export async function gitRoot(cwd: string): Promise<string | undefined> { try { return (await git(["rev-parse", "--show-toplevel"], cwd)).trim() || undefined; } catch { return undefined; } }
export async function resolveGitRef(sourceRoot: string, ref = "HEAD"): Promise<string> { try { const resolved = (await git(["rev-parse", "--verify", `${ref}^{commit}`], sourceRoot)).trim(); if (!/^[0-9a-f]{7,64}$/i.test(resolved)) throw new Error("Git returned an invalid commit."); return resolved; } catch { throw new WorkspaceRegistryError("invalid-ref", `Cannot resolve Git ref "${ref}".`); } }

export function parseWorktreePorcelain(raw: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  for (const record of raw.split("\0\0")) {
    const fields = record.split("\0").filter(Boolean); if (!fields.length) continue;
    const values = new Map<string, string>();
    for (const field of fields) { const split = field.indexOf(" "); values.set(split < 0 ? field : field.slice(0, split), split < 0 ? "" : field.slice(split + 1)); }
    const path = values.get("worktree"), head = values.get("HEAD"); if (!path || !head) continue;
    const branch = values.get("branch")?.replace(/^refs\/heads\//, "");
    records.push({ path, head, ...(branch ? { branch } : {}), bare: values.has("bare"), ...(values.get("locked") !== undefined ? { locked: values.get("locked") } : {}), ...(values.get("prunable") !== undefined ? { prunable: values.get("prunable") } : {}) });
  }
  return records;
}
export async function listGitWorktrees(sourceRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitWorktree[]> { if (!(await gitRoot(sourceRoot))) throw new WorkspaceRegistryError("not-git", `${sourceRoot} is not a Git repository.`); return parseWorktreePorcelain(await git(["worktree", "list", "--porcelain", "-z"], sourceRoot, timeoutMs)); }

export async function createDetachedWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceRef> {
  const source = await gitRoot(options.sourceRoot); if (!source) throw new WorkspaceRegistryError("not-git", `${options.sourceRoot} is not a Git repository.`);
  const destination = options.destinationRoot; const canonicalDestination = canonicalPath(destination);
  if (!destination || canonicalDestination === source || canonicalDestination.startsWith(`${source}/`)) throw new WorkspaceRegistryError("invalid-destination", "A worktree destination must be outside the source checkout.");
  const existing = await listGitWorktrees(source, options.timeoutMs);
  if (existing.some((worktree) => canonicalPath(worktree.path) === canonicalDestination)) throw new WorkspaceRegistryError("duplicate-destination", `Worktree destination already exists: ${destination}`);
  if (existsSync(destination)) throw new WorkspaceRegistryError("duplicate-destination", `Worktree destination already exists: ${destination}`);
  const base = await resolveGitRef(source, options.baseRef ?? "HEAD");
  const workspaceId = options.workspaceId ?? `workspace-${randomUUID()}`;
  try {
    await git(["worktree", "add", "--detach", destination, base], source, options.timeoutMs);
  } catch (error) {
    const reconciled = await listGitWorktrees(source, options.timeoutMs).catch(() => []);
    const found = reconciled.find((worktree) => canonicalPath(worktree.path) === canonicalDestination);
    if (found) return { workspaceId, sourceRoot: source, root: found.path, baseRef: base, state: "uncertain" };
    throw new WorkspaceRegistryError("create-failed", `Git worktree creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reconciled = await listGitWorktrees(source, options.timeoutMs);
  const created = reconciled.find((worktree) => canonicalPath(worktree.path) === canonicalDestination);
  if (!created) throw new WorkspaceRegistryError("create-uncertain", "Git did not confirm the requested worktree; no retry was attempted.");
  return { workspaceId, sourceRoot: source, root: created.path, baseRef: created.head, state: "ready" };
}

export function isUsableWorktree(worktree: GitWorktree): boolean { return !worktree.bare && !worktree.prunable && existsSync(worktree.path); }
