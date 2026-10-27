# MUS-SPEC-08: Git, changes and review

Muster shows what changed in a chat's folder and helps the user review, commit and ship it.

What the user can do:
- see changed files per turn and for the whole chat, with inline and side-by-side diffs;
- pick what to compare against, discard changes (untracked files go to Trash after a confirm), resolve conflicts and see blame and history;
- create branches and worktrees, commit, push, open a pull request and follow its CI checks.

Boundaries:
- Nothing is discarded, reset or force-pushed without a confirm.
- Large comparisons say when they are cut short; exactly at the limit is not cut short.
- CI checks that share a name across workflows are listed separately.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-08-570A](08-git-changes-and-review.md#mus-spec-08-570a) | With a tag and a branch both called "release", the current branch and the branch list say "release". | [`branch list names a branch correctly when a tag has the same name`](../../../packages/agent-app/tests/git-bughunt.test.ts) |
| [MUS-SPEC-08-570B](08-git-changes-and-review.md#mus-spec-08-570b) | Blame on `-dash.txt` returns its one line. | [`blame accepts a file whose name starts with a dash`](../../../packages/agent-app/tests/git-bughunt.test.ts) |
| [MUS-SPEC-08-570C](08-git-changes-and-review.md#mus-spec-08-570c) | After a merge conflict in `-c.txt` is fixed, marking it resolved leaves no conflicted files. | [`markResolved accepts a dash-named conflicted file`](../../../packages/agent-app/tests/git-bughunt.test.ts) |
| [MUS-SPEC-08-570D](08-git-changes-and-review.md#mus-spec-08-570d) | An https remote with host GitHub.com and an ssh remote with host GITHUB.COM both give the same lower-case github.com web link. | [`GitHub remotes are recognised whatever the case of the host name`](../../../packages/agent-app/tests/git-bughunt.test.ts) |
| [MUS-SPEC-08-570E](08-git-changes-and-review.md#mus-spec-08-570e) | A ref diff of a newly added submodule has an empty before and "Subproject commit <sha>" as after. | [`ref diff shows a submodule pointer as a Subproject commit line`](../../../packages/agent-app/tests/git-bughunt.test.ts) |
| [MUS-SPEC-08-561A](08-git-changes-and-review.md#mus-spec-08-561a) | A created 3,000-line file lists 3,000 added rows, a deleted one 3,000 removed rows, and a 3,000-line block added between untouched text shows as 3,000 added rows with the 40 untouched lines as context. | [`a new, deleted or heavily extended file still previews instead of reporting a change that is too complex`](../../../packages/agent-app/tests/diff-model.test.ts) |
| [MUS-SPEC-08-571A](08-git-changes-and-review.md#mus-spec-08-571a) | A renamed binary file is listed with its new name and marked binary. | [`review changes flags a renamed binary file as binary`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-571B](08-git-changes-and-review.md#mus-spec-08-571b) | Undo of a deleted symlink leaves git status clean. | [`undoing a deleted symlink restores a symlink`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-571C](08-git-changes-and-review.md#mus-spec-08-571c) | Undo of a staged symlink change keeps mode 120000 in the index. | [`undoing a staged symlink change keeps the index entry a symlink`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-571D](08-git-changes-and-review.md#mus-spec-08-571d) | A binary file with the extension "constructor" gets no image preview. | [`a binary file whose extension is constructor has no image preview`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-779A](08-git-changes-and-review.md#mus-spec-08-779a) | A successful shell apply_patch that adds calculator.py and edits util.py lists both files with their line counts as one turn's changes; a failed patch and a printed patch stay commands. | [`#779 files the model writes with a shell apply_patch show as inline diffs and in the files-changed pill; failed or printed patches do not`](../../../packages/agent-app/tests/shell-patch-diff-779.test.ts) |
| [MUS-SPEC-08-777A](08-git-changes-and-review.md#mus-spec-08-777a) | A router agent missing from the gateway's catalog is launched with a catalog entry that has the freeform apply_patch tool and direct tools; the catalog's own models and file are unchanged. | [`#777 router models the catalog does not list run with the native apply_patch tool, so their edits show as inline diffs`](../../../packages/agent-app/tests/router-patch-tool-777.test.ts) |

### Refs, dash-named files and submodules

<a id="mus-spec-08-570a"></a>
#### MUS-SPEC-08-570A: A branch is named correctly when a tag has the same name

- Precondition: A repository with a tag and a branch both named `release`, and that branch checked out.
- Action: List the branches and read the repository info.
- Expected result: The current branch is `release`, the local list has `release`, and the info branch is `release` (not `heads/release`).
- Test: `packages/agent-app/tests/git-bughunt.test.ts::branch list names a branch correctly when a tag has the same name`
- Environment: Node test runner; no network, no provider. Needs `git`; real temp repository.
- Known gaps: Calls the git helpers directly, not the branch picker.
- Evidence: UNVERIFIED

<a id="mus-spec-08-570b"></a>
#### MUS-SPEC-08-570B: Blame works for a file whose name starts with "-"

- Precondition: A committed file named `-dash.txt`.
- Action: Ask for blame on it.
- Expected result: Blame returns one line, with no git error about an unknown option.
- Test: `packages/agent-app/tests/git-bughunt.test.ts::blame accepts a file whose name starts with a dash`
- Environment: Node test runner; no network, no provider. Needs `git`; real temp repository.
- Known gaps: History for the same file shares the fix but is not tested here.
- Evidence: UNVERIFIED

<a id="mus-spec-08-570c"></a>
#### MUS-SPEC-08-570C: Mark resolved works for a conflicted file whose name starts with "-"

- Precondition: A merge conflict in a file named `-c.txt`, which the user has fixed by hand.
- Action: Mark it resolved.
- Expected result: The conflict list is empty afterwards.
- Test: `packages/agent-app/tests/git-bughunt.test.ts::markResolved accepts a dash-named conflicted file`
- Environment: Node test runner; no network, no provider. Needs `git`; real temp repository.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-08-570d"></a>
#### MUS-SPEC-08-570D: A GitHub remote with capital letters in the host is recognised

- Precondition: A remote URL written with `GitHub.com` or `GITHUB.COM`.
- Action: Build the GitHub web link for it.
- Expected result: Both give the web link for owner o, repository r on github.com, with the host in lower case and no .git ending.
- Test: `packages/agent-app/tests/git-bughunt.test.ts::GitHub remotes are recognised whatever the case of the host name`
- Environment: Node test runner; no network, no provider.
- Known gaps: Unit test of the link function; no pull request or compare link is opened.
- Evidence: UNVERIFIED

<a id="mus-spec-08-570e"></a>
#### MUS-SPEC-08-570E: Comparing refs shows a moved submodule as a Subproject commit line

- Precondition: A repository whose last commit adds a submodule `sm`.
- Action: Compare `HEAD~1` with `HEAD` for the path `sm`.
- Expected result: Before is empty and after is `Subproject commit <pinned sha>`.
- Test: `packages/agent-app/tests/git-bughunt.test.ts::ref diff shows a submodule pointer as a Subproject commit line`
- Environment: Node test runner; no network, no provider. Needs `git`; real temp repositories.
- Known gaps: Covers an added submodule, not one that moved between two commits.
- Evidence: UNVERIFIED

### Large diffs

<a id="mus-spec-08-561a"></a>
#### MUS-SPEC-08-561A: A new, deleted or heavily extended file still shows its lines

- Precondition: A file with 3,000 lines is created, another is deleted, and a third has a 3,000-line block added between 20 untouched lines at each end.
- Action: Build the diff for each change.
- Expected result: Each diff lists every line: all added for the new file, all removed for the deleted file, and for the third file 3,000 added lines with the 40 untouched lines as context. None reports that the change is too complex.
- Test: `packages/agent-app/tests/diff-model.test.ts::a new, deleted or heavily extended file still previews instead of reporting a change that is too complex`
- Environment: Node test runner; no git repository or app.
- Known gaps: Calls the diff model, not the review pane that draws it. This is the only test for this behaviour.
- Evidence: UNVERIFIED

<a id="mus-spec-08-571a"></a>
#### MUS-SPEC-08-571A: A renamed binary file is shown as binary

- Precondition: A git repository where a committed binary file b.bin has been renamed to c.bin with git mv.
- Action: Ask for the review changes against HEAD.
- Expected result: c.bin is listed and is marked binary, so no text diff is tried on it.
- Test: `packages/agent-app/tests/review-bughunt.test.ts::review changes flags a renamed binary file as binary`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Calls the review function. It does not render the review pane.
- Evidence: UNVERIFIED

<a id="mus-spec-08-571b"></a>
#### MUS-SPEC-08-571B: Undoing a deleted symlink brings back a symlink

- Precondition: A repository with a committed symlink named link that points at a.txt, and the symlink deleted from disk.
- Action: Undo the change to link from the review.
- Expected result: The path is a symlink again, and git status shows a clean tree.
- Test: `packages/agent-app/tests/review-bughunt.test.ts::undoing a deleted symlink restores a symlink`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Calls the undo function. It does not click Undo in the review pane.
- Evidence: UNVERIFIED

<a id="mus-spec-08-571c"></a>
#### MUS-SPEC-08-571C: Undoing a staged symlink change keeps the index entry a symlink

- Precondition: A committed symlink that was replaced by a symlink to another target and staged.
- Action: Undo the change to link against the staged baseline.
- Expected result: The index entry is still a symlink (mode 120000) and no staged difference is left.
- Test: `packages/agent-app/tests/review-bughunt.test.ts::undoing a staged symlink change keeps the index entry a symlink`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Calls the undo function. It does not click Undo in the review pane.
- Evidence: UNVERIFIED

<a id="mus-spec-08-571d"></a>
#### MUS-SPEC-08-571D: A file whose extension is "constructor" has no image preview

- Precondition: A binary file named blob.constructor in a repository.
- Action: Open its diff in the review.
- Expected result: The diff is marked binary and carries no image preview.
- Test: `packages/agent-app/tests/review-bughunt.test.ts::a binary file whose extension is constructor has no image preview`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Checks the diff data. It does not render the preview pane.
- Evidence: UNVERIFIED

### Inline diffs for every model (protected)

<a id="mus-spec-08-779a"></a>
#### MUS-SPEC-08-779A: A file written with a shell apply_patch shows as an inline diff and in the pill

- Precondition: A chat whose model has no native patch tool, in a folder that is not a Git repository.
- Action: The model runs `apply_patch` through the shell; it adds `calculator.py` and edits `util.py`. A second patch fails and a third is only printed with `cat`.
- Expected result: The turn's changes list `calculator.py` (added, 4 lines) and `util.py` (1 added, 1 removed) as inline diffs, the files-changed pill counts them, and the tool row keeps the command output. The failed and printed patches stay plain commands.
- Test: `packages/agent-app/tests/shell-patch-diff-779.test.ts::#779 files the model writes with a shell apply_patch show as inline diffs and in the files-changed pill; failed or printed patches do not`
- Environment: Node test runner; a fake provider adapter replays the app-server items; no network, no Git.
- Known gaps: Edits made with `sed`, `cat >` or `tee` outside a Git repository are still not captured.
- Evidence: UNVERIFIED

<a id="mus-spec-08-777a"></a>
#### MUS-SPEC-08-777A: Router models get the native patch tool

- Precondition: A gateway profile with a model catalog, and a router that also lists an agent (`intelligent-planner`) the catalog does not.
- Action: Muster lists the route's models and launches Codex for a chat on the router agent.
- Expected result: Codex is given a catalog with an entry for the agent using the freeform apply_patch tool and direct tools, so the model edits files with apply_patch and the edits show as inline diffs. The catalog's own models are passed on unchanged and the person's catalog file is not modified.
- Test: `packages/agent-app/tests/router-patch-tool-777.test.ts::#777 router models the catalog does not list run with the native apply_patch tool, so their edits show as inline diffs`
- Environment: Node test runner; a stand-in Codex records the catalog it is given; the listing is a fake fetch.
- Known gaps: Checks the catalog Codex receives. A manual probe with Codex 0.163 against a local fake server showed `intelligent-planner` offered `apply_patch` only with the merged catalog. Routes with no catalog file still use Codex's fallback metadata.
- Evidence: UNVERIFIED
