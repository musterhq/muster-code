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
| [MUS-SPEC-01-555A](01-chat-and-composer.md#mus-spec-01-555a) | After a send finishes, the chip that was sent is gone from the composer, and a chip added while the send was in flight is still there. | [`a context chip added while a send is in flight is kept, and only the sent chip is cleared`](../../../packages/agent-app/tests/composer-inflight-chips-dom.tsx) |

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
