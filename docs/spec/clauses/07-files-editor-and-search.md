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
| [MUS-SPEC-07-276A](07-files-editor-and-search.md#mus-spec-07-276a) | After a spreadsheet refreshes while the machine is slow to paint, the first cell ends up selected; the check waits for that cell instead of a fixed time. | [`refreshed sheet selects its first available cell`](../../../packages/agent-app/tests/renderer-lifecycle.tsx) |

<a id="mus-spec-07-276a"></a>
#### MUS-SPEC-07-276A: A refreshed spreadsheet selects its first cell, however slow the paint

- Precondition: A spreadsheet preview is open with a cell selected on its second page. The machine is slow: the screen update after a refresh arrives later than a fixed 40 ms wait.
- Action: The file changes on disk, so the preview receives a new revision with a single short row.
- Expected result: Once the update lands, the preview shows page 1 and its first cell is the selected one. The check waits for that cell to appear; it does not pass or fail on a fixed delay.
- Test: `packages/agent-app/tests/renderer-lifecycle.tsx::refreshed sheet selects its first available cell`
- Environment: linkedom DOM suite run by `scripts/test-renderer.mjs`.
- Known gaps: A slow machine is simulated by making the refreshed rows costly to read. Real runner load is not reproduced.
- Evidence: UNVERIFIED
