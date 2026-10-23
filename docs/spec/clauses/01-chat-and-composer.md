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
| [MUS-SPEC-01-670A](01-chat-and-composer.md#mus-spec-01-670a) | Clicking Clone a repository on the folder step closes the guide for the clone sheet and starts no interval timer. | [`cloning from the setup guide hands back through the clone sheet and leaves no background poll`](../../../packages/agent-app/tests/setup-clone-handoff-dom.tsx) |
| [MUS-SPEC-01-670B](01-chat-and-composer.md#mus-spec-01-670b) | After the clone sheet is closed without a clone, a folder that arrives in a later snapshot leaves the setup guide closed after more than a second. | [`a folder added later does not reopen the setup guide after an abandoned clone`](../../../packages/agent-app/tests/setup-clone-handoff-dom.tsx) |

### Cloning from the setup guide (#670)

<a id="mus-spec-01-670a"></a>
#### MUS-SPEC-01-670A: Cloning from the setup guide leaves no background timer

- Precondition: The setup guide is open on the folder step, with git available and no folder added yet.
- Action: Click "Clone a repository…".
- Expected result: The guide closes to make room for the clone sheet, and no interval timer is started, so nothing keeps watching for new folders in the background.
- Test: `packages/agent-app/tests/setup-clone-handoff-dom.tsx::cloning from the setup guide hands back through the clone sheet and leaves no background poll`
- Environment: DOM suite on linkedom, built and run by scripts/test-renderer.mjs; the runtime is a fake; no network or git.
- Known gaps: Does not run a clone to the end, so it does not show the guide reopening on the folder step when the clone lands or the new "setup continues once it lands" hint. It counts calls to setInterval during the click, so a timer made another way is not seen.
- Evidence: UNVERIFIED

<a id="mus-spec-01-670b"></a>
#### MUS-SPEC-01-670B: A folder added later does not reopen the setup guide

- Precondition: The user clicked "Clone a repository…" from the setup guide, so the guide is closed, and then closed the clone sheet without cloning.
- Action: A new folder arrives in an app snapshot (added another way), and the test waits 1.3 seconds.
- Expected result: The setup guide is still closed.
- Test: `packages/agent-app/tests/setup-clone-handoff-dom.tsx::a folder added later does not reopen the setup guide after an abandoned clone`
- Environment: DOM suite on linkedom, built and run by scripts/test-renderer.mjs; the runtime is a fake; no network or git.
- Known gaps: The 1.3 second wait covers the old one-second poll but not its 10-minute limit. It does not show a finished clone reopening the guide.
- Evidence: UNVERIFIED
