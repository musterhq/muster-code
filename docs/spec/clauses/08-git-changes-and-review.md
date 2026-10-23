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
| [MUS-SPEC-08-571A](08-git-changes-and-review.md#mus-spec-08-571a) | A renamed binary file is listed with its new name and marked binary. | [`review changes flags a renamed binary file as binary`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-571B](08-git-changes-and-review.md#mus-spec-08-571b) | Undo of a deleted symlink leaves git status clean. | [`undoing a deleted symlink restores a symlink`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-571C](08-git-changes-and-review.md#mus-spec-08-571c) | Undo of a staged symlink change keeps mode 120000 in the index. | [`undoing a staged symlink change keeps the index entry a symlink`](../../../packages/agent-app/tests/review-bughunt.test.ts) |
| [MUS-SPEC-08-571D](08-git-changes-and-review.md#mus-spec-08-571d) | A binary file with the extension "constructor" gets no image preview. | [`a binary file whose extension is constructor has no image preview`](../../../packages/agent-app/tests/review-bughunt.test.ts) |

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
