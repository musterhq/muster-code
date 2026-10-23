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

No cases yet. A PR that changes this area adds its cases here first (see [acceptance-cases.md](../acceptance-cases.md)).
