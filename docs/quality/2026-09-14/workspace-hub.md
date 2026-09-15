# Native workspace hub · 14 September 2026

The new registry/hub surface is deliberately limited to native Git and VS Code operations. It is safe to integrate beside the existing source checkout runtime without changing `LiveEditController`, diff parsing, or provider startup.

## Browser-agent integration contract

Import `registerWorkspaceHub` from `workspace-hub.ts` and call it once during extension activation:

```ts
const hub = registerWorkspaceHub(context, {
  sourceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  storageRoot: () => context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
});
```

This registers `muster.workspace.hub`. The command opens a cancellable picker. Existing usable worktrees open with `vscode.openFolder(uri, true)`, creating a new Muster window. The create path asks for a base ref, defaults to `HEAD`, resolves it to a commit, creates a detached worktree under the private storage root, reconciles `git worktree list` after the command, and opens only the reconciled path. It never starts an agent.

`WorkspaceRegistry` exports `gitRoot`, `resolveGitRef`, `listGitWorktrees`, `parseWorktreePorcelain`, `createDetachedWorkspace`, and `isUsableWorktree`. `createDetachedWorkspace` returns a `WorkspaceRef` with `workspaceId`, canonical source/root paths, resolved `baseRef`, and `state` (`ready` or `uncertain`). It rejects non-Git roots, invalid refs, destinations inside the source checkout, and duplicate worktree paths before invoking Git. A timeout or other ambiguous result is reconciled once; no automatic retry or ghost success is returned.

## Limits

The hub does not remove worktrees, merge or apply patches, copy dirty source state, invent branches, or poll in the background. A Git worktree's `branch`, `bare`, `locked`, and `prunable` fields are surfaced honestly by the list parser. The source checkout remains untouched, including dirty files.

Each new window receives a separate extension runtime and can later construct a workspace-scoped live edit/checkpoint controller. That controller integration is intentionally outside this change; existing shared source-root turns remain serialized by their current runtime.

## Verification

- Built-in typecheck passed.
- Four disposable Git repository tests passed, covering NUL-delimited parsing, spaces/Unicode, dirty-source invariants, invalid refs, duplicate destinations, non-Git roots, and independent repository inventories. Four host-double hub tests also pass, covering callback options, cancellation, stale worktrees, open-window rejection, explicit-ref creation, and handled picker rejection.
