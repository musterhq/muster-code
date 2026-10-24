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
