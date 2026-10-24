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
