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
| [MUS-SPEC-01-554A](01-chat-and-composer.md#mus-spec-01-554a) | The message box has `dir="auto"`, so it follows the direction of what is typed (the draft here is Arabic). | [`the message field follows the direction of what is typed`](../../../packages/agent-app/tests/composer-rtl-dom.tsx) |
| [MUS-SPEC-01-554B](01-chat-and-composer.md#mus-spec-01-554b) | Every chat title in the sidebar has `dir="auto"`, including an Arabic title. | [`sidebar chat titles follow their own text direction`](../../../packages/agent-app/tests/composer-rtl-dom.tsx) |
| [MUS-SPEC-01-554C](01-chat-and-composer.md#mus-spec-01-554c) | Each of your messages in the transcript has `dir="auto"`, for an Arabic message and an English one. | [`each user message takes its text direction from its own first strong character`](../../../packages/agent-app/tests/chat-rtl-dom.tsx) |
| [MUS-SPEC-01-554D](01-chat-and-composer.md#mus-spec-01-554d) | In an Arabic reply, the paragraph, the list and each list item have `dir="auto"`. | [`paragraphs and list items in a reply take their own text direction`](../../../packages/agent-app/tests/chat-rtl-dom.tsx) |
| [MUS-SPEC-01-555A](01-chat-and-composer.md#mus-spec-01-555a) | After a send finishes, the chip that was sent is gone from the composer, and a chip added while the send was in flight is still there. | [`a context chip added while a send is in flight is kept, and only the sent chip is cleared`](../../../packages/agent-app/tests/composer-inflight-chips-dom.tsx) |
| [MUS-SPEC-01-560A](01-chat-and-composer.md#mus-spec-01-560a) | Enter pressed to confirm an IME composition (or the key that follows it) leaves the search palette open and screen unchanged; a plain Enter opens the row. | [`Enter that confirms an IME composition does not open the highlighted search row`](../../../packages/agent-app/tests/ime-enter-dom.tsx) |
| [MUS-SPEC-01-560B](01-chat-and-composer.md#mus-spec-01-560b) | Search highlight ranges cover a whole emoji, merge adjacent emoji, and never split a surrogate pair. | [`fuzzyMatch ranges never cut an emoji in half`](../../../packages/agent-app/tests/spotlight-model.test.ts) |

### Text direction

<a id="mus-spec-01-554a"></a>
#### MUS-SPEC-01-554A: The message box follows the direction of what is typed

- Precondition: A chat is open and its draft is Arabic text.
- Action: Render the composer.
- Expected result: The message box has `dir="auto"`, so Arabic text lines up on the right and English text on the left.
- Test: `packages/agent-app/tests/composer-rtl-dom.tsx::the message field follows the direction of what is typed`
- Environment: Real Composer and Sidebar in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Checks the `dir` attribute only. Real text layout and the caret are decided by the browser and are not tested.
- Evidence: UNVERIFIED

<a id="mus-spec-01-554b"></a>
#### MUS-SPEC-01-554B: Chat titles in the sidebar follow their own direction

- Precondition: The sidebar lists a chat called "مراجعة الملف" and a chat with an English title.
- Action: Render the sidebar.
- Expected result: Every chat title in the list has `dir="auto"`.
- Test: `packages/agent-app/tests/composer-rtl-dom.tsx::sidebar chat titles follow their own text direction`
- Environment: Real Composer and Sidebar in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: Checks the `dir` attribute only, not how the browser lays the title out.
- Evidence: UNVERIFIED

<a id="mus-spec-01-554c"></a>
#### MUS-SPEC-01-554C: Each message in the transcript follows its own direction

- Precondition: The transcript holds an Arabic user message and an English user message.
- Action: Render the transcript.
- Expected result: Both user messages have `dir="auto"`. Each one decides its direction from its own first strong character, not from the app language.
- Test: `packages/agent-app/tests/chat-rtl-dom.tsx::each user message takes its text direction from its own first strong character`
- Environment: Real transcript component in a DOM suite (linkedom); no network.
- Known gaps: Checks the `dir` attribute only. Does not cover the Markdown body of a reply (see MUS-SPEC-01-554D).
- Evidence: UNVERIFIED

<a id="mus-spec-01-554d"></a>
#### MUS-SPEC-01-554D: Paragraphs and lists in a reply follow their own direction

- Precondition: The transcript holds an Arabic reply with a paragraph and a two-item bullet list.
- Action: Render the transcript.
- Expected result: The paragraph, the list and each list item have `dir="auto"`, so the bullet markers switch sides with the text.
- Test: `packages/agent-app/tests/chat-rtl-dom.tsx::paragraphs and list items in a reply take their own text direction`
- Environment: Real transcript component in a DOM suite (linkedom); no network.
- Known gaps: Checks the `dir` attribute on the first paragraph, list and item only. Code blocks and tables are not covered.
- Evidence: UNVERIFIED

### Context chips and sending

<a id="mus-spec-01-555a"></a>
#### MUS-SPEC-01-555A: Context added while a message is sending is kept

- Precondition: A context chip ("sent-chip") is on the composer and the draft has text. The user presses send, and the send has not finished yet.
- Action: Add a second context chip ("late-chip") while the send is in flight, then let the send finish.
- Expected result: The composer's context area no longer shows "sent-chip", and still shows "late-chip" for the next message. Before the change, both were cleared.
- Test: `packages/agent-app/tests/composer-inflight-chips-dom.tsx::a context chip added while a send is in flight is kept, and only the sent chip is cleared`
- Environment: Real Composer in a DOM suite (linkedom); fake app bridge with a send that waits until released; no network.
- Known gaps: Uses the app bridge fake, not a running agent. It covers a selection chip only; the in-text mention chips use the same fix but are not tested.
- Evidence: UNVERIFIED

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
