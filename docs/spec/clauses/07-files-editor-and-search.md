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

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
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
