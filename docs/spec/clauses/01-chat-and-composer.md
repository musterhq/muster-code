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
