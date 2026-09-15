import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createDetachedWorkspace, gitRoot, listGitWorktrees, parseWorktreePorcelain, resolveGitRef, WorkspaceRegistryError } from "../src/workspace-registry.js";

const run = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> { return String((await run("git", args, { cwd })).stdout); }
async function repo(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join("/tmp", prefix));
  await git(cwd, ["init", "-q"]); await git(cwd, ["config", "user.email", "test@example.invalid"]); await git(cwd, ["config", "user.name", "Muster Test"]);
  await writeFile(join(cwd, "README.md"), "initial\n"); await git(cwd, ["add", "README.md"]); await git(cwd, ["commit", "-qm", "initial"]);
  return cwd;
}

test("parses NUL-delimited worktree records with detached, branch, bare, and prunable states", () => {
  const rows = parseWorktreePorcelain("worktree /tmp/a space\0HEAD abc1234\0branch refs/heads/main\0\0worktree /tmp/stale\0HEAD deadbee\0prunable reason\0\0");
  assert.deepEqual(rows, [{ path: "/tmp/a space", head: "abc1234", branch: "main", bare: false }, { path: "/tmp/stale", head: "deadbee", bare: false, prunable: "reason" }]);
});

test("creates a detached worktree at the resolved commit without mutating a dirty source", async () => {
  const source = await repo("muster-workspace-registry-"); const destination = join(await mkdtemp(join("/tmp", "muster-worktree-dest-")), "隔離 checkout");
  const beforeHead = (await git(source, ["rev-parse", "HEAD"])).trim(); await writeFile(join(source, "dirty.txt"), "keep me\n"); const beforeStatus = await git(source, ["status", "--porcelain"]);
  const created = await createDetachedWorkspace({ sourceRoot: source, destinationRoot: destination });
  assert.equal(created.state, "ready"); assert.equal(created.baseRef, beforeHead); assert.equal((await git(destination, ["rev-parse", "HEAD"])).trim(), beforeHead);
  assert.equal(await readFile(join(source, "dirty.txt"), "utf8"), "keep me\n"); assert.equal(await git(source, ["status", "--porcelain"]), beforeStatus);
  assert.equal((await listGitWorktrees(source)).some((worktree) => worktree.path === created.root), true);
  await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true });
});

test("rejects non-Git roots, invalid refs, and duplicate destinations before provider work", async () => {
  const nonGit = await mkdtemp(join("/tmp", "muster-non-git-")); assert.equal(await gitRoot(nonGit), undefined);
  await assert.rejects(listGitWorktrees(nonGit), (error: unknown) => error instanceof WorkspaceRegistryError && error.code === "not-git");
  const source = await repo("muster-workspace-invalid-"); const destination = join(await mkdtemp(join("/tmp", "muster-worktree-invalid-dest-")), "child");
  await assert.rejects(createDetachedWorkspace({ sourceRoot: source, destinationRoot: destination, baseRef: "does-not-exist" }), (error: unknown) => error instanceof WorkspaceRegistryError && error.code === "invalid-ref");
  await createDetachedWorkspace({ sourceRoot: source, destinationRoot: destination });
  await assert.rejects(createDetachedWorkspace({ sourceRoot: source, destinationRoot: destination }), (error: unknown) => error instanceof WorkspaceRegistryError && error.code === "duplicate-destination");
  await rm(nonGit, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true });
});

test("separate repositories have independent worktree inventories", async () => {
  const first = await repo("muster-workspace-first-"); const second = await repo("muster-workspace-second-");
  const firstRows = await listGitWorktrees(first); const secondRows = await listGitWorktrees(second);
  assert.equal(firstRows.length, 1); assert.equal(secondRows.length, 1); assert.notEqual(firstRows[0]?.path, secondRows[0]?.path);
  await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true });
});
