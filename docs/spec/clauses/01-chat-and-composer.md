# MUS-SPEC-01: Chat and composer

A chat is one conversation with an agent about one folder or worktree. The composer is where the user writes to it.

What the user can do:
- start a chat in a folder, a new worktree or a Project; name, rename, pin, archive, delete, fork and export it;
- write a message with attachments (files, images, sketches), mentions and slash commands, and pick the model, reasoning effort and access mode;
- search chats, move back and forward through them, and import conversations from other tools.

Boundaries:
- How a turn runs once sent is clause [02](02-turns-streaming-and-queue.md). Model choice is clause [03](03-providers-models-and-accounts.md). Access modes are clause [05](05-access-modes-and-approvals.md).
- The composer never loses a draft: a failed send, a restart or switching chats keeps it.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-01-569A](01-chat-and-composer.md#mus-spec-01-569a) | Searching "checklist" in a message holding "İzmir" returns a highlight range that covers "checklist". | [`the index returns a correct highlight for such a message`](../../../packages/agent-app/tests/chat-search-casefold.test.ts) |
| [MUS-SPEC-01-569B](01-chat-and-composer.md#mus-spec-01-569b) | In "İİİİ İstanbul deploy notes" the one highlight covers "deploy". | [`a snippet after a dotted capital I highlights the matched word itself`](../../../packages/agent-app/tests/chat-search-casefold.test.ts) |
| [MUS-SPEC-01-569C](01-chat-and-composer.md#mus-spec-01-569c) | In a 200-"İ" message the snippet window holds "needle" and the highlight covers it. | [`a long message: the window is centred on the match, not shifted by earlier dotted capitals`](../../../packages/agent-app/tests/chat-search-casefold.test.ts) |

### Search highlights

<a id="mus-spec-01-569a"></a>
#### MUS-SPEC-01-569A: Chat search highlights the right word in a message with "İ"

- Precondition: A chat message reads "İzmir İzmir release checklist".
- Action: Search the chat index for "checklist".
- Expected result: The first hit's highlight range covers exactly "checklist".
- Test: `packages/agent-app/tests/chat-search-casefold.test.ts::the index returns a correct highlight for such a message`
- Environment: Node test runner; no network, no provider.
- Known gaps: Checks the range from the index, not the highlight drawn in the search panel.
- Evidence: UNVERIFIED

<a id="mus-spec-01-569b"></a>
#### MUS-SPEC-01-569B: A snippet after "İİİİ" highlights the matched word

- Precondition: Text that starts with several dotted capital I letters.
- Action: Build the search snippet for "deploy".
- Expected result: There is one highlight range and it covers exactly "deploy".
- Test: `packages/agent-app/tests/chat-search-casefold.test.ts::a snippet after a dotted capital I highlights the matched word itself`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the snippet builder directly.
- Evidence: UNVERIFIED

<a id="mus-spec-01-569c"></a>
#### MUS-SPEC-01-569C: A long message with many "İ" shows the match in its snippet

- Precondition: A message with 200 "İ" characters, filler, then "needle here".
- Action: Build the search snippet for "needle".
- Expected result: One highlight range, covering exactly "needle".
- Test: `packages/agent-app/tests/chat-search-casefold.test.ts::a long message: the window is centred on the match, not shifted by earlier dotted capitals`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the snippet builder directly.
- Evidence: UNVERIFIED
