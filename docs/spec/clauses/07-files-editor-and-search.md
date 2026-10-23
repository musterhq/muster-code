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
| [MUS-SPEC-07-563A](07-files-editor-and-search.md#mus-spec-07-563a) | Moving folder a to a/b is refused with a message that says the folder cannot be moved into itself. | [`a folder cannot be moved into itself and says so plainly`](../../../packages/agent-app/tests/file-operations.test.ts) |
| [MUS-SPEC-07-563B](07-files-editor-and-search.md#mus-spec-07-563b) | On a case-insensitive disk, Readme.md becomes README.md and Docs becomes docs, with the file's contents kept. | [`renaming a file or folder to a different capitalisation works on case-insensitive disks`](../../../packages/agent-app/tests/file-operations.test.ts) |
| [MUS-SPEC-07-563C](07-files-editor-and-search.md#mus-spec-07-563c) | Searching for ^(a+)+$ in a line of 34 letter a and a bang returns within 8 seconds with the result marked partial. | [`a catastrophic regular expression is cut off at the search deadline`](../../../packages/agent-app/tests/content-search-regex.test.ts) |

### Moving, renaming and searching with regular expressions

<a id="mus-spec-07-563a"></a>
#### MUS-SPEC-07-563A: Moving a folder into itself gives a plain error

- Precondition: A workspace has a folder named a.
- Action: Move a to a/b with the real file mover.
- Expected result: The move is refused with the message "A folder cannot be moved into itself.", not a raw system error.
- Test: `packages/agent-app/tests/file-operations.test.ts::a folder cannot be moved into itself and says so plainly`
- Environment: Node test runner; real files in a temp folder.
- Known gaps: Calls the file mover, not the Files pane that shows the message.
- Evidence: UNVERIFIED

<a id="mus-spec-07-563b"></a>
#### MUS-SPEC-07-563B: A rename that only changes capitals works

- Precondition: A workspace on a case-insensitive disk has a file Readme.md holding "keep" and a folder Docs.
- Action: Move Readme.md to README.md and Docs to docs.
- Expected result: Both moves work. The folder lists README.md and docs and no longer lists the old names, and the file still holds "keep".
- Test: `packages/agent-app/tests/file-operations.test.ts::renaming a file or folder to a different capitalisation works on case-insensitive disks`
- Environment: Node test runner; real files in a temp folder.
- Known gaps: On a case-sensitive disk the test checks the disk first and then does nothing, so it proves nothing there. On such a disk the two names are different items and a plain move already works.
- Evidence: UNVERIFIED

<a id="mus-spec-07-563c"></a>
#### MUS-SPEC-07-563C: A regular expression that backtracks without end is stopped at the search limit

- Precondition: A folder holds a file whose one line is 34 letter a followed by a bang, and ripgrep is not available, so the built-in search is used.
- Action: Search the folder contents with the regular expression ^(a+)+$.
- Expected result: The search returns in less than 8 seconds and the result is marked as partial, instead of freezing the app.
- Test: `packages/agent-app/tests/content-search-regex.test.ts::a catastrophic regular expression is cut off at the search deadline`
- Environment: Node test runner; real files in a temp folder; the PATH is emptied so the built-in search runs.
- Known gaps: Does not cover ripgrep, which has its own time limit. The test allows up to 8 seconds, so it is slow when it passes.
- Evidence: UNVERIFIED

