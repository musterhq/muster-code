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
| [MUS-SPEC-07-572A](07-files-editor-and-search.md#mus-spec-07-572a) | Search prefixes named like object keys stay plain words in the all scope. | [`search scope prefixes named after Object.prototype keys are plain words`](../../../packages/agent-app/tests/protocol-bughunt.test.ts) |

<a id="mus-spec-07-572a"></a>
#### MUS-SPEC-07-572A: Search words named like object keys are plain text

- Precondition: No setup.
- Action: Parse the search text constructor:foo, toString:foo, __proto__:foo, hasOwnProperty:foo, valueOf:foo and the in: form of each.
- Expected result: Each stays in the all scope with its text unchanged.
- Test: `packages/agent-app/tests/protocol-bughunt.test.ts::search scope prefixes named after Object.prototype keys are plain words`
- Environment: Node test runner; no network.
- Known gaps: Tests the query parser. It does not type into the search box.
- Evidence: UNVERIFIED
