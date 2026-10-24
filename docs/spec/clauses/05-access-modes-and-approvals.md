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

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-05-473F](05-access-modes-and-approvals.md#mus-spec-05-473f) | A mid-turn start by the agent is allowed only in Agent mode with Full access; a user start still waits for the turn. | [`commandAuthority: the agent may start mid-turn, but only in Agent mode with Full access`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-05-473G](05-access-modes-and-approvals.md#mus-spec-05-473g) | The muster_background server and its instruction are added only for Agent mode with Full access. | [`the muster_background server is offered only in Agent mode with Full access, with its instruction`](../../../packages/agent-app/tests/process-continuations.test.ts) |

### Background processes and access mode

<a id="mus-spec-05-473f"></a>
#### MUS-SPEC-05-473F: Only Agent mode with Full access may start a background process mid-turn

- Precondition: A running chat in Agent mode with Full access, then the same chat in Read only, Workspace and Ask mode.
- Action: Ask for permission to start a command as the user, then as the agent.
- Expected result: A user start mid-turn is refused with "Wait for the current agent attempt". The agent's start is allowed in Agent mode with Full access, and refused with a message naming Full access in Read only, Workspace and Ask.
- Test: `packages/agent-app/tests/process-continuations.test.ts::commandAuthority: the agent may start mid-turn, but only in Agent mode with Full access`
- Environment: Node test runner; temp folder; no provider or network.
- Known gaps: Calls the main-process authority check directly, not through a running chat.
- Evidence: UNVERIFIED

<a id="mus-spec-05-473g"></a>
#### MUS-SPEC-05-473G: The background tool is offered only in Agent mode with Full access

- Precondition: Chats in Agent mode with Full access, Workspace and Read only, and Ask and Plan chats in Full access.
- Action: Build the run options for each.
- Expected result: Only the Agent mode and Full access chat gets the muster_background server (with its chat ID) and its one-line instruction. All others, and a missing launcher, get nothing.
- Test: `packages/agent-app/tests/process-continuations.test.ts::the muster_background server is offered only in Agent mode with Full access, with its instruction`
- Environment: Node test runner; temp folder; no provider or network.
- Known gaps: Checks the run options, not a model using the tool.
- Evidence: UNVERIFIED
