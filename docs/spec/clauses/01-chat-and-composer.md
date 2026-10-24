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
