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
| [MUS-SPEC-07-630A](07-files-editor-and-search.md#mus-spec-07-630a) | After "Load full file" on a 21,184-line file, fewer than 100 rows and 500 elements are on the page, rows keep their height, the table reports every row to assistive tech, a scrollbar jump paints rows in the same frame, and no task runs longer than 50ms. | [`a 21,184-line file loads in full with bounded rows, and selection, copy and find still work`](../../../packages/agent-app/tests/virtual-file-source.browser.tsx) |
| [MUS-SPEC-07-630B](07-files-editor-and-search.md#mus-spec-07-630b) | Copy returns the exact source text, including lines that are not on the page, for forward, backward and spacer-ending selections and Select All; "Add to chat" keeps the text and line bounds. | [`a 21,184-line file loads in full with bounded rows, and selection, copy and find still work`](../../../packages/agent-app/tests/virtual-file-source.browser.tsx) |
| [MUS-SPEC-07-630C](07-files-editor-and-search.md#mus-spec-07-630c) | Find counts matches in the whole file, Next and Previous scroll to an off-screen match (up and sideways) and the page stays at fewer than 100 rows. | [`a 21,184-line file loads in full with bounded rows, and selection, copy and find still work`](../../../packages/agent-app/tests/virtual-file-source.browser.tsx) |
| [MUS-SPEC-07-645A](07-files-editor-and-search.md#mus-spec-07-645a) | A 2 MB file the last turn edited, and its blame view, draw fewer than 2,000 elements and under 100 rows; change markers, Undo, Keep, Previous/Next change, Copy and Find still work, and the plain-patch view is bounded too. | [`a 2 MB edited file and its blame view stay windowed`](../../../packages/agent-app/tests/large-edited-file-dom.tsx) |
| [MUS-SPEC-07-276A](07-files-editor-and-search.md#mus-spec-07-276a) | After a spreadsheet refreshes while the machine is slow to paint, the first cell ends up selected; the check waits for that cell instead of a fixed time. | [`refreshed sheet selects its first available cell`](../../../packages/agent-app/tests/renderer-lifecycle.tsx) |
| [MUS-SPEC-07-559A](07-files-editor-and-search.md#mus-spec-07-559a) | A file read with an encoding warning shows a message, with no text box and no Save button. | [`a file that is not valid UTF-8 is not offered for editing`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559B](07-files-editor-and-search.md#mus-spec-07-559b) | A file read as cut short shows a message, with no text box. | [`a file larger than the full-read limit is not offered for editing`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559C](07-files-editor-and-search.md#mus-spec-07-559c) | Text typed during a save is still in the box afterwards, and the editor still says Unsaved changes. | [`text typed while a save is in flight is kept`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559D](07-files-editor-and-search.md#mus-spec-07-559d) | When re-reading the file fails, the conflict banner stays, the error is shown and nothing is thrown unhandled. | [`a failed Discard and reload keeps the conflict banner and shows the error`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-562A](07-files-editor-and-search.md#mus-spec-07-562a) | A valid UTF-8 file cut at the preview limit reports truncated, no encoding warning, and no replacement character. | [`a valid UTF-8 file cut at the preview limit is not reported as having an encoding problem`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562B](07-files-editor-and-search.md#mus-spec-07-562b) | After a save, a script that was mode 755 is still 755. | [`saving a file keeps its permissions, so a script stays executable`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562C](07-files-editor-and-search.md#mus-spec-07-562c) | A search finds a match in a sub folder and lists it as sub/a.txt, with no ./ in front. | [`content search returns folder-relative paths whether or not ripgrep is installed`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562D](07-files-editor-and-search.md#mus-spec-07-562d) | Resolving usr inside the filesystem root returns the root joined with usr instead of an escape error. | [`a folder registered at a filesystem root still resolves paths inside it`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-563A](07-files-editor-and-search.md#mus-spec-07-563a) | Moving folder a to a/b is refused with a message that says the folder cannot be moved into itself. | [`a folder cannot be moved into itself and says so plainly`](../../../packages/agent-app/tests/file-operations.test.ts) |
| [MUS-SPEC-07-563B](07-files-editor-and-search.md#mus-spec-07-563b) | On a case-insensitive disk, Readme.md becomes README.md and Docs becomes docs, with the file's contents kept. | [`renaming a file or folder to a different capitalisation works on case-insensitive disks`](../../../packages/agent-app/tests/file-operations.test.ts) |
| [MUS-SPEC-07-563C](07-files-editor-and-search.md#mus-spec-07-563c) | Searching for ^(a+)+$ in a line of 34 letter a and a bang returns within 8 seconds with the result marked partial. | [`a catastrophic regular expression is cut off at the search deadline`](../../../packages/agent-app/tests/content-search-regex.test.ts) |
| [MUS-SPEC-07-565A](07-files-editor-and-search.md#mus-spec-07-565a) | A file created through the service after a first empty search shows up in the next Quick open search for it. | [`quick open finds a file created after its first search`](../../../packages/agent-app/tests/quick-open-fresh.test.ts) |
| [MUS-SPEC-07-565B](07-files-editor-and-search.md#mus-spec-07-565b) | Writing files into .next, .turbo and __pycache__ produces no change notice. | [`always-generated caches (.next, .turbo, __pycache__) never trigger refreshes`](../../../packages/agent-app/tests/workspace-watch.test.ts) |
| [MUS-SPEC-07-565C](07-files-editor-and-search.md#mus-spec-07-565c) | Twenty writes each into an ignored dist/ and target/debug/ send no notice, and a source file written next still does. | [`a git-ignored dist/ or target/ does not refresh; source files still do`](../../../packages/agent-app/tests/workspace-watch.test.ts) |
| [MUS-SPEC-07-565D](07-files-editor-and-search.md#mus-spec-07-565d) | After dist/ is added to .gitignore, edits inside it stop sending notices without re-opening the folder. | [`ignoring dist/ in .gitignore takes effect without re-watching the folder`](../../../packages/agent-app/tests/workspace-watch.test.ts) |
| [MUS-SPEC-07-572A](07-files-editor-and-search.md#mus-spec-07-572a) | Search prefixes named like object keys stay plain words in the all scope. | [`search scope prefixes named after Object.prototype keys are plain words`](../../../packages/agent-app/tests/protocol-bughunt.test.ts) |
| [MUS-SPEC-07-33A](07-files-editor-and-search.md#mus-spec-07-33a) | Case, literal and regular-expression modes, and a sub-folder scope, through the real rg binary. | [`ripgrep content search returns path, line and text, honouring case and literal or regex modes`](../../../packages/agent-app/tests/content-search-ripgrep.test.ts) |
| [MUS-SPEC-07-33B](07-files-editor-and-search.md#mus-spec-07-33b) | The 500-match cap, the partial flag and the 500-character line clip, through the real rg binary. | [`ripgrep content search stops at 500 matches, reports truncation and clips long lines`](../../../packages/agent-app/tests/content-search-ripgrep.test.ts) |
| [MUS-SPEC-07-33C](07-files-editor-and-search.md#mus-spec-07-33c) | Cancel by request id, the partial flag and reuse of the id, through the real rg binary. | [`cancelling a ripgrep content search ends it early as truncated and frees the request id`](../../../packages/agent-app/tests/content-search-ripgrep.test.ts) |
| [MUS-SPEC-07-33D](07-files-editor-and-search.md#mus-spec-07-33d) | The JavaScript walk used when rg is not installed: matches, case and regular-expression modes, invalid patterns, sub-folder scope. | [`content search without ripgrep walks the folder for matches, case modes and regular expressions`](../../../packages/agent-app/tests/content-search-fallback.test.ts) |
| [MUS-SPEC-07-33E](07-files-editor-and-search.md#mus-spec-07-33e) | The JavaScript walk leaves out node_modules, .git, dist, build, binary files and links that leave the folder, and refuses bad input. | [`content search skips build folders and binary files, and stays inside the folder`](../../../packages/agent-app/tests/content-search-fallback.test.ts) |
| [MUS-SPEC-07-33F](07-files-editor-and-search.md#mus-spec-07-33f) | The 500-match cap, the partial flag and the 500-character line clip in the JavaScript walk. | [`content search without ripgrep stops at 500 matches, reports truncation and clips long lines`](../../../packages/agent-app/tests/content-search-fallback.test.ts) |
| [MUS-SPEC-07-33G](07-files-editor-and-search.md#mus-spec-07-33g) | Cancel by request id in the JavaScript walk. | [`cancelling a content search without ripgrep stops the walk early as truncated and frees the request id`](../../../packages/agent-app/tests/content-search-fallback.test.ts) |
| [MUS-SPEC-07-33H](07-files-editor-and-search.md#mus-spec-07-33h) | The Find bar opens on Cmd+F in an open file, marks every match and counts them. | [`Cmd+F opens Find in the open file and typing shows the match count with every match marked`](../../../packages/agent-app/tests/file-find-dom.tsx) |
| [MUS-SPEC-07-33I](07-files-editor-and-search.md#mus-spec-07-33i) | Stepping through matches with wrap on and off, and a new search starting again at the first match. | [`Next, Previous and Enter step through the matches and wrap around, and Wrap around off stops at the ends`](../../../packages/agent-app/tests/file-find-dom.tsx) |
| [MUS-SPEC-07-33J](07-files-editor-and-search.md#mus-spec-07-33j) | Closing Find with Escape or the Close find button restores the source view and keeps the last search. | [`Escape and Close find close the Find bar and show the file as source again`](../../../packages/agent-app/tests/file-find-dom.tsx) |

### Large files

<a id="mus-spec-07-630a"></a>
#### MUS-SPEC-07-630A: A large file loads without freezing the page

- Precondition: A text file of 21,184 lines whose first read was cut short, so the tab offers "Load full file".
- Action: Click "Load full file", scroll by dragging far in one step, and scroll to the end.
- Expected result: The file shows in full, but only a small window of rows is on the page (fewer than 100 rows, fewer than 500 elements). Rows are as tall as in a small file. The table still reports all 21,184 rows to assistive tech. After a big scroll jump the rows under the viewport are drawn in that same frame. No browser task runs longer than 50ms during load, scroll, search and selection. The sideways scroll position does not change when the rows on screen change.
- Test: `packages/agent-app/tests/virtual-file-source.browser.tsx::a 21,184-line file loads in full with bounded rows, and selection, copy and find still work`
- Environment: A real Chrome (headless), started by `tests/run-virtual-file-source.mjs`; `CHROME_PATH` sets the browser. Not part of `test:renderer`; run it by hand.
- Known gaps: One check holds the whole scenario, so 630A, 630B and 630C share one test and one result. The 50ms limit depends on the machine running it.
- Evidence: UNVERIFIED

<a id="mus-spec-07-630b"></a>
#### MUS-SPEC-07-630B: Copy and "Add to chat" still get the real text of a large file

- Precondition: The full 21,184-line file is open and most rows are not on the page.
- Action: Select from near the top to the end; select backwards; end the selection on a gap between rows; use Select All; then use "Add to chat".
- Expected result: Copy returns the exact original text of the whole selected range, including lines that are not on the page, in every case, and Select All copies the entire file. "Add to chat" keeps the selected text (up to 8,000 characters) with the start and end line numbers 1 and 21,184.
- Test: `packages/agent-app/tests/virtual-file-source.browser.tsx::a 21,184-line file loads in full with bounded rows, and selection, copy and find still work`
- Environment: A real Chrome (headless), started by `tests/run-virtual-file-source.mjs`.
- Known gaps: The copy event is sent by the test, not by the operating system's copy command. See 630A for the shared check.
- Evidence: UNVERIFIED

<a id="mus-spec-07-630c"></a>
#### MUS-SPEC-07-630C: Find works across the whole large file

- Precondition: The full 21,184-line file is open. The word "needle" appears on the first and last lines.
- Action: Press Ctrl+F, type "needle", then press Next twice and Previous once.
- Expected result: The count reads 1/2. Next goes to the match on the last line and scrolls it into view, down the file and sideways. The next one goes back to line 1, and Previous returns to the last line. The page stays under 100 rows throughout.
- Test: `packages/agent-app/tests/virtual-file-source.browser.tsx::a 21,184-line file loads in full with bounded rows, and selection, copy and find still work`
- Environment: A real Chrome (headless), started by `tests/run-virtual-file-source.mjs`.
- Known gaps: See 630A for the shared check.
- Evidence: UNVERIFIED

<a id="mus-spec-07-645a"></a>
#### MUS-SPEC-07-645A: The edited-file and blame views of a large file stay light

- Precondition: An 18,000-line file of about 2 MB that the chat's last turn edited in three places (one changed line, one changed line in the middle, one deleted line), with a baseline for that turn and blame data from two commits.
- Action: Open the file; click Undo on the first change, then Keep; press Previous change; select from line 3 to near the end and copy; press Ctrl+F and search; close search; turn on Blame and scroll to the second commit.
- Expected result: Both views draw fewer than 2,000 elements and fewer than 100 rows, and the table still reports every row. Added and removed lines carry their + and − markers. Undo and Keep act on the first change, and the count drops by one. Previous change brings a far-off change into view. Copy returns the exact source text, including rows that are not on the page. Find counts the match in the whole file. In Blame, the first line names its commit and scrolling to line 9,001 shows the second commit's note. The view for a latest-edit patch of a 2 MB file is bounded too, and a small file keeps the full table.
- Test: `packages/agent-app/tests/large-edited-file-dom.tsx::a 2 MB edited file and its blame view stay windowed`
- Environment: linkedom DOM suite in `scripts/test-renderer.mjs` (`large-edited-file-dom`).
- Known gaps: linkedom does no layout, so row heights and scroll positions are simulated (21px rows, 600px viewport); the 50ms long-task limit is not measured here (run the headless Chrome check for that). Large files in these two views are not syntax coloured.
- Evidence: UNVERIFIED

<a id="mus-spec-07-276a"></a>
#### MUS-SPEC-07-276A: A refreshed spreadsheet selects its first cell, however slow the paint

- Precondition: A spreadsheet preview is open with a cell selected on its second page. The machine is slow: the screen update after a refresh arrives later than a fixed 40 ms wait.
- Action: The file changes on disk, so the preview receives a new revision with a single short row.
- Expected result: Once the update lands, the preview shows page 1 and its first cell is the selected one. The check waits for that cell to appear; it does not pass or fail on a fixed delay.
- Test: `packages/agent-app/tests/renderer-lifecycle.tsx::refreshed sheet selects its first available cell`
- Environment: linkedom DOM suite run by `scripts/test-renderer.mjs`.
- Known gaps: A slow machine is simulated by making the refreshed rows costly to read. Real runner load is not reproduced.
- Evidence: UNVERIFIED

### Editing a file in the pane

<a id="mus-spec-07-559a"></a>
#### MUS-SPEC-07-559A: A file that is not valid UTF-8 is not offered for editing

- Precondition: A file holds bytes that are not valid UTF-8, so reading it replaced them with substitute characters.
- Action: Open the file in the editor.
- Expected result: The editor says it cannot edit the file and offers no text box and no Save button, so the original bytes cannot be overwritten.
- Test: `packages/agent-app/tests/file-editor-safety-dom.tsx::a file that is not valid UTF-8 is not offered for editing`
- Environment: Node and linkedom: a DOM suite with the real FileEditor and a fake bridge; no files on disk.
- Known gaps: The bridge is faked, so the real read that sets the warning is not run here.
- Evidence: UNVERIFIED

<a id="mus-spec-07-559b"></a>
#### MUS-SPEC-07-559B: A file past the full-read limit is not offered for editing

- Precondition: A file is larger than the full-read limit, so only the start of it was read.
- Action: Open the file in the editor.
- Expected result: The editor says the file is too large to edit and offers no text box, so a save cannot cut the file short on disk.
- Test: `packages/agent-app/tests/file-editor-safety-dom.tsx::a file larger than the full-read limit is not offered for editing`
- Environment: Node and linkedom: a DOM suite with the real FileEditor and a fake bridge; no files on disk.
- Known gaps: The bridge is faked, so the real size limit is not run here.
- Evidence: UNVERIFIED

<a id="mus-spec-07-559c"></a>
#### MUS-SPEC-07-559C: Text typed while a save finishes is kept

- Precondition: A file is open with an edit, and the user has clicked Save, but the write has not finished.
- Action: Type more text, then let the write finish.
- Expected result: The box still shows the newly typed text, the saved text becomes the baseline, and the editor shows Unsaved changes for the extra text.
- Test: `packages/agent-app/tests/file-editor-safety-dom.tsx::text typed while a save is in flight is kept`
- Environment: Node and linkedom: a DOM suite with the real FileEditor and a fake bridge whose write is finished by the test; no files on disk.
- Known gaps: The write is faked, so no real file is saved.
- Evidence: UNVERIFIED

<a id="mus-spec-07-559d"></a>
#### MUS-SPEC-07-559D: A failed Discard and reload keeps the conflict notice and shows the error

- Precondition: A save found the file changed on disk, so the conflict banner is showing, and the file can no longer be read.
- Action: Click Discard your edit and reload.
- Expected result: The conflict banner stays, the error is shown, and there is no unhandled rejection.
- Test: `packages/agent-app/tests/file-editor-safety-dom.tsx::a failed Discard and reload keeps the conflict banner and shows the error`
- Environment: Node and linkedom: a DOM suite with the real FileEditor and a fake bridge that fails the read; no files on disk.
- Known gaps: The read failure is faked with a plain error message.
- Evidence: UNVERIFIED

### Reading, saving and searching files

<a id="mus-spec-07-562a"></a>
#### MUS-SPEC-07-562A: A preview cut inside a character shows no false encoding warning

- Precondition: A text file made of 3-byte characters is longer than the preview limit, so the cut lands inside a character.
- Action: Read the file for a preview through the real file reader.
- Expected result: The preview is marked as cut short, shows no encoding warning and holds no replacement character at the end.
- Test: `packages/agent-app/tests/main-ipc-files.test.ts::a valid UTF-8 file cut at the preview limit is not reported as having an encoding problem`
- Environment: Node test runner; real files in a temp folder.
- Known gaps: Only the preview read is tested; the full read (used by the editor) has the same cut-off code but no test.
- Evidence: UNVERIFIED

<a id="mus-spec-07-562b"></a>
#### MUS-SPEC-07-562B: Saving a file keeps its permissions

- Precondition: A shell script in a temp folder has mode 755.
- Action: Read it, then save new text with the real file writer.
- Expected result: The save works with no conflict and the file is still mode 755.
- Test: `packages/agent-app/tests/main-ipc-files.test.ts::saving a file keeps its permissions, so a script stays executable`
- Environment: Node test runner; real files in a temp folder. Skipped on Windows, where modes do not apply.
- Known gaps: Does not run on Windows.
- Evidence: UNVERIFIED

<a id="mus-spec-07-562c"></a>
#### MUS-SPEC-07-562C: Content search lists paths relative to the folder

- Precondition: A folder holds sub/a.txt with the word needle in it, and ripgrep is installed.
- Action: Search the folder for needle.
- Expected result: The one result has the path sub/a.txt, the same path the file tree uses.
- Test: `packages/agent-app/tests/main-ipc-files.test.ts::content search returns folder-relative paths whether or not ripgrep is installed`
- Environment: Node test runner; real files in a temp folder; ripgrep on the PATH (the test is skipped without it).
- Known gaps: Only runs when ripgrep is installed; the built-in search is not covered by this test.
- Evidence: UNVERIFIED

<a id="mus-spec-07-562d"></a>
#### MUS-SPEC-07-562D: A folder at a drive root still resolves paths inside it

- Precondition: A folder is registered at the filesystem root, such as / or D:\.
- Action: Resolve the path usr inside that folder.
- Expected result: The path resolves to the root joined with usr. It is not refused as escaping the folder.
- Test: `packages/agent-app/tests/main-ipc-files.test.ts::a folder registered at a filesystem root still resolves paths inside it`
- Environment: Node test runner; reads the real filesystem root, no files are written.
- Known gaps: Calls the path resolver, not a list, read or search through the app.
- Evidence: UNVERIFIED

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

<a id="mus-spec-07-572a"></a>
#### MUS-SPEC-07-572A: Search words named like object keys are plain text

- Precondition: No setup.
- Action: Parse the search text constructor:foo, toString:foo, __proto__:foo, hasOwnProperty:foo, valueOf:foo and the in: form of each.
- Expected result: Each stays in the all scope with its text unchanged.
- Test: `packages/agent-app/tests/protocol-bughunt.test.ts::search scope prefixes named after Object.prototype keys are plain words`
- Environment: Node test runner; no network.
- Known gaps: Tests the query parser. It does not type into the search box.
- Evidence: UNVERIFIED

### Content search and in-file find

<a id="mus-spec-07-33a"></a>
#### MUS-SPEC-07-33A: Ripgrep content search returns path, line and text for each hit

- Precondition: A folder with three text files holding "Needle", "needle", "NEEDLE" and a literal "ne+dle", and ripgrep installed.
- Action: Search for "needle" (case ignored), then with Match case on, then "ne+dle" as plain text and as a regular expression, then a search scoped to a sub-folder.
- Expected result: Each hit has its file, line number and line text. Match case keeps only the exact capitalisation. A plain search treats + as text; a regular expression treats it as a repeat. A search with no hit returns an empty, complete result. A sub-folder search reports paths relative to that sub-folder.
- Test: `packages/agent-app/tests/content-search-ripgrep.test.ts::ripgrep content search returns path, line and text, honouring case and literal or regex modes`
- Environment: Node test runner with real files in a temp folder and the real `rg` binary. The test is skipped, and says so, on a machine without ripgrep.
- Known gaps: Ripgrep reports paths as `./src/a.txt`; the test strips the leading `./` before comparing. Whether the UI shows that prefix is not checked here.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33b"></a>
#### MUS-SPEC-07-33B: Ripgrep content search stops at 500 matches and says so

- Precondition: A folder whose files hold 900 matching lines, and another with one 900-character matching line, and ripgrep installed.
- Action: Search each folder.
- Expected result: The first returns exactly 500 matches and is marked partial. The second returns one match clipped to 500 characters and is not marked partial.
- Test: `packages/agent-app/tests/content-search-ripgrep.test.ts::ripgrep content search stops at 500 matches, reports truncation and clips long lines`
- Environment: Node test runner with real files in a temp folder and the real `rg` binary; skipped on a machine without ripgrep.
- Known gaps: The 5-second time limit is not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33c"></a>
#### MUS-SPEC-07-33C: Cancelling a ripgrep search ends it early

- Precondition: A folder of 3000 files, 300 of them matching, and ripgrep installed.
- Action: Run a search with a request id and cancel that id while it runs, then cancel the finished id, then search again with the same id.
- Expected result: The cancelled search ends early with fewer than 300 matches and is marked partial. Cancelling an id that is over does nothing. The same id then returns all 300 matches, not partial.
- Test: `packages/agent-app/tests/content-search-ripgrep.test.ts::cancelling a ripgrep content search ends it early as truncated and frees the request id`
- Environment: Node test runner with real files in a temp folder and the real `rg` binary; skipped on a machine without ripgrep.
- Known gaps: The test cancels on every event-loop turn because the request registers itself at a moment the test cannot see. It shows that a cancel ends the search, not that one landing at an exact instant does.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33d"></a>
#### MUS-SPEC-07-33D: Content search works without ripgrep

- Precondition: The same three text files as case A, and no `rg` on the PATH.
- Action: Run the same searches as case A (Match case on a regular expression search), plus a regular expression that is not valid.
- Expected result: The hits match case A, with paths such as `src/a.txt`. An invalid regular expression is refused with "Invalid regular expression.".
- Test: `packages/agent-app/tests/content-search-fallback.test.ts::content search without ripgrep walks the folder for matches, case modes and regular expressions`
- Environment: Node test runner with real files in a temp folder; the test empties PATH so ripgrep cannot be found.
- Known gaps: Match case on a plain (non-regular-expression) search is not asserted: the walk ignores it today, which is reported as its own issue. Does not run the two engines on one folder to compare them; each has its own cases.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33e"></a>
#### MUS-SPEC-07-33E: Content search skips build folders and binaries and stays inside the folder

- Precondition: A folder with matching text in node_modules, .git, dist, build, a binary file, a link to a folder outside, and one ordinary file; no `rg` on the PATH.
- Action: Search for the text, then search with a path that leaves the folder, an empty query and a 513-character query.
- Expected result: Only the ordinary file is found. The escaping path is refused, and both bad queries are refused with "Enter a search of 1–512 characters.".
- Test: `packages/agent-app/tests/content-search-fallback.test.ts::content search skips build folders and binary files, and stays inside the folder`
- Environment: Node test runner with real files in a temp folder; no ripgrep.
- Known gaps: Ripgrep's own skipping (it applies its default ignore rules) is not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33f"></a>
#### MUS-SPEC-07-33F: Content search without ripgrep stops at 500 matches and says so

- Precondition: The same two folders as case B; no `rg` on the PATH.
- Action: Search each folder.
- Expected result: The first returns exactly 500 matches and is marked partial. The second returns one match clipped to 500 characters and is not marked partial.
- Test: `packages/agent-app/tests/content-search-fallback.test.ts::content search without ripgrep stops at 500 matches, reports truncation and clips long lines`
- Environment: Node test runner with real files in a temp folder; no ripgrep.
- Known gaps: The 5-second limit and the 20,000-file limit are not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33g"></a>
#### MUS-SPEC-07-33G: Cancelling a search without ripgrep stops the walk early

- Precondition: A folder of 200 sub-folders, each holding one matching file; no `rg` on the PATH.
- Action: Run a search with a request id and cancel that id while it runs, then search again with the same id.
- Expected result: The cancelled search ends early with fewer than 200 matches and is marked partial. The same id then returns all 200 matches, not partial.
- Test: `packages/agent-app/tests/content-search-fallback.test.ts::cancelling a content search without ripgrep stops the walk early as truncated and frees the request id`
- Environment: Node test runner with real files in a temp folder; no ripgrep.
- Known gaps: Same as case C: the cancel is sent on every event-loop turn.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33h"></a>
#### MUS-SPEC-07-33H: Cmd+F opens Find and shows the match count

- Precondition: A source file tab is open and holds "beta" three times, in three capitalisations.
- Action: Press Cmd+F, type "beta", then type text that is not in the file.
- Expected result: The Find bar opens and the browser's own find does not. "beta" shows 1/3 with all three marked and the first current. Text that is not there shows 0/0, and Next and Previous are disabled.
- Test: `packages/agent-app/tests/file-find-dom.tsx::Cmd+F opens Find in the open file and typing shows the match count with every match marked`
- Environment: DOM suite (linkedom) with a stubbed bridge; no file system.
- Known gaps: Typing is done by calling the input's React change handler, because linkedom does not deliver input events. Scrolling to the current match is not checked.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33i"></a>
#### MUS-SPEC-07-33I: Next, Previous and Enter step through matches

- Precondition: Find is open on the file from case H with "beta" typed (1/3).
- Action: Click Next three times, click Previous, press Enter and Shift+Enter, switch Wrap around off and click Next, then edit the search.
- Expected result: The count steps 2/3, 3/3, then wraps to 1/3. Previous from the first goes to 3/3. Enter is Next and Shift+Enter is Previous. With wrap off, Next stays on the last match. Editing the search returns to the first match.
- Test: `packages/agent-app/tests/file-find-dom.tsx::Next, Previous and Enter step through the matches and wrap around, and Wrap around off stops at the ends`
- Environment: DOM suite (linkedom) with a stubbed bridge.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-07-33j"></a>
#### MUS-SPEC-07-33J: Escape and Close find close the bar

- Precondition: Find is open on the file from case H with "beta" typed.
- Action: Press Escape, press Ctrl+F, then click Close find.
- Expected result: Escape closes the bar and the file shows as highlighted source again. Ctrl+F opens it with "beta" still in the box. Close find closes it again.
- Test: `packages/agent-app/tests/file-find-dom.tsx::Escape and Close find close the Find bar and show the file as source again`
- Environment: DOM suite (linkedom) with a stubbed bridge.
- Known gaps: None known.
- Evidence: UNVERIFIED
