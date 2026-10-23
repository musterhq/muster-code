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
| [MUS-SPEC-05-459A](05-access-modes-and-approvals.md#mus-spec-05-459a) | The no-asking rule is in the instructions for Agent mode with Full access only, and in no other mode or access level. | [`Full access adds the no-asking rule to agent instructions only`](../../../packages/agent-app/tests/agent-autonomy.test.ts) |
| [MUS-SPEC-05-459B](05-access-modes-and-approvals.md#mus-spec-05-459b) | A Full access run on an HTTP route receives the no-asking rule, a Workspace run does not, and the tool note asks only before irreversibly deleting user data. | [`an API-key route in Full access gets the no-asking rule and a tool note that asks only before deleting user data`](../../../packages/agent-app/tests/agent-autonomy.test.ts) |

### Full access and asking

<a id="mus-spec-05-459a"></a>
#### MUS-SPEC-05-459A: Full access never ends an agent turn asking permission to proceed

- Precondition: Agent mode chats with each access mode (Full access, Workspace, Read only, and none set), and Ask and Plan chats in Full access.
- Action: Build the run instructions for each of them.
- Expected result: Only an Agent mode chat in Full access gets the rule that says never to ask permission or confirmation to proceed (no "should I push?"). Workspace, Read only, no mode, Ask and Plan do not get it.
- Test: `packages/agent-app/tests/agent-autonomy.test.ts::Full access adds the no-asking rule to agent instructions only`
- Environment: Node test runner; no provider or network.
- Known gaps: Builds the instructions directly. It does not show a model obeying them, or the provider route that sends them.
- Evidence: UNVERIFIED

<a id="mus-spec-05-459b"></a>
#### MUS-SPEC-05-459B: API-key routes in Full access get the same rule and a softer tool note

- Precondition: A chat on an API-key route (an HTTP provider), in Agent mode, once with Full access and once with Workspace.
- Action: Run a turn on each through the real provider adapter and read the instructions the route receives. Read the tool note for Full access.
- Expected result: The Full access run receives the no-asking rule; the Workspace run does not. The tool note says not to ask permission to proceed (commit, push, install, restart) and to ask only before irreversibly deleting user data. It no longer lists force-pushing or system settings.
- Test: `packages/agent-app/tests/agent-autonomy.test.ts::an API-key route in Full access gets the no-asking rule and a tool note that asks only before deleting user data`
- Environment: Node test runner; a stub HTTP adapter behind the real provider adapter; no network.
- Known gaps: The stub adapter records its input; no real model is called. Codex and CLI routes share the same instruction builder and are covered by MUS-SPEC-05-459A.
- Evidence: UNVERIFIED
