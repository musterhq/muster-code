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
| [MUS-SPEC-07-562A](07-files-editor-and-search.md#mus-spec-07-562a) | A valid UTF-8 file cut at the preview limit reports truncated, no encoding warning, and no replacement character. | [`a valid UTF-8 file cut at the preview limit is not reported as having an encoding problem`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562B](07-files-editor-and-search.md#mus-spec-07-562b) | After a save, a script that was mode 755 is still 755. | [`saving a file keeps its permissions, so a script stays executable`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562C](07-files-editor-and-search.md#mus-spec-07-562c) | A search finds a match in a sub folder and lists it as sub/a.txt, with no ./ in front. | [`content search returns folder-relative paths whether or not ripgrep is installed`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |
| [MUS-SPEC-07-562D](07-files-editor-and-search.md#mus-spec-07-562d) | Resolving usr inside the filesystem root returns the root joined with usr instead of an escape error. | [`a folder registered at a filesystem root still resolves paths inside it`](../../../packages/agent-app/tests/main-ipc-files.test.ts) |

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

