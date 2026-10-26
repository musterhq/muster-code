# MUS-SPEC-06: Sandbox and scoped computers

A sandbox runs a chat's or a Project's commands and services inside a container instead of directly on the user's computer. A scoped computer gives the agent controlled use of an app window.

What the user can do:
- turn on a sandbox for a chat or a Project and set its memory, CPU and disk limits;
- see the sandbox's state, its files and services, and apply its changes back to the real folder;
- let the agent use a chosen app window, and take it back at any time.

Boundaries:
- A sandbox never goes past its memory or disk limit; a write or command that would is refused or stopped with a notice.
- Deleting a chat removes its sandbox; archiving stops it and keeps its files. A Project's shared sandbox keeps running while any chat still uses it.
- When no container engine is available, Muster says so instead of running outside the sandbox.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-06-665A](06-sandbox.md#mus-spec-06-665a) | The route check says which providers can be sandboxed: Codex, Claude Code, OpenCode and Grok yes; HTTP chat, Anthropic, Gemini CLI and Cursor CLI no; an unknown provider is not refused. | [`#652 route gating: only routes that load the sandbox tools can be sandboxed`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665B](06-sandbox.md#mus-spec-06-665b) | The sandbox domain rejects "sandbox" for a Gemini CLI chat with the unsupported-route message and changes nothing, then accepts it for a Claude Code chat. | [`#652 the runtime refuses to sandbox a chat whose model cannot load the sandbox tools`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665C](06-sandbox.md#mus-spec-06-665c) | Leaving the sandbox sets exactly the chosen access level; Full without its acknowledgement is rejected, and Full with the sandbox kept on is rejected. | [`#653 leaving the sandbox to raise access sets the chosen level, and Full still needs its acknowledgement`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665D](06-sandbox.md#mus-spec-06-665d) | The sandbox note keeps its sandbox_exec wording only on routes that have it, and the other routes are sent the "no sandbox tools" note with read-only access. | [`#652 the sandbox note names sandbox_exec only on routes that have it, and claims no host access it lacks`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665E](06-sandbox.md#mus-spec-06-665e) | The access policy for a Full chat is read-only (mode and sandbox level) when the run carries sandbox settings, and stays Full on a host chat. | [`#653 a sandboxed run is read-only on the host whatever the chat says`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665F](06-sandbox.md#mus-spec-06-665f) | The arguments Codex is started with: full access for the host run; read-only, approval never, no network and shell features off for the sandbox run. | [`#653 Codex: a sandboxed chat raised to Full still launches read-only with its shell tools off`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665G](06-sandbox.md#mus-spec-06-665g) | The Claude Code arguments for a sandboxed run: the disallowed tools list, plan mode, and the allowed sandbox tools; and that a host run has none of these. | [`#653 Claude Code: a sandboxed run denies its host shell and edit tools and stays in plan mode`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665H](06-sandbox.md#mus-spec-06-665h) | The OpenCode settings and launch arguments for a sandboxed run: bash, edit, write and patch off and denied; the plan agent; the user config and sandbox server kept. | [`#653 OpenCode: a sandboxed run uses the plan agent with bash and edits removed and denied`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665I](06-sandbox.md#mus-spec-06-665i) | The Grok launch arguments and permission choice: no auto-approve in a sandbox; host commands and edits rejected; sandbox tools and reads allowed. | [`#653 Grok: a sandboxed run never auto-approves and rejects host commands and edits`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665J](06-sandbox.md#mus-spec-06-665j) | The permission mode and instructions each of the three routes receives for a sandboxed chat. | [`#653 HTTP, Gemini and Cursor routes run a sandboxed chat read-only and are told plainly they have no sandbox tools`](../../../packages/agent-app/tests/sandbox-honesty.test.ts) |
| [MUS-SPEC-06-665K](06-sandbox.md#mus-spec-06-665k) | The sheet text, the calls made after Cancel and after Leave sandbox, the access label, the footer chip text, and the Full access confirmation that follows. | [`raising access in a sandbox chat asks to leave the sandbox first, and Cancel changes nothing`](../../../packages/agent-app/tests/sandbox-honesty-dom.tsx) |
| [MUS-SPEC-06-665L](06-sandbox.md#mus-spec-06-665l) | The warning text, the warning chip, the disabled Sandbox row and its reason, that clicking sends nothing, and the "runs where" text for a model that can. | [`a sandbox chat on a model whose tools cannot use the sandbox is warned, and the Sandbox choice is disabled with the reason`](../../../packages/agent-app/tests/sandbox-honesty-dom.tsx) |

### Sandbox honesty

<a id="mus-spec-06-665a"></a>
#### MUS-SPEC-06-665A: Only models that can use the sandbox tools can be sandboxed

- Precondition: Provider routes of each kind: Codex, Claude Code, OpenCode and Grok, the plain HTTP chat and Anthropic routes, Gemini CLI and Cursor CLI, and a provider the list does not know yet.
- Action: Ask whether each route can reach the sandbox tools.
- Expected result: Codex, Claude Code, OpenCode, Grok and a route with no driver can. The HTTP chat, Anthropic, Gemini CLI and Cursor CLI routes cannot. A provider that is not in the list yet is not refused.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#652 route gating: only routes that load the sandbox tools can be sandboxed`
- Environment: Node test runner; no container engine or provider.
- Known gaps: Only the route check is run, not a chat. MUS-SPEC-06-665B shows the runtime refusing.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665b"></a>
#### MUS-SPEC-06-665B: The runtime refuses to sandbox a chat whose model has no sandbox tools

- Precondition: A chat on a Gemini CLI model, with a fake sandbox host. A second provider, Claude Code, is also listed.
- Action: Ask the sandbox domain to put the chat in a sandbox. Then switch the chat to the Claude Code model and ask again.
- Expected result: The first request is rejected with the plain "not supported" reason and nothing about the chat changes. The second request works and the chat is in the sandbox.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#652 the runtime refuses to sandbox a chat whose model cannot load the sandbox tools`
- Environment: Node test runner; the real sandbox domain handlers with an in-memory database and a fake sandbox host.
- Known gaps: The sandbox host is a fake, so no container starts. The screen side is MUS-SPEC-06-665L.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665c"></a>
#### MUS-SPEC-06-665C: Leaving the sandbox sets the access level the user chose

- Precondition: A Claude Code chat that is in the sandbox.
- Action: Ask to go back to this Mac at Full access without confirming, then ask to stay in the sandbox at Full with confirmation, then ask to go back to this Mac at Full with confirmation.
- Expected result: The first is rejected with a "Confirm unrestricted" message. The second is rejected as an invalid access policy. The third works, the chat is on this Mac, and the access level set is Full, the level asked for, not the level held before the sandbox.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 leaving the sandbox to raise access sets the chosen level, and Full still needs its acknowledgement`
- Environment: Node test runner; the real sandbox domain handlers with an in-memory database and a fake sandbox host.
- Known gaps: The "Leave the sandbox?" sheet is checked in MUS-SPEC-06-665K.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665d"></a>
#### MUS-SPEC-06-665D: The sandbox note names only tools the route really has

- Precondition: The standard sandbox note, and the routes that can and cannot use the sandbox tools.
- Action: Build the note for each route, and build what a Claude Code route and an HTTP, Gemini and Cursor route are actually sent.
- Expected result: The note names sandbox_exec and says the agent's own shell and file-editing tools are turned off, and does not claim write or full access. Routes with sandbox tools keep the note. HTTP, Gemini and Cursor routes get the "no sandbox tools" note, with no sandbox_exec or sandbox_write, and are told they have read-only access.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#652 the sandbox note names sandbox_exec only on routes that have it, and claims no host access it lacks`
- Environment: Node test runner; no provider.
- Known gaps: Checks the wording that is sent, not how a model reacts to it.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665e"></a>
#### MUS-SPEC-06-665E: A sandboxed run is read-only on the Mac at any access level

- Precondition: A chat set to Full access, and a run with the sandbox settings on it.
- Action: Work out the access policy for the run with and without the sandbox settings.
- Expected result: With the sandbox, both the permission mode and the sandbox level are read-only. Without it the chat keeps Full.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 a sandboxed run is read-only on the host whatever the chat says`
- Environment: Node test runner; no provider.
- Known gaps: Checks the policy calculation. MUS-SPEC-06-665F to 665J show each route using it.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665f"></a>
#### MUS-SPEC-06-665F: Codex: a sandboxed Full chat still starts read-only with its shell off

- Precondition: A Codex chat set to Full, with a fake Codex core. One run is a host run and one carries sandbox settings and the sandbox note.
- Action: Run both through the real provider adapter.
- Expected result: The host run starts with full access and no shell override. The sandbox run starts read-only, never asks for approval, has no network, and has the shell and unified exec features turned off.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 Codex: a sandboxed chat raised to Full still launches read-only with its shell tools off`
- Environment: Node test runner; the real provider adapter with a fake Codex core.
- Known gaps: The Codex core is a fake that records its arguments, so no real Codex starts.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665g"></a>
#### MUS-SPEC-06-665G: Claude Code: a sandboxed run denies its own shell and edit tools

- Precondition: A Claude Code chat set to Full, with the sandbox tools server configured.
- Action: Build the Claude Code command line for a sandboxed run and for a host run.
- Expected result: The sandboxed run lists Bash, Edit, Write, MultiEdit and NotebookEdit as disallowed, stays in plan mode, and keeps the sandbox tools allowed. The host run has no disallowed list and uses its own permission mode.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 Claude Code: a sandboxed run denies its host shell and edit tools and stays in plan mode`
- Environment: Node test runner; no Claude Code process.
- Known gaps: Checks the command line, not a real Claude Code process.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665h"></a>
#### MUS-SPEC-06-665H: OpenCode: a sandboxed run uses the plan agent with bash and edits denied

- Precondition: An OpenCode chat set to Full, with the sandbox tools server configured and a user config of its own.
- Action: Build the OpenCode settings for a sandboxed run, then start the real OpenCode adapter with a fake launcher.
- Expected result: bash, edit, write and patch are off and denied, both globally and for the plan agent. The user's own config is kept and the sandbox server still loads. The launch uses the plan agent and its settings deny bash.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 OpenCode: a sandboxed run uses the plan agent with bash and edits removed and denied`
- Environment: Node test runner; the real OpenCode adapter with a fake process launcher.
- Known gaps: The launcher is a fake that records the call, so no real OpenCode starts.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665i"></a>
#### MUS-SPEC-06-665I: Grok: a sandboxed run never auto-approves host commands or edits

- Precondition: A Grok chat set to Full.
- Action: Build the Grok launch arguments for a sandboxed run and a host run, then ask for the permission choice for different kinds of request.
- Expected result: The sandboxed run starts in default permission mode, not "always approve". Execute, edit, delete, move and fetch requests are rejected, even a host command named like a sandbox tool. The sandbox tools and plain reads are allowed. The host run still starts with always-approve.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 Grok: a sandboxed run never auto-approves and rejects host commands and edits`
- Environment: Node test runner; no Grok process.
- Known gaps: Checks the launch arguments and the permission choice, not a real Grok process.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665j"></a>
#### MUS-SPEC-06-665J: HTTP, Gemini and Cursor chats run read-only and are told they have no sandbox tools

- Precondition: A chat set to Full on an HTTP chat, Gemini CLI or Cursor CLI route, with the sandbox settings and sandbox note.
- Action: Run each through the real provider adapter, with a fake route that records what it receives.
- Expected result: Each route receives read-only access and instructions that do not mention sandbox_exec.
- Test: `packages/agent-app/tests/sandbox-honesty.test.ts::#653 HTTP, Gemini and Cursor routes run a sandboxed chat read-only and are told plainly they have no sandbox tools`
- Environment: Node test runner; the real provider adapter with fake routes.
- Known gaps: The route is a fake, so no request goes out.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665k"></a>
#### MUS-SPEC-06-665K: Raising access in a sandbox chat asks to leave the sandbox first

- Precondition: A chat in the sandbox at Read only, with the composer and the environment footer on screen.
- Action: Choose "Ask for approval" and press Cancel. Choose it again and press "Leave sandbox". Then switch back to the sandbox, choose "Full access" and press "Leave sandbox".
- Expected result: A "Leave the sandbox?" sheet opens and says commands will run on this Mac with workspace access. Nothing changes before a choice, and Cancel changes nothing and keeps the sandbox. "Leave sandbox" makes one call that leaves and sets the level, and the chip reads "This Mac". For Full access the sheet says full access, and the usual Full access confirmation still follows before anything is sent, with its acknowledgement.
- Test: `packages/agent-app/tests/sandbox-honesty-dom.tsx::raising access in a sandbox chat asks to leave the sandbox first, and Cancel changes nothing`
- Environment: DOM suite (`linkedom`); the app's calls are faked.
- Known gaps: The calls are faked. The composer and the footer share one status request, which the check also asserts.
- Evidence: UNVERIFIED

<a id="mus-spec-06-665l"></a>
#### MUS-SPEC-06-665L: A sandbox chat on a model without sandbox tools says so, and Sandbox is disabled

- Precondition: A chat in the sandbox on a Gemini CLI model.
- Action: Look at the composer and the footer. Then make it a chat on this Mac, open the environment menu and click Sandbox. Then switch to a Codex model in the sandbox.
- Expected result: The composer says the model's tools can't run in the sandbox yet and run on this Mac, read-only, and the Sandbox chip warns. For the chat on this Mac there is no composer warning; the Sandbox row is listed but disabled with the reason, and clicking it sends no request. For the Codex chat the menu says what runs where: commands and file edits through sandbox tools run in a Linux container on an isolated copy, and the agent can still read files on this Mac.
- Test: `packages/agent-app/tests/sandbox-honesty-dom.tsx::a sandbox chat on a model whose tools cannot use the sandbox is warned, and the Sandbox choice is disabled with the reason`
- Environment: DOM suite (`linkedom`); the app's calls are faked.
- Known gaps: The calls are faked. Whether the model's tools run is MUS-SPEC-06-665B and 665J.
- Evidence: UNVERIFIED
