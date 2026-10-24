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

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-01-95A](01-chat-and-composer.md#mus-spec-01-95a) | An imported Codex chat and an imported Claude Code chat each record the model and provider their own session ran, in the import note. | [`an imported chat records the model and provider its own session ran`](../../../packages/agent-app/tests/conversation-import.test.ts) |
| [MUS-SPEC-01-95B](01-chat-and-composer.md#mus-spec-01-95b) | The imported-chat note shows the session model and provider as plain text, with no control to change them. | [`the imported chat note shows the session model and provider read-only`](../../../packages/agent-app/tests/import-origin-dom.tsx) |

### Imported chats keep their own model
<a id="mus-spec-01-95a"></a>
#### MUS-SPEC-01-95A: An imported chat records the model and provider its session ran

- Precondition: A Codex rollout whose session ran `gpt-6-codex` on provider `openai`, and a Claude Code transcript whose assistant turns ran `claude-fable-5-1`. The app's default model is a different one.
- Action: Import both sessions.
- Expected result: Each chat's import note holds the session's own model and provider (`gpt-6-codex` on `openai`, `claude-fable-5-1` on `anthropic`), not the app default.
- Test: `packages/agent-app/tests/conversation-import.test.ts::an imported chat records the model and provider its own session ran`
- Environment: Node test runner; the agent service with a fake provider; fixture sessions in a temp folder.
- Known gaps: ChatGPT export sessions are not covered (the export names no model). The chat's own model field stays a model Muster can run, so the next message runs on that, not on the imported model.
- Evidence: UNVERIFIED

<a id="mus-spec-01-95b"></a>
#### MUS-SPEC-01-95B: The imported-chat note shows the session model read-only

- Precondition: An imported chat whose import note holds the model `gpt-6-codex` and the provider `openai`.
- Action: Open the chat, and look at the note at the top.
- Expected result: The note names the model and the provider as plain text. It has no button, input or menu for either. A note with no model records shows no model text.
- Test: `packages/agent-app/tests/import-origin-dom.tsx::the imported chat note shows the session model and provider read-only`
- Environment: DOM suite in linkedom; the real ImportOrigin component.
- Known gaps: Does not render the whole chat screen.
- Evidence: UNVERIFIED
