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
| [MUS-SPEC-08-561A](08-git-changes-and-review.md#mus-spec-08-561a) | A created 3,000-line file lists 3,000 added rows, a deleted one 3,000 removed rows, and a 3,000-line block added between untouched text shows as 3,000 added rows with the 40 untouched lines as context. | [`a new, deleted or heavily extended file still previews instead of reporting a change that is too complex`](../../../packages/agent-app/tests/diff-model.test.ts) |

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

