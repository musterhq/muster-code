# MUS-SPEC-08: Git, changes and review

Muster shows what changed in a chat's folder and helps the user review, commit and ship it.

What the user can do:
- see changed files per turn and for the whole chat, with inline and side-by-side diffs;
- pick what to compare against, discard changes (untracked files go to Trash after a confirm), resolve conflicts and see blame and history;
- act on a commit in the history graph: copy it, check it out, branch from it, cherry-pick or revert it;
- create branches and worktrees, commit, push, open a pull request and follow its CI checks.

Boundaries:
- Nothing is discarded, reset or force-pushed without a confirm.
- Checking out, cherry-picking or reverting a commit from history confirms first and never runs over uncommitted changes.
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
| [MUS-SPEC-08-781A](08-git-changes-and-review.md#mus-spec-08-781a) | Reloading saved shell edits restores all changed files and totals without modifying stored rows or revision cursors. | [`reopening a saved shell-edit chat recovers all diffs without rewriting history`](../../../packages/agent-app/tests/stored-shell-patch-781.test.ts) |
| [MUS-SPEC-08-781B](08-git-changes-and-review.md#mus-spec-08-781b) | Failed, interrupted, running and printed patches remain commands; native changes are untouched and action-only records recover. | [`saved non-edits stay commands and native changes remain intact`](../../../packages/agent-app/tests/stored-shell-patch-781.test.ts) |
| [MUS-SPEC-08-781C](08-git-changes-and-review.md#mus-spec-08-781c) | Streamed command evidence yields both file diffs before the reply ends, even when completion omits command details. | [`a streamed shell edit appears before the reply ends when completion omits command details`](../../../packages/agent-app/tests/shell-patch-diff-779.test.ts) |
| [MUS-SPEC-08-781D](08-git-changes-and-review.md#mus-spec-08-781d) | Complete scratch-file review survives separated hunks and renames while rejecting unrelated reads. | [`a scratch chat opens a complete multi-edit renamed file without granting arbitrary file reads`](../../../packages/agent-app/tests/full-inline-diff-781.test.ts) |
| [MUS-SPEC-08-781E](08-git-changes-and-review.md#mus-spec-08-781e) | Context matching retains whole files and rejects ambiguous or stale placement. | [`contextual shell hunks retain all source and refuse stale or ambiguous placement`](../../../packages/agent-app/tests/full-inline-diff-781.test.ts) |
| [MUS-SPEC-08-781F](08-git-changes-and-review.md#mus-spec-08-781f) | The production editor renders all unchanged source and both change blocks in both themes. | [`opening a scratch edit renders unchanged source and every changed block in both themes`](../../../packages/agent-app/tests/full-inline-diff-781-dom.tsx) |
| [MUS-SPEC-08-781G](08-git-changes-and-review.md#mus-spec-08-781g) | A file created in one turn and edited in a later one still opens whole in the first turn. | [`a file created in one turn and edited in a later one still opens whole in the first turn`](../../../packages/agent-app/tests/full-inline-diff-781.test.ts) |
| [MUS-SPEC-08-781H](08-git-changes-and-review.md#mus-spec-08-781h) | Every edit of a file the chat edited again opens whole, also across a rename. | [`every edit of a file the chat edited again later opens as the whole file, also across a rename`](../../../packages/agent-app/tests/full-inline-diff-781.test.ts) |
| [MUS-SPEC-08-781I](08-git-changes-and-review.md#mus-spec-08-781i) | An edit outside the chat's folder opens whole; a file next to it and a swapped-in link are refused. | [`a chat in one folder opens the whole file it edited in a worktree outside that folder, and nothing else there`](../../../packages/agent-app/tests/full-inline-diff-781.test.ts) |
| [MUS-SPEC-08-781J](08-git-changes-and-review.md#mus-spec-08-781j) | In a scratch chat's real transcript, a file edited three times in one turn and again in the next opens every edit as the whole file, with the Edited row and the files-changed pill kept outside the folded work. | [`a scratch chat: every edit of a file edited again in a later turn opens as the whole file in the transcript`](../../../packages/agent-app/tests/inline-diff-transcript-781-dom.tsx) |
| [MUS-SPEC-08-781K](08-git-changes-and-review.md#mus-spec-08-781k) | A file renamed twice after an edit is read under its final name; unnamed files and other chats stay refused. | [`the first edit of a file renamed twice afterwards reads the file under its final name, and only that`](../../../packages/agent-app/tests/full-inline-diff-781.test.ts) |
| [MUS-SPEC-08-781L](08-git-changes-and-review.md#mus-spec-08-781l) | The same real-transcript workflow in a chat with a folder reads through the folder and opens every edit whole. | [`a folder chat: every edit of a file edited again in a later turn opens as the whole file in the transcript`](../../../packages/agent-app/tests/inline-diff-transcript-781-dom.tsx) |
| [MUS-SPEC-08-781M](08-git-changes-and-review.md#mus-spec-08-781m) | The Changes popover opens the latest turn's file as the whole file, using the same later-edit history as the transcript. | [`the Changes popover opens the latest turn’s file as the whole file too`](../../../packages/agent-app/tests/inline-diff-transcript-781-dom.tsx) |
| [MUS-SPEC-08-409A](08-git-changes-and-review.md#mus-spec-08-409a) | Checking out an older commit leaves HEAD detached at it and `main` still on its tip. | [`checking out a commit detaches HEAD at it and leaves the branch where it was`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409B](08-git-changes-and-review.md#mus-spec-08-409b) | A branch made at an older commit points at it with HEAD unchanged; with “switch” HEAD is on it; an existing name is refused. | [`create branch here makes the branch at that commit and switches only when asked`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409C](08-git-changes-and-review.md#mus-spec-08-409c) | Picking a `topic` commit adds one commit on `main` with its change; picking a `main` commit is refused; nothing is left mid-pick. | [`cherry-pick copies a commit from another branch onto the current branch and refuses one that is already there`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409D](08-git-changes-and-review.md#mus-spec-08-409d) | Reverting a commit adds a “Revert …” commit and restores the file; a commit only on another branch is refused. | [`revert adds a commit that undoes the chosen commit and refuses one that is not on the branch`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409E](08-git-changes-and-review.md#mus-spec-08-409e) | Each HEAD-changing action is refused naming the changed file; the file’s content and HEAD are unchanged. | [`uncommitted changes block checkout, cherry-pick and revert, and nothing is touched`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409F](08-git-changes-and-review.md#mus-spec-08-409f) | The result lists `a.txt` as conflicted and the conflict state reports a cherry-pick (then a revert) in progress with that file. | [`a conflicting cherry-pick or revert stops in git’s normal conflict state and reports the files`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409G](08-git-changes-and-review.md#mus-spec-08-409g) | With a running chat, checkout is refused with “running”; with the confirmation flag it runs; branch creation without switching is never blocked; each action announces a workspace change. | [`a running chat in the folder blocks HEAD changes unless the person confirmed the warning`](../../../packages/agent-app/tests/git-commit-actions-409.test.ts) |
| [MUS-SPEC-08-409H](08-git-changes-and-review.md#mus-spec-08-409h) | Right-click and Shift+F10 on a commit row open a menu with Copy SHA, Copy message, Check out, Create branch, Cherry-pick and Revert; Copy SHA writes the full SHA. | [`a commit row opens its action menu on right-click and on Shift+F10, and Copy SHA copies the full SHA`](../../../packages/agent-app/tests/git-commit-actions-409-dom.tsx) |
| [MUS-SPEC-08-409I](08-git-changes-and-review.md#mus-spec-08-409i) | The checkout dialog names the commit and “detached”; nothing runs until confirm; confirm sends the status revision; the list and Changes reload. | [`checkout and revert confirm first, naming what happens, then refresh history and changes`](../../../packages/agent-app/tests/git-commit-actions-409-dom.tsx) |
| [MUS-SPEC-08-409J](08-git-changes-and-review.md#mus-spec-08-409j) | The dialog lists the changed files, says to commit or stash first, and the confirm button is disabled. | [`with uncommitted changes the dialog names them and offers no way to run the action`](../../../packages/agent-app/tests/git-commit-actions-409-dom.tsx) |
| [MUS-SPEC-08-409K](08-git-changes-and-review.md#mus-spec-08-409k) | The dialog names the running chat and its confirm reads “… anyway”; confirming sends `allowRunning`. | [`a running chat in the same folder is named before HEAD changes and the confirm says anyway`](../../../packages/agent-app/tests/git-commit-actions-409-dom.tsx) |
| [MUS-SPEC-08-409L](08-git-changes-and-review.md#mus-spec-08-409l) | After the action reports conflicts, the Changes tab and a conflict tab for the first file are open. | [`a conflicting cherry-pick opens changes and the conflict view for the first file`](../../../packages/agent-app/tests/git-commit-actions-409-dom.tsx) |
| [MUS-SPEC-08-409M](08-git-changes-and-review.md#mus-spec-08-409m) | The dialog has a name field and a “Switch to it” option; submit sends the name, the commit and the switch choice. | [`create branch here asks for a name and whether to switch to it`](../../../packages/agent-app/tests/git-commit-actions-409-dom.tsx) |
| [MUS-SPEC-08-329A](08-git-changes-and-review.md#mus-spec-08-329a) | ssh, scp-style and https remotes for gitlab.com, a gitlab.* host, a saved self-hosted host and bitbucket.org give the right kind, host, project path and web link; an unknown host and a local path are no forge; `remoteUrl` stays GitHub-only; GitLab reads MR, merge request and `!`. | [`GitLab and Bitbucket remotes are recognised from every git URL syntax, and a self-hosted GitLab once it has an account`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |
| [MUS-SPEC-08-329B](08-git-changes-and-review.md#mus-spec-08-329b) | With a token saved for gitlab.com, the repository, the open MR list, the create draft, create (pushed first, title prefixed Draft:), the MR view and merge (squash, head SHA sent, a stale SHA refused, rebase refused) map to the shared shapes; every request carries the token and goes only to gitlab.com. | [`GitLab with a token from Settings: list, create (pushing first), view and merge a merge request`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |
| [MUS-SPEC-08-329C](08-git-changes-and-review.md#mus-spec-08-329c) | The head pipeline’s jobs map to checks named stage / job with durations; a failed job fails, an allowed failure is neutral, a manual job is skipped, a running job is pending; the failed job’s trace becomes the log excerpt with section markers, colours and tokens removed. | [`GitLab pipelines: the head pipeline’s jobs are the checks, a failed job’s trace is the log, and CI repair can read it`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |
| [MUS-SPEC-08-329D](08-git-changes-and-review.md#mus-spec-08-329d) | With a fake glab signed in to gitlab.com and no token saved, requests go through `glab api --hostname gitlab.com` with no token from Muster, Settings lists glab as signed in there, and a self-hosted host glab is not signed in to uses the token saved for it. | [`GitLab through a signed-in glab: no token is stored or sent, and a self-hosted host with a saved account works`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |
| [MUS-SPEC-08-329E](08-git-changes-and-review.md#mus-spec-08-329e) | A token saved for git.acme.test is never sent to gitlab.com; the 401 says to sign in with glab or add a gitlab.com token in Settings › Integrations; a URL is refused as a host name; removing the account clears it. | [`a GitLab token is sent only to the host it was saved for; signed out says how to sign in`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |
| [MUS-SPEC-08-329F](08-git-changes-and-review.md#mus-spec-08-329f) | With a username and app password saved, the repository, PR list, create draft, create, PR view, build-status checks, conversation (inline and deleted comments left out, approvals as reviews), comment and merge (stale head refused before merging, squash strategy) work and every request uses basic auth. | [`Bitbucket Cloud with an app password: list, create, view, comment and merge a pull request; build statuses are its checks`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |
| [MUS-SPEC-08-329G](08-git-changes-and-review.md#mus-spec-08-329g) | Review threads, line comments, replies, resolve, reviews, reviewer requests and mark-ready each fail on GitLab and Bitbucket with a message naming the service, the noun and “GitHub-only”, and no request is sent. | [`GitHub-only review features say so on GitLab and Bitbucket, and send nothing`](../../../packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts) |

### Refs, dash-named files and submodules

<a id="mus-spec-08-781f"></a>
#### MUS-SPEC-08-781F: The existing editor displays full scratch files

- Precondition: A scratch-chat edit with two separated change blocks and unchanged header, middle and footer.
- Action: Expand its existing inline editor in light and dark themes.
- Expected result: All seven source/change rows, original line numbers and both added/deleted blocks render. There are no missing-context gaps and one scoped read per mount.
- Test: `packages/agent-app/tests/full-inline-diff-781-dom.tsx::opening a scratch edit renders unchanged source and every changed block in both themes`
- Environment: Production React component and bridge with deterministic filesystem response, linkedom.
- Known gaps: Layout and syntax colours require the separate browser evidence.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781g"></a>
#### MUS-SPEC-08-781G: A file created in one turn stays whole after a later turn edits it

- Precondition: A turn creates a file with a shell `apply_patch`; a later turn in the same chat changes it.
- Action: Expand the first turn's edit, then the later turn's edit.
- Expected result: The first turn shows the whole file it created, every line added, built from its own patch without reading the disk (so it still opens if the file is gone); the later turn shows the whole current file with its change in place. An update patch that no longer applies is not shown as a whole file.
- Test: `packages/agent-app/tests/full-inline-diff-781.test.ts::a file created in one turn and edited in a later one still opens whole in the first turn`
- Environment: Node test runner; stored shell rows recovered as the store reads them, the transcript's patch normalisation and the production diff model.
- Known gaps: Rendering of the editor is covered by MUS-SPEC-08-781F.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781h"></a>
#### MUS-SPEC-08-781H: Every edit of a file the chat edited again opens whole, also across a rename

- Precondition: A chat edits one file three times: an edit, then an edit that also renames it, then an edit under the new name.
- Action: Expand each of the three edits.
- Expected result: Each shows the whole file as that edit left it, with its own change in place: the chat's later edits to the file are undone from what is on disk now, and the first edit reads the file under its new name. Without the later edits the first edit cannot be placed, which is the snippet-only bug.
- Test: `packages/agent-app/tests/full-inline-diff-781.test.ts::every edit of a file the chat edited again later opens as the whole file, also across a rename`
- Environment: Node test runner; stored shell rows, `laterEdits` over the whole chat and the production diff model.
- Known gaps: A file changed outside the chat after its edits (by the user or another tool) still shows the recorded patch, labelled.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781i"></a>
#### MUS-SPEC-08-781I: An edit outside the chat's folder opens whole, and only that file is readable

- Precondition: A chat in one folder whose model edits a file in a worktree outside that folder; another file sits next to it.
- Action: Open the edit's inline diff, then ask for the file next to it, then replace the edited file with a link to that file and ask again.
- Expected result: The edited file is read whole and the diff is complete. The file next to it is refused because no edit recorded it, and a link put in place of the edited file is refused rather than followed.
- Test: `packages/agent-app/tests/full-inline-diff-781.test.ts::a chat in one folder opens the whole file it edited in a worktree outside that folder, and nothing else there`
- Environment: Node test runner; the agent service with a fake provider; temp folders.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781j"></a>
#### MUS-SPEC-08-781J: The real transcript opens every edit of a re-edited file as the whole file (scratch chat)

- Precondition: A scratch chat's first turn edits one file three times (one stored shell `apply_patch` row recovered by the store, two native file changes) and a second turn edits it again; "Inline diff length" is the default Full file.
- Action: Render the chat's timeline. Open the turn-1 Edited row, then unfold the turn's work and open the first of its three edits.
- Expected result: Turn 1 keeps an "Edited" row outside the folded work and ends with the "N files changed" pill. Both opened editors list every line of the file in order (no "unchanged lines" gaps, no snippet note), with removed and added lines in place as `.is-del` / `.is-add` rows, as the file stood after that edit (the second turn's change undone). The file is read through the chat-scoped read.
- Test: `packages/agent-app/tests/inline-diff-transcript-781-dom.tsx::a scratch chat: every edit of a file edited again in a later turn opens as the whole file in the transcript`
- Environment: Production Timeline, TurnFileChanges, ToolCard and FileChangeView with rows read back through the real store; bridge faked; linkedom.
- Known gaps: Colours and layout need the browser screenshots; a file changed outside the chat afterwards still shows the recorded patch, labelled.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781k"></a>
#### MUS-SPEC-08-781K: A file renamed more than once after an edit is still readable by that edit, and only that file

- Precondition: A chat edits `a.ts`, then renames it to `b.ts`, then renames that to `c.ts`; `c.ts` and an unrelated `other.ts` exist.
- Action: Ask for `c.ts` through the first edit row, for `other.ts`, and for `c.ts` from another chat.
- Expected result: The renderer's later-edit lookup names `c.ts` for the first edit, and the chat-scoped read returns `c.ts`. `other.ts` and the other chat's request are refused.
- Test: `packages/agent-app/tests/full-inline-diff-781.test.ts::the first edit of a file renamed twice afterwards reads the file under its final name, and only that`
- Environment: Node test runner; the agent service with a fake provider; temp folders.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781l"></a>
#### MUS-SPEC-08-781L: The real transcript opens every edit of a re-edited file as the whole file (folder chat)

- Precondition: The 781J chat, attached to a folder that contains the file.
- Action: Render the timeline and open the turn-1 Edited row and the first edit.
- Expected result: As 781J, read through the folder read of the file's folder-relative name.
- Test: `packages/agent-app/tests/inline-diff-transcript-781-dom.tsx::a folder chat: every edit of a file edited again in a later turn opens as the whole file in the transcript`
- Environment: As 781J.
- Known gaps: As 781J.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781m"></a>
#### MUS-SPEC-08-781M: The Changes popover opens the latest turn's file whole

- Precondition: The 781J chat, latest turn edited the file after an earlier turn did.
- Action: Open the "N files changed" popover and read its inline preview.
- Expected result: The preview lists every line of the file with the latest change in place; no gaps and no snippet note.
- Test: `packages/agent-app/tests/inline-diff-transcript-781-dom.tsx::the Changes popover opens the latest turn’s file as the whole file too`
- Environment: As 781J, with the production TurnChanges component.
- Known gaps: As 781J. The popover shows the latest turn, which has no later edits, so this case guards the popover's later-edit wiring and whole-file preview rather than failing on the previous code.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781d"></a>
#### MUS-SPEC-08-781D: Scratch chats retain the original whole-file inline review

- Precondition: A non-Git scratch chat renames and edits a file twice, with separated change blocks and unchanged header, middle and footer.
- Action: Open the recorded file through the chat-scoped read and construct its inline review.
- Expected result: All source lines remain in order, both original removed lines appear at their positions, and repeated edits reconstruct the pre-turn content. Other chats, unrelated files and symlink escapes cannot use the read.
- Test: `packages/agent-app/tests/full-inline-diff-781.test.ts::a scratch chat opens a complete multi-edit renamed file without granting arbitrary file reads`
- Environment: Real service, temporary filesystem and SQLite, deterministic provider events; no live app or network.
- Known gaps: Historical files no longer on disk cannot supply missing context.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781e"></a>
#### MUS-SPEC-08-781E: Contextual changes are placed only when unambiguous

- Precondition: A shell patch has multiple context-based change blocks without numbered hunk headers.
- Action: Reconstruct the complete inline file from its current source, then repeat with changed, duplicated or unanchored source.
- Expected result: Every unchanged line and deletion is present for a unique match; ambiguous, stale, malformed or unanchored deletions never fabricate a whole-file review.
- Test: `packages/agent-app/tests/full-inline-diff-781.test.ts::contextual shell hunks retain all source and refuse stale or ambiguous placement`
- Environment: Node test runner, production editor model.
- Known gaps: A historical edit without sufficient context intentionally remains an explicitly incomplete patch.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781a"></a>
#### MUS-SPEC-08-781A: Saved shell edits recover without replay or database rewrites

- Precondition: A saved chat and child transcript contain successful shell patch commands from an older app version, with additions and updates in a non-Git folder whose path contains spaces.
- Action: Close and reopen the store, then request the full timeline, snapshot, incremental changes, individual item and child transcript.
- Expected result: Every read restores both file patches and consistent totals, preserves command output, and leaves the persisted row and revision cursor unchanged.
- Test: `packages/agent-app/tests/stored-shell-patch-781.test.ts::reopening a saved shell-edit chat recovers all diffs without rewriting history`
- Environment: Node test runner, temporary real SQLite store, renderer change collector; no live database or network.
- Known gaps: Historical shell writes without patch evidence cannot be reconstructed safely.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781b"></a>
#### MUS-SPEC-08-781B: Recovery preserves non-edits and existing native diffs

- Precondition: Stored commands include failed, interrupted, running, cancelled and printed patches alongside native file-change metadata and a successful command-actions-only edit.
- Action: Load the saved tool rows and collect their changes.
- Expected result: Non-edits remain commands without changes, existing native metadata is untouched, and successful action-only edits recover both files.
- Test: `packages/agent-app/tests/stored-shell-patch-781.test.ts::saved non-edits stay commands and native changes remain intact`
- Environment: Node test runner, temporary real SQLite store and renderer change collector.
- Known gaps: Does not execute the recorded shell commands, intentionally.
- Evidence: UNVERIFIED

<a id="mus-spec-08-781c"></a>
#### MUS-SPEC-08-781C: Live streamed patch evidence survives a sparse completion event

- Precondition: A provider sends the command and working directory at start, streams the patch success output, then completes with only a final output chunk and exit code.
- Action: Request the chat timeline while the provider's reply is still running.
- Expected result: Both changed files and their diffs appear immediately, with the complete command output retained rather than waiting for chat reload or turn completion.
- Test: `packages/agent-app/tests/shell-patch-diff-779.test.ts::a streamed shell edit appears before the reply ends when completion omits command details`
- Environment: Real agent service and temporary SQLite state with a deterministic event-provider fixture; no network or live app.
- Known gaps: Does not verify a specific upstream provider's current event format.
- Evidence: UNVERIFIED

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

### Commit actions in the history graph (#409)

<a id="mus-spec-08-409a"></a>
#### MUS-SPEC-08-409A: Checking out a commit detaches HEAD and leaves the branch alone

- Precondition: A clean repository on `main` with three commits.
- Action: Run the history graph’s “Check out this commit” on the middle commit with the current status revision.
- Expected result: HEAD is detached at the middle commit, `main` still points at its old tip, the working files match the middle commit, and a stale status revision is refused without moving HEAD.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::checking out a commit detaches HEAD at it and leaves the branch where it was`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Calls the runtime helper directly; the menu and dialog are covered by MUS-SPEC-08-409H to 409K.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409b"></a>
#### MUS-SPEC-08-409B: Create branch here makes a branch at the commit, and switches only when asked

- Precondition: A clean repository on `main` with two commits.
- Action: Create `fix` at the first commit without switching, then `fix2` with switching, then `fix` again.
- Expected result: `fix` points at the first commit and HEAD stays on `main`; `fix2` is created and checked out; reusing `fix` is refused with “already exists”.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::create branch here makes the branch at that commit and switches only when asked`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Branch name rules are git’s own (`check-ref-format`), covered by the branch picker cases.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409c"></a>
#### MUS-SPEC-08-409C: Cherry-pick copies a commit from another branch onto the current one

- Precondition: A clean repository on `main` and a `topic` branch with a commit `main` does not have.
- Action: Cherry-pick the `topic` commit onto `main`, then try to cherry-pick a commit that is already on `main`.
- Expected result: A new commit on `main` carries the change and the original subject; the second pick is refused with “already on main” and no cherry-pick is in progress afterwards.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::cherry-pick copies a commit from another branch onto the current branch and refuses one that is already there`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Merge commits are picked against their first parent; that path has no separate case.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409d"></a>
#### MUS-SPEC-08-409D: Revert adds a commit that undoes the chosen one

- Precondition: A clean repository on `main` whose last two commits change `a.txt`, and a `topic` branch with its own commit.
- Action: Revert the older of the two commits, then try to revert the `topic` commit.
- Expected result: A new commit titled `Revert "…"` undoes that commit’s change and the original stays in history; reverting the `topic` commit is refused with “not on main”.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::revert adds a commit that undoes the chosen commit and refuses one that is not on the branch`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Uses git’s default revert message; there is no message editor.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409e"></a>
#### MUS-SPEC-08-409E: Uncommitted changes block checkout, cherry-pick and revert

- Precondition: A repository on `main` with an unstaged edit to `a.txt`, and a `topic` commit to pick.
- Action: Try to check out an older commit, cherry-pick the `topic` commit, revert the last commit, and create a branch with switching.
- Expected result: All four are refused with a message naming `a.txt` and saying to commit or stash first; `a.txt` still has the edit and HEAD has not moved. Creating a branch without switching still works.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::uncommitted changes block checkout, cherry-pick and revert, and nothing is touched`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Untracked files do not block; git itself refuses to overwrite one.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409f"></a>
#### MUS-SPEC-08-409F: A conflicting cherry-pick or revert stops in git’s conflict state

- Precondition: A clean repository where `main` and `topic` both changed the same line of `a.txt`.
- Action: Cherry-pick the `topic` commit onto `main`; abort; then revert a commit whose change a later commit overwrote.
- Expected result: Each action returns `conflicts: ["a.txt"]`, leaves CHERRY_PICK_HEAD or REVERT_HEAD, and the conflict state names the operation and the file so the existing conflict view can resolve, continue or abort.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::a conflicting cherry-pick or revert stops in git’s normal conflict state and reports the files`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Resolution itself is covered by the conflict resolver cases.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409g"></a>
#### MUS-SPEC-08-409G: A chat running in the folder blocks HEAD changes until the person confirms

- Precondition: A clean repository added as a folder, and a chat in that folder whose status is running.
- Action: Call the domain’s commit action for checkout without and with `allowRunning`, and create a branch without switching.
- Expected result: The first checkout is refused naming the running chat; the confirmed one detaches HEAD; branch creation succeeds; every successful action emits `workspaceChanged` for the folder.
- Test: `packages/agent-app/tests/git-commit-actions-409.test.ts::a running chat in the folder blocks HEAD changes unless the person confirmed the warning`
- Environment: Node test runner; git on PATH; the git domain with a stub store.
- Known gaps: The warning text is checked in MUS-SPEC-08-409K.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409h"></a>
#### MUS-SPEC-08-409H: A commit’s menu opens by right-click and from the keyboard

- Precondition: The History tab of a repository on `main`, showing commits.
- Action: Right-click a commit row; close the menu; focus the row and press Shift+F10; choose Copy SHA; reopen and choose Copy message.
- Expected result: The menu lists the six actions in that order and the browser menu is suppressed; the keyboard opens the same menu; the clipboard receives the 40-character SHA, then the full message.
- Test: `packages/agent-app/tests/git-commit-actions-409-dom.tsx::a commit row opens its action menu on right-click and on Shift+F10, and Copy SHA copies the full SHA`
- Environment: linkedom DOM; stubbed bridge; no Electron.
- Known gaps: Menu position and focus ring need the real app.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409i"></a>
#### MUS-SPEC-08-409I: Checkout and revert confirm first and refresh History and Changes

- Precondition: The History tab with a clean repository.
- Action: Choose “Check out this commit…”, read the dialog, confirm; then choose “Revert this commit…” and confirm.
- Expected result: Each dialog names the commit’s short SHA and subject and what happens (detached HEAD; a new commit undoing it on main); `git.commitAction` is called only after confirm with the revision from `git.status`; afterwards `git.log` and `git.changes` are requested again.
- Test: `packages/agent-app/tests/git-commit-actions-409-dom.tsx::checkout and revert confirm first, naming what happens, then refresh history and changes`
- Environment: linkedom DOM; stubbed bridge; no Electron.
- Known gaps: The real git work is covered by MUS-SPEC-08-409A and 409D.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409j"></a>
#### MUS-SPEC-08-409J: Uncommitted changes are named in the dialog and the action is disabled

- Precondition: The History tab; `git.status` reports two modified files.
- Action: Choose “Cherry-pick…” on a commit.
- Expected result: The dialog names both files and says to commit or stash them first; the confirm button is disabled and `git.commitAction` is never called.
- Test: `packages/agent-app/tests/git-commit-actions-409-dom.tsx::with uncommitted changes the dialog names them and offers no way to run the action`
- Environment: linkedom DOM; stubbed bridge; no Electron.
- Known gaps: The runtime refuses the same case on its own (MUS-SPEC-08-409E).
- Evidence: UNVERIFIED

<a id="mus-spec-08-409k"></a>
#### MUS-SPEC-08-409K: A running chat in the folder is named before HEAD changes

- Precondition: The History tab; a chat “Refactor parser” is running in the same folder.
- Action: Choose “Check out this commit…” and confirm.
- Expected result: The dialog warns that “Refactor parser” is running in this folder, the confirm button reads “Check out anyway”, and `git.commitAction` receives `allowRunning: true`.
- Test: `packages/agent-app/tests/git-commit-actions-409-dom.tsx::a running chat in the same folder is named before HEAD changes and the confirm says anyway`
- Environment: linkedom DOM; stubbed bridge; no Electron.
- Known gaps: Does not stop the chat; the person decides.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409l"></a>
#### MUS-SPEC-08-409L: A conflicting cherry-pick opens the conflict view

- Precondition: The History tab; `git.commitAction` returns `conflicts: ["src/app.ts"]`.
- Action: Cherry-pick a commit and confirm.
- Expected result: A Changes tab and a conflict tab for `src/app.ts` open, and a notice says the cherry-pick stopped on 1 conflicting file.
- Test: `packages/agent-app/tests/git-commit-actions-409-dom.tsx::a conflicting cherry-pick opens changes and the conflict view for the first file`
- Environment: linkedom DOM; stubbed bridge; no Electron.
- Known gaps: The conflict banner’s Continue and Abort are covered by the existing conflict cases.
- Evidence: UNVERIFIED

<a id="mus-spec-08-409m"></a>
#### MUS-SPEC-08-409M: Create branch here asks for a name and whether to switch

- Precondition: The History tab with a clean repository.
- Action: Choose “Create branch here…”, type `hotfix`, tick “Switch to it”, submit.
- Expected result: `git.commitAction` receives action `branch`, branch `hotfix`, the commit SHA and `checkout: true`; the dialog closes and a notice names the branch.
- Test: `packages/agent-app/tests/git-commit-actions-409-dom.tsx::create branch here asks for a name and whether to switch to it`
- Environment: linkedom DOM; stubbed bridge; no Electron.
- Known gaps: Name validation is git’s own and is reported by the runtime.
- Evidence: UNVERIFIED

### GitLab merge requests and Bitbucket pull requests (#329)

<a id="mus-spec-08-329a"></a>
#### MUS-SPEC-08-329A: GitLab and Bitbucket remotes are recognised from every git URL syntax, and a self-hosted GitLab once it has an account

- Precondition: Remote URLs in each git syntax, with and without credentials; a repository whose origin is on gitlab.com.
- Action: Detect the forge of each URL, read the repository status, and read the labels for each forge.
- Expected result: GitLab and Bitbucket remotes are recognised with a lower-case host, no credentials and an https web link; a host with a saved GitLab account is GitLab, an unknown one is not guessed; the status carries `forge` and `forgeUrl` while `remoteUrl` stays empty; GitLab is labelled MR / merge request / `!`, the others PR / pull request / `#`.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::GitLab and Bitbucket remotes are recognised from every git URL syntax, and a self-hosted GitLab once it has an account`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Self-hosted GitLab on a host not named gitlab.* is recognised only after a token is saved for it in Settings; Bitbucket Server / Data Center is not recognised.
- Evidence: UNVERIFIED

<a id="mus-spec-08-329b"></a>
#### MUS-SPEC-08-329B: GitLab with a token from Settings: list, create (pushing first), view and merge a merge request

- Precondition: A local fake GitLab API; a repository whose origin is on gitlab.com and pushes to a local bare repository, on an unpublished `feature/widget` branch; a GitLab token saved in Settings › Integrations; no glab.
- Action: Save the token, then read the repository, list merge requests, prefill and create a draft merge request, open it, merge with a stale head, with squash, and with rebase.
- Expected result: The token never comes back to the UI; the list and the MR read like a GitHub PR (state, branches, head SHA, mergeability, reviewers); create pushes the branch then posts `Draft: Add widget`; the stale merge is refused, squash merges with the head SHA, rebase is refused as not allowed; every request has the token and goes to gitlab.com only.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::GitLab with a token from Settings: list, create (pushing first), view and merge a merge request`
- Environment: Node test runner; git on PATH; a local HTTP server standing in for GitLab; an in-memory secret box.
- Known gaps: Forks (an MR from a fork project into its parent) are not created from here; GitLab’s rebase and fast-forward merge are the project’s setting and not chosen per merge.
- Evidence: UNVERIFIED

<a id="mus-spec-08-329c"></a>
#### MUS-SPEC-08-329C: GitLab pipelines: the head pipeline’s jobs are the checks, and a failed job’s trace is its log

- Precondition: A local fake GitLab API with an MR whose head pipeline has passed, failed, allowed-to-fail, manual and running jobs, and the failed job’s raw trace.
- Action: Read the MR’s checks, then the log of the failed job, then ask for a GitHub-style check id.
- Expected result: Five checks with the right states and summary (1 passed, 1 failing, 1 running, 2 skipped), failures first; the log excerpt shows the failing test and exit line with no section markers, ANSI codes or the printed token; a non-job id is refused.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::GitLab pipelines: the head pipeline’s jobs are the checks, a failed job’s trace is the log, and CI repair can read it`
- Environment: Node test runner; git on PATH; a local HTTP server standing in for GitLab; an in-memory secret box.
- Known gaps: Only the head pipeline is read (child pipelines and bridge jobs are not followed); “Fix failing checks” uses the same log reader but its agent loop is covered only by the GitHub cases.
- Evidence: UNVERIFIED

<a id="mus-spec-08-329d"></a>
#### MUS-SPEC-08-329D: GitLab through a signed-in glab, and a self-hosted host with a saved account

- Precondition: A fake glab signed in to gitlab.com only; a local fake GitLab API; one repository on gitlab.com and one on git.acme.test.
- Action: Open MR !5 on the gitlab.com repository, list the accounts, save a token for git.acme.test, then open MR !8 on that repository.
- Expected result: The first MR is read through glab (auth status, then api with the URL-encoded project path) and carries no token; accounts are empty and glab lists gitlab.com; git.acme.test reads as GitLab once its token is saved and its request carries that token.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::GitLab through a signed-in glab: no token is stored or sent, and a self-hosted host with a saved account works`
- Environment: Node test runner; git on PATH; a fake glab script and a local HTTP server standing in for GitLab; an in-memory secret box.
- Known gaps: The fake glab copies `glab api --include` output (status line, headers, body); a real glab release should be checked once.
- Evidence: UNVERIFIED

<a id="mus-spec-08-329e"></a>
#### MUS-SPEC-08-329E: A GitLab token is sent only to the host it was saved for

- Precondition: A token saved for git.acme.test; a repository on gitlab.com; no glab; a local fake GitLab that answers 401 without a token.
- Action: Open an MR on the gitlab.com repository, try to save an account with a URL as its host, then remove the saved account.
- Expected result: The read fails naming glab auth login, Settings › Integrations and gitlab.com; no request carried a token; the URL host is refused; the account list is empty after removal.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::a GitLab token is sent only to the host it was saved for; signed out says how to sign in`
- Environment: Node test runner; git on PATH; a local HTTP server standing in for GitLab; an in-memory secret box.
- Known gaps: One token per host; several GitLab accounts on the same host are not supported.
- Evidence: UNVERIFIED

<a id="mus-spec-08-329f"></a>
#### MUS-SPEC-08-329F: Bitbucket Cloud with an app password: list, create, view, comment and merge a pull request

- Precondition: A local fake Bitbucket API; a repository whose origin is on bitbucket.org and pushes to a local bare repository, on an unpublished `feature/widget` branch; a username and app password saved in Settings › Integrations.
- Action: Read the repository, list, prefill and create a PR, open it, read its checks and a failed build’s log, read and add comments, merge with a stale head and then with squash.
- Expected result: All shapes match the GitHub surfaces; checks are 1 passed, 1 failing, 1 running; the failed build’s log says Bitbucket logs are not read yet and to open the build page; the stale merge is refused with nothing sent; squash sends `merge_strategy: squash`; every request has the basic auth header.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::Bitbucket Cloud with an app password: list, create, view, comment and merge a pull request; build statuses are its checks`
- Environment: Node test runner; git on PATH; a local HTTP server standing in for Bitbucket Cloud; an in-memory secret box.
- Known gaps: Bitbucket Pipelines step logs are not read (follow-up); the head-SHA guard is checked just before the merge call, not atomically by Bitbucket; Bitbucket Server / Data Center is not supported.
- Evidence: UNVERIFIED

<a id="mus-spec-08-329g"></a>
#### MUS-SPEC-08-329G: GitHub-only review features say so on GitLab and Bitbucket, and send nothing

- Precondition: A repository on gitlab.com and one on bitbucket.org; local fake APIs with no routes.
- Action: Call each GitHub-only review command on each repository.
- Expected result: Every call is refused with “… GitHub-only …” naming GitLab / merge request or Bitbucket / pull request; the fake servers saw no request.
- Test: `packages/agent-app/tests/forge-gitlab-bitbucket-329.test.ts::GitHub-only review features say so on GitLab and Bitbucket, and send nothing`
- Environment: Node test runner; git on PATH; local HTTP servers standing in for GitLab and Bitbucket.
- Known gaps: The PR tab hides these controls for those remotes; that rendering is not covered by a DOM case.
- Evidence: UNVERIFIED
