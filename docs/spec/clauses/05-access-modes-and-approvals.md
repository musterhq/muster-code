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
| [MUS-SPEC-05-573A](05-access-modes-and-approvals.md#mus-spec-05-573a) | A rule with many stars rejects a long command quickly and still matches as before. | [`a tool-rule glob with many stars matches in linear-ish time against a long command`](../../../packages/agent-app/tests/governance-bughunt.test.ts) |

<a id="mus-spec-05-573a"></a>
#### MUS-SPEC-05-573A: A tool-rule pattern with many stars finishes fast

- Precondition: A tool rule with twelve stars and a 400-character command that cannot match.
- Action: Match the command against the rule.
- Expected result: The answer is no, in under 500 ms. Rules are still anchored and ignore case, ? matches one character, and dots and brackets are plain.
- Test: `packages/agent-app/tests/governance-bughunt.test.ts::a tool-rule glob with many stars matches in linear-ish time against a long command`
- Environment: Node test runner; no network.
- Known gaps: Tests the matcher. It does not run a tool call through the approval flow. The time limit may need care on a very slow machine. On main this test never finishes.
- Evidence: UNVERIFIED
