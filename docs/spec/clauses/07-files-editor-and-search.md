# MUS-SPEC-07: Files, editor and search

The workspace pane shows the chat's folder: a file tree, file tabs with an editor and previews, and search.

What the user can do:
- browse, open, create, rename, move and delete files and folders;
- edit text and code with syntax colouring, and preview images, PDFs, spreadsheets and Markdown;
- search file names and contents, and jump to a file from a link in a reply.

Boundaries:
- File actions stay inside the chat's folder; a path that escapes it is refused.
- A file changed on disk by the agent or another app refreshes in the open tab without losing unsaved edits.
- Diffs and history are clause [08](08-git-changes-and-review.md).

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-07-565A](07-files-editor-and-search.md#mus-spec-07-565a) | A file created through the service after a first empty search shows up in the next Quick open search for it. | [`quick open finds a file created after its first search`](../../../packages/agent-app/tests/quick-open-fresh.test.ts) |
| [MUS-SPEC-07-565B](07-files-editor-and-search.md#mus-spec-07-565b) | Writing files into .next, .turbo and __pycache__ produces no change notice. | [`always-generated caches (.next, .turbo, __pycache__) never trigger refreshes`](../../../packages/agent-app/tests/workspace-watch.test.ts) |
| [MUS-SPEC-07-565C](07-files-editor-and-search.md#mus-spec-07-565c) | Twenty writes each into an ignored dist/ and target/debug/ send no notice, and a source file written next still does. | [`a git-ignored dist/ or target/ does not refresh; source files still do`](../../../packages/agent-app/tests/workspace-watch.test.ts) |
| [MUS-SPEC-07-565D](07-files-editor-and-search.md#mus-spec-07-565d) | After dist/ is added to .gitignore, edits inside it stop sending notices without re-opening the folder. | [`ignoring dist/ in .gitignore takes effect without re-watching the folder`](../../../packages/agent-app/tests/workspace-watch.test.ts) |

### Quick open and file watching

<a id="mus-spec-07-565a"></a>
#### MUS-SPEC-07-565A: Quick open finds a file created after the first search

- Precondition: A folder is open and Quick open has already searched it once (result: none).
- Action: Create `fresh-notes.md` in the folder, then search Quick open for "fresh".
- Expected result: The search returns `fresh-notes.md`, not a list up to 30 seconds old.
- Test: `packages/agent-app/tests/quick-open-fresh.test.ts::quick open finds a file created after its first search`
- Environment: Node test runner; no network, no provider. Real agent service with a fake provider and a temp folder.
- Known gaps: Covers a file created through Muster. A file added by another app depends on the folder watcher, which is covered by the watcher cases.
- Evidence: UNVERIFIED

<a id="mus-spec-07-565b"></a>
#### MUS-SPEC-07-565B: Generated caches do not refresh the file tree

- Precondition: A watched folder holds `.next`, `.turbo` and `__pycache__` folders.
- Action: A build writes a file into each of them and the watcher waits past its quiet time.
- Expected result: No change notice is sent, so the Files pane and Changes list do not refresh.
- Test: `packages/agent-app/tests/workspace-watch.test.ts::always-generated caches (.next, .turbo, __pycache__) never trigger refreshes`
- Environment: Node test runner; no network, no provider. Real file watcher on a temp folder.
- Known gaps: Depends on the system file watcher; not run on Windows or Linux here.
- Evidence: UNVERIFIED

<a id="mus-spec-07-565c"></a>
#### MUS-SPEC-07-565C: Git-ignored build output does not refresh the file tree

- Precondition: A git repository ignores `dist/` and `/target` and the folder is watched.
- Action: A build writes 20 files into each ignored folder, then a source file is written.
- Expected result: The build files send no change notice; the source file does.
- Test: `packages/agent-app/tests/workspace-watch.test.ts::a git-ignored dist/ or target/ does not refresh; source files still do`
- Environment: Node test runner; no network, no provider. Needs `git` installed; the test skips itself when it is missing. Real file watcher on a temp repository.
- Known gaps: The test skips itself when git is missing, so a green run without git proves nothing.
- Evidence: UNVERIFIED

<a id="mus-spec-07-565d"></a>
#### MUS-SPEC-07-565D: Ignoring a build folder in .gitignore takes effect at once

- Precondition: A watched repository has a `dist/` folder that is not ignored yet; a change in it sends a notice.
- Action: Add `dist/` to `.gitignore` (which itself sends one notice), then write another file into `dist/`.
- Expected result: The new file in `dist/` sends no notice.
- Test: `packages/agent-app/tests/workspace-watch.test.ts::ignoring dist/ in .gitignore takes effect without re-watching the folder`
- Environment: Node test runner; no network, no provider. Needs `git`; the test skips itself when it is missing. Real file watcher on a temp repository.
- Known gaps: The test skips itself when git is missing. The case that a committed dist/ keeps refreshing already passes on main, so it is not linked.
- Evidence: UNVERIFIED
