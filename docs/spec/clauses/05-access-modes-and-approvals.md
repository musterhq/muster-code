# MUS-SPEC-05: Access modes, approvals and tool permissions

Each chat has an access mode that sets what the agent may do without asking: Read only, Workspace (edit inside the chat's folder) or Full access.

What the user can do:
- pick the access mode per chat, and choose "Don't ask again" for Full access on a folder;
- approve or decline a command, a file write outside the workspace, a secret or a hire when the agent asks;
- set permission rules that always allow or always block certain tools or commands.

Boundaries:
- Full access never prompts.
- A declined or rule-blocked command does not run, and the timeline says Did not run.
- A chat started from another chat keeps that chat's access mode.
- Running commands inside a container is clause [06](06-sandbox.md).

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-05-382A](05-access-modes-and-approvals.md#mus-spec-05-382a) | A Claude Code shell command in a Workspace chat shows an approval card, is not answered before the user decides, and Claude Code is told to go ahead once the user approves. | not written yet (#382) |
| [MUS-SPEC-05-382B](05-access-modes-and-approvals.md#mus-spec-05-382b) | A declined shell command is refused to Claude Code with a reason and the turn still completes; Full access and Read only chats do not route prompts to Muster. | not written yet (#382) |

### Claude Code shell approvals
<a id="mus-spec-05-382a"></a>
#### MUS-SPEC-05-382A: A Claude Code shell command waits for the user's approval

- Precondition: A chat on the Claude Code route with Workspace access. Claude Code asks to run a shell command that it does not allow on its own.
- Action: Send a message. Claude Code asks permission for the command. Approve the card.
- Expected result: An approval card for the command appears and Claude Code gets no answer before the user decides. After Approve, Claude Code is told to allow that command with its own input unchanged, and the turn completes.
- Test: not written yet (#382)
- Environment: Node test runner; a fake Claude Code process that speaks the stream-json permission protocol; no network.
- Known gaps: Uses the protocol as seen in Claude Code 2.1.x, not a live Claude Code run. "Approve for this session" is answered as a single approval.
- Evidence: UNVERIFIED

<a id="mus-spec-05-382b"></a>
#### MUS-SPEC-05-382B: A declined Claude Code shell command is refused

- Precondition: A chat on the Claude Code route with Workspace access. Claude Code asks to run a shell command.
- Action: Decline the approval card. Separately start a Full access chat and a Read only chat.
- Expected result: Claude Code is told to deny the command, with a message that the user declined it, and the turn still completes. Chats with Full access or Read only do not give Claude Code a permission prompt tool.
- Test: not written yet (#382)
- Environment: Node test runner; a fake Claude Code process; no network.
- Known gaps: Uses the protocol as seen in Claude Code 2.1.x, not a live Claude Code run.
- Evidence: UNVERIFIED
