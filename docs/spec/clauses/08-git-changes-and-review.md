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
