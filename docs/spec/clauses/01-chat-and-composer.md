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
| [MUS-SPEC-01-560A](01-chat-and-composer.md#mus-spec-01-560a) | Enter pressed to confirm an IME composition (or the key that follows it) leaves the search palette open and screen unchanged; a plain Enter opens the row. | [`Enter that confirms an IME composition does not open the highlighted search row`](../../../packages/agent-app/tests/ime-enter-dom.tsx) |
| [MUS-SPEC-01-560B](01-chat-and-composer.md#mus-spec-01-560b) | Search highlight ranges cover a whole emoji, merge adjacent emoji, and never split a surrogate pair. | [`fuzzyMatch ranges never cut an emoji in half`](../../../packages/agent-app/tests/spotlight-model.test.ts) |

### Typing with an IME and emoji

<a id="mus-spec-01-560a"></a>
#### MUS-SPEC-01-560A: Enter that confirms an IME composition does not run the search row

- Precondition: The search palette is open with the query "OSS-12", so one row is highlighted.
- Action: Press Enter flagged as part of a composition; then Enter with key code 229 (the key event some browsers send right after the composition ends); then a plain Enter.
- Expected result: The first two keys do nothing: the screen stays the same and the palette stays open. The plain Enter opens the row.
- Test: `packages/agent-app/tests/ime-enter-dom.tsx::Enter that confirms an IME composition does not open the highlighted search row`
- Environment: Real SpotlightSearchHost in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Only the search palette is driven. The same helper is applied to quick open, chat and folder rename, the branch picker, the owner picker and the add-resource menu, and those have no test here. Real IME input is not tested; the events are made by hand.
- Evidence: UNVERIFIED

<a id="mus-spec-01-560b"></a>
#### MUS-SPEC-01-560B: Search highlights keep an emoji whole

- Precondition: The search text is an emoji, or two emoji in a row, and the result text has them inside other letters.
- Action: Match the text and split the result into highlighted and plain parts.
- Expected result: The highlight covers the whole emoji (both halves of its surrogate pair). Adjacent emoji form one span. Every part is well-formed text.
- Test: `packages/agent-app/tests/spotlight-model.test.ts::fuzzyMatch ranges never cut an emoji in half`
- Environment: Node test runner; no UI and no network.
- Known gaps: Unit test of the matcher and the splitter, not the rendered highlight in the palette.
- Evidence: UNVERIFIED
