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
| [MUS-SPEC-07-276A](07-files-editor-and-search.md#mus-spec-07-276a) | After a spreadsheet refreshes while the machine is slow to paint, the first cell ends up selected; the check waits for that cell instead of a fixed time. | [`refreshed sheet selects its first available cell`](../../../packages/agent-app/tests/renderer-lifecycle.tsx) |
| [MUS-SPEC-07-559A](07-files-editor-and-search.md#mus-spec-07-559a) | A file read with an encoding warning shows a message, with no text box and no Save button. | [`a file that is not valid UTF-8 is not offered for editing`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559B](07-files-editor-and-search.md#mus-spec-07-559b) | A file read as cut short shows a message, with no text box. | [`a file larger than the full-read limit is not offered for editing`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559C](07-files-editor-and-search.md#mus-spec-07-559c) | Text typed during a save is still in the box afterwards, and the editor still says Unsaved changes. | [`text typed while a save is in flight is kept`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559D](07-files-editor-and-search.md#mus-spec-07-559d) | When re-reading the file fails, the conflict banner stays, the error is shown and nothing is thrown unhandled. | [`a failed Discard and reload keeps the conflict banner and shows the error`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-562A](07-files-editor-and-search.md#mus-spec-07-562a) | A valid UTF-8 file cut at the preview limit reports truncated, no encoding warning, and no replacement character. | [`a valid UTF-8 file cut at the preview limit is not reported as having an encoding problem`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562B](07-files-editor-and-search.md#mus-spec-07-562b) | After a save, a script that was mode 755 is still 755. | [`saving a file keeps its permissions, so a script stays executable`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562C](07-files-editor-and-search.md#mus-spec-07-562c) | A search finds a match in a sub folder and lists it as sub/a.txt, with no ./ in front. | [`content search returns folder-relative paths whether or not ripgrep is installed`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562D](07-files-editor-and-search.md#mus-spec-07-562d) | Resolving usr inside the filesystem root returns the root joined with usr instead of an escape error. | [`a folder registered at a filesystem root still resolves paths inside it`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |

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
