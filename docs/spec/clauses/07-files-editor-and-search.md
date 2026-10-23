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
| [MUS-SPEC-07-559A](07-files-editor-and-search.md#mus-spec-07-559a) | A file read with an encoding warning shows a message, with no text box and no Save button. | [`a file that is not valid UTF-8 is not offered for editing`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559B](07-files-editor-and-search.md#mus-spec-07-559b) | A file read as cut short shows a message, with no text box. | [`a file larger than the full-read limit is not offered for editing`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559C](07-files-editor-and-search.md#mus-spec-07-559c) | Text typed during a save is still in the box afterwards, and the editor still says Unsaved changes. | [`text typed while a save is in flight is kept`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |
| [MUS-SPEC-07-559D](07-files-editor-and-search.md#mus-spec-07-559d) | When re-reading the file fails, the conflict banner stays, the error is shown and nothing is thrown unhandled. | [`a failed Discard and reload keeps the conflict banner and shows the error`](../../../packages/agent-app/tests/file-editor-safety-dom.tsx) |

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

