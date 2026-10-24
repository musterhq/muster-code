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
| [MUS-SPEC-05-347A](05-access-modes-and-approvals.md#mus-spec-05-347a) | A folder swapped for a link after the path check and before the write makes the write fail and creates no folder outside the chat's folder. | [`a folder swapped for a link while a write waits for approval creates nothing outside`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-347B](05-access-modes-and-approvals.md#mus-spec-05-347b) | While another process keeps swapping a folder and a file name for links, repeated writes leave no file and no folder outside the chat's folder. | [`a racer swapping a folder and a link under repeated writes leaves nothing outside`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-347C](05-access-modes-and-approvals.md#mus-spec-05-347c) | A policyOnly flag inside the parameters of an approval request does not skip the approval card. | [`a policyOnly flag inside request parameters does not skip the approval card`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-347D](05-access-modes-and-approvals.md#mus-spec-05-347d) | An HTTP route's file change asks for approval with policyOnly as a separate argument, not inside the parameters. | [`the HTTP tools pass policyOnly as a separate authorize argument`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-473F](05-access-modes-and-approvals.md#mus-spec-05-473f) | A mid-turn start by the agent is allowed only in Agent mode with Full access; a user start still waits for the turn. | [`commandAuthority: the agent may start mid-turn, but only in Agent mode with Full access`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-05-473G](05-access-modes-and-approvals.md#mus-spec-05-473g) | The muster_background server and its instruction are added only for Agent mode with Full access. | [`the muster_background server is offered only in Agent mode with Full access, with its instruction`](../../../packages/agent-app/tests/process-continuations.test.ts) |

### Confined writes and policy-only requests

<a id="mus-spec-05-347a"></a>
#### MUS-SPEC-05-347A: A swapped folder cannot make a write create folders outside

- Precondition: A Workspace-access chat on an HTTP route. The chat's folder holds a real folder `d`. A folder `outside` lies beside it. While the file change waits for approval, `d` is replaced by a link to `outside`.
- Action: The model writes `d/sub/x.txt`.
- Expected result: The write fails. `outside` still has nothing in it: no `sub` folder and no file.
- Test: `packages/agent-app/tests/write-confined-347.test.ts::a folder swapped for a link while a write waits for approval creates nothing outside`
- Environment: Node test runner, temp folders, a file system that allows links.
- Known gaps: The swap is made while approval waits, which is the real window between the path check and the write. A swap in the few microseconds between two checks inside the write is only sampled by case 347B.
- Evidence: UNVERIFIED

<a id="mus-spec-05-347b"></a>
#### MUS-SPEC-05-347B: A racing process cannot push a write outside the folder

- Precondition: A Workspace-access chat on an HTTP route. A second process keeps swapping the folder `d` between a real folder and a link to `outside`, and the name `top.txt` between a file and a link to a file in `outside`.
- Action: The model writes `d/x.txt`, `d/sub/y.txt` and `top.txt` many times.
- Expected result: When the race ends, `outside` holds no new file and no new folder, and its existing file is unchanged.
- Test: `packages/agent-app/tests/write-confined-347.test.ts::a racer swapping a folder and a link under repeated writes leaves nothing outside`
- Environment: Node test runner, a second node process, temp folders, a file system that allows links.
- Known gaps: A race test is a sample, not a proof. It does not show which check stopped each attempt.
- Evidence: UNVERIFIED

<a id="mus-spec-05-347c"></a>
#### MUS-SPEC-05-347C: A policyOnly flag in the parameters is not trusted

- Precondition: A chat in Workspace access with no tool rules. The provider asks for approval of a file change and its parameters carry `policyOnly: true`, the way the Codex app-server path forwards parameters.
- Action: Send a message and let the provider make that request.
- Expected result: An approval card is raised, and the provider is not told to go ahead until the user answers.
- Test: `packages/agent-app/tests/write-confined-347.test.ts::a policyOnly flag inside request parameters does not skip the approval card`
- Environment: Node test runner, agent service with a fake provider.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-05-347d"></a>
#### MUS-SPEC-05-347D: The HTTP route asks with policyOnly as its own argument

- Precondition: An HTTP route tool context in Workspace access with an `authorize` function that records what it is given.
- Action: The model writes a file.
- Expected result: `authorize` is called with the file change, parameters that have no `policyOnly` key, and a third argument `{policyOnly: true}`; the file is written.
- Test: `packages/agent-app/tests/write-confined-347.test.ts::the HTTP tools pass policyOnly as a separate authorize argument`
- Environment: Node test runner, temp folder.
- Known gaps: None known.
- Evidence: UNVERIFIED

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
