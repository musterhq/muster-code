# MUS-SPEC-05: Access modes, approvals and tool permissions

Each chat has an access mode that sets what the agent may do without asking: Read only, Workspace (edit inside the chat's folder), Auto (routine requests settle themselves; risky ones ask) or Full access.

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
| [MUS-SPEC-05-347B](05-access-modes-and-approvals.md#mus-spec-05-347b) | While another process keeps swapping a folder and a file name for links, repeated writes create no file or folder outside the chat's folder and leave the file already there unchanged. | [`a racer swapping a folder and a link under repeated writes puts no content outside`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-347C](05-access-modes-and-approvals.md#mus-spec-05-347c) | A policyOnly flag inside the parameters of an approval request does not skip the approval card. | [`a policyOnly flag inside request parameters does not skip the approval card`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-347D](05-access-modes-and-approvals.md#mus-spec-05-347d) | An HTTP route's file change asks for approval with policyOnly as a separate argument, not inside the parameters. | [`the HTTP tools pass policyOnly as a separate authorize argument`](../../../packages/agent-app/tests/write-confined-347.test.ts) |
| [MUS-SPEC-05-473F](05-access-modes-and-approvals.md#mus-spec-05-473f) | A mid-turn start by the agent is allowed only in Agent mode with Full access; a user start still waits for the turn. | [`commandAuthority: the agent may start mid-turn, but only in Agent mode with Full access`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-05-473G](05-access-modes-and-approvals.md#mus-spec-05-473g) | The muster_background server and its instruction are added only for Agent mode with Full access. | [`the muster_background server is offered only in Agent mode with Full access, with its instruction`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-05-459A](05-access-modes-and-approvals.md#mus-spec-05-459a) | The no-asking rule is in the instructions for Agent mode with Full access only, and in no other mode or access level. | [`Full access adds the no-asking rule to agent instructions only`](../../../packages/agent-app/tests/agent-autonomy.test.ts) |
| [MUS-SPEC-05-459B](05-access-modes-and-approvals.md#mus-spec-05-459b) | A Full access run on an HTTP route receives the no-asking rule, a Workspace run does not, and the tool note asks only before irreversibly deleting user data. | [`an API-key route in Full access gets the no-asking rule and a tool note that asks only before deleting user data`](../../../packages/agent-app/tests/agent-autonomy.test.ts) |
| [MUS-SPEC-05-573A](05-access-modes-and-approvals.md#mus-spec-05-573a) | A rule with many stars rejects a long command quickly and still matches as before. | [`a tool-rule glob with many stars matches in linear-ish time against a long command`](../../../packages/agent-app/tests/governance-bughunt.test.ts) |
| [MUS-SPEC-05-382A](05-access-modes-and-approvals.md#mus-spec-05-382a) | A Claude Code shell command in a Workspace chat shows an approval card, is not answered before the user decides, and Claude Code is told to go ahead once the user approves. | [`Claude Code in Workspace access: a shell command waits for the approval card and runs once approved`](../../../packages/agent-app/tests/claude-approvals-382.test.ts) |
| [MUS-SPEC-05-382B](05-access-modes-and-approvals.md#mus-spec-05-382b) | A declined shell command is refused to Claude Code with a reason and the turn still completes; Full access and Read only chats do not route prompts to Muster. | [`Claude Code in Workspace access: a declined shell command is refused and the turn still completes`](../../../packages/agent-app/tests/claude-approvals-382.test.ts) |
| [MUS-SPEC-05-407A](05-access-modes-and-approvals.md#mus-spec-05-407a) | Missing, empty, declined, timed-out and no-opinion permission replies refuse a file write; only an explicit allow or accepted reply writes the file. | [`an unanswered permission request refuses the file change and reports that it did not run`](../../../packages/agent-app/tests/runtime-quality-407.test.ts) |
| [MUS-SPEC-05-841A](05-access-modes-and-approvals.md#mus-spec-05-841a) | In Auto access, a safe command, a read anywhere and an edit inside the chat's folder are accepted with no card, and each tool row records the rule that approved it. | [`Auto access: safe commands, reads and edits inside the folder settle themselves and say so on the tool row`](../../../packages/agent-app/tests/auto-approvals-841.test.ts) |
| [MUS-SPEC-05-841B](05-access-modes-and-approvals.md#mus-spec-05-841b) | In Auto access, network installs, git push, sudo, deletes outside the folder, writes outside the folder, piped downloads and redirects outside raise approval cards and nothing is answered on its own. | [`Auto access: installs, pushes, sudo, deletes and writes outside the folder still ask`](../../../packages/agent-app/tests/auto-approvals-841.test.ts) |
| [MUS-SPEC-05-841C](05-access-modes-and-approvals.md#mus-spec-05-841c) | A command on the `approvals.autoAllow` setting is accepted in Auto access and its row names the allowlist; a command not on it still asks. | [`Auto access: a command on the person's allowlist settles itself and names the allowlist`](../../../packages/agent-app/tests/auto-approvals-841.test.ts) |
| [MUS-SPEC-05-841D](05-access-modes-and-approvals.md#mus-spec-05-841d) | A Claude Code chat in Auto access sends its permission prompts to Muster in default mode; a safe git command is allowed at once and git push waits for the card. | [`Auto access on Claude Code: prompts reach Muster, a safe command is allowed at once and git push still asks`](../../../packages/agent-app/tests/auto-approvals-841.test.ts) |
| [MUS-SPEC-05-841E](05-access-modes-and-approvals.md#mus-spec-05-841e) | Codex runs Auto with a workspace sandbox and asks Muster about every untrusted command; Full access still never prompts; an OpenCode route runs as Workspace; the picker lists Auto and says when it runs as Ask for approval. | [`Auto access: Codex asks Muster about every untrusted command; other routes run as Workspace and the picker says so`](../../../packages/agent-app/tests/auto-approvals-841.test.ts) |
| [MUS-SPEC-05-841F](05-access-modes-and-approvals.md#mus-spec-05-841f) | Environment prefixes, rg preprocessors, git config and output options, writing or executing sed scripts, sort helpers and tools that write output still ask in Auto; project code (tests, scripts, linters) settles only inside Codex's workspace sandbox; edits inside `.git` ask. | [`Auto access: read-only commands that can run programs or write files still ask`](../../../packages/agent-app/tests/auto-approvals-841.test.ts) |
| [MUS-SPEC-05-44G](05-access-modes-and-approvals.md#mus-spec-05-44g) | The child's approval card is copied onto the parent with the same text and data.delegated naming the child card; approving the parent's copy gives the child "accept" and both cards read approved; declining the next one in the child gives "decline" and the parent's copy reads declined. | [`a child's approval shows on its parent too and can be answered from either chat`](../../../packages/agent-app/tests/delegation-44.test.ts) |

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
- Expected result: When the race ends, no file or folder was created in `outside`, including empty ones, and its existing file is unchanged.
- Test: `packages/agent-app/tests/write-confined-347.test.ts::a racer swapping a folder and a link under repeated writes puts no content outside`
- Environment: Node test runner, a concurrent filesystem racer, temp folders, a file system that allows links.
- Known gaps: A race test is a sample, not a proof. It does not show which check stopped each attempt. Deterministic creation races are covered by MUS-SPEC-19-710A, MUS-SPEC-19-710B and MUS-SPEC-19-710C.
- Evidence: local; ~/.muster-work/review/710/green-workflows.txt; exit 0; 51 passed, 0 failed, 1 skipped; commit db2dcfbd0197ba0406bb3135b41764e4ff8a15e2

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

<a id="mus-spec-05-573a"></a>
#### MUS-SPEC-05-573A: A tool-rule pattern with many stars finishes fast

- Precondition: A tool rule with twelve stars and a 400-character command that cannot match.
- Action: Match the command against the rule.
- Expected result: The answer is no, in under 500 ms. Rules are still anchored and ignore case, ? matches one character, and dots and brackets are plain.
- Test: `packages/agent-app/tests/governance-bughunt.test.ts::a tool-rule glob with many stars matches in linear-ish time against a long command`
- Environment: Node test runner; no network.
- Known gaps: Tests the matcher. It does not run a tool call through the approval flow. The time limit may need care on a very slow machine. On main this test never finishes.
- Evidence: UNVERIFIED

### Claude Code shell approvals

<a id="mus-spec-05-382a"></a>
#### MUS-SPEC-05-382A: A Claude Code shell command waits for the user's approval

- Precondition: A chat on the Claude Code route with Workspace access. Claude Code asks to run a shell command that it does not allow on its own.
- Action: Send a message. Claude Code asks permission for the command. Approve the card.
- Expected result: An approval card for the command appears and Claude Code gets no answer before the user decides. After Approve, Claude Code is told to allow that command with its own input unchanged, and the turn completes.
- Test: `packages/agent-app/tests/claude-approvals-382.test.ts::Claude Code in Workspace access: a shell command waits for the approval card and runs once approved`
- Environment: Node test runner; a fake Claude Code process that speaks the stream-json permission protocol; no network.
- Known gaps: Uses the protocol as seen in Claude Code 2.1.x, not a live Claude Code run. "Approve for this session" is answered as a single approval.
- Evidence: UNVERIFIED

<a id="mus-spec-05-382b"></a>
#### MUS-SPEC-05-382B: A declined Claude Code shell command is refused

- Precondition: A chat on the Claude Code route with Workspace access. Claude Code asks to run a shell command.
- Action: Decline the approval card. Separately start a Full access chat and a Read only chat.
- Expected result: Claude Code is told to deny the command, with a message that the user declined it, and the turn still completes. Chats with Full access or Read only do not give Claude Code a permission prompt tool.
- Test: `packages/agent-app/tests/claude-approvals-382.test.ts::Claude Code in Workspace access: a declined shell command is refused and the turn still completes`
- Environment: Node test runner; a fake Claude Code process; no network.
- Known gaps: Uses the protocol as seen in Claude Code 2.1.x, not a live Claude Code run.
- Evidence: UNVERIFIED

### Runtime ownership and unanswered requests

<a id="mus-spec-05-407a"></a>
#### MUS-SPEC-05-407A: Missing, empty, declined, timed-out and no-opinion permission replies refuse a file write; only an explicit allow or accepted reply writes the file.

- Precondition: A Workspace chat on an HTTP route with the real provider adapter and file tool.
- Action: Request a file write with each host permission reply.
- Expected result: No answer, an empty reply, a failed or timed-out callback, deny and no-opinion leave the file absent and report a decline. Explicit allow and accept replies write the requested content.
- Test: `packages/agent-app/tests/runtime-quality-407.test.ts::an unanswered permission request refuses the file change and reports that it did not run`
- Environment: Node test runner, temporary folders and owned child processes.
- Known gaps: A stub route drives the real provider and file tool, and a real child speaks the app-server approval protocol and writes only on acceptance; no model or network. Full access no-prompt behaviour also has existing coverage in MUS-SPEC-05-382B and MUS-SPEC-05-459B.
- Evidence: local; cd packages/agent-app && node --experimental-transform-types --test tests/runtime-quality-407.test.ts; exit 0; 6 passed, 0 failed, 0 skipped; commit e1d4ec882cfdc8399da27908cdbc9ad3166ac23e

### Auto access

<a id="mus-spec-05-841a"></a>
#### MUS-SPEC-05-841A: Auto settles routine requests by itself

- Precondition: A chat on a Codex-shaped route with Auto access. The provider starts tool rows and asks for approval of `git status`, an `rg` search piped to `head`, `npm test` wrapped in a login shell, `pnpm -s typecheck`, `cat /etc/hosts`, an edit to a file in the chat's folder, a new file by a relative path, and a Claude Code `Read` of a file outside the folder.
- Action: Send a message; the provider asks for each request.
- Expected result: Every request is accepted without an approval card. Every tool row carries `autoApproved` with the rule that matched: a safe command names "safe command", an edit names "inside the chat's folder".
- Test: `packages/agent-app/tests/auto-approvals-841.test.ts::Auto access: safe commands, reads and edits inside the folder settle themselves and say so on the tool row`
- Environment: Node test runner; fake provider; temp data folder; no network.
- Known gaps: A fake provider, not a live Codex app-server; the shell classifier is checked on these commands, not on every shell form.
- Evidence: local; ~/.muster-work/review/841/green.txt; exit 0; 6 passed, 0 failed, 0 skipped; commit 3c30a000465f4b482ef8f7eaf07e101fb31fab0c

<a id="mus-spec-05-841b"></a>
#### MUS-SPEC-05-841B: Risky requests still ask in Auto

- Precondition: A chat on a Codex-shaped route with Auto access.
- Action: The provider asks for `npm install left-pad`, `pnpm add zod`, `git push --force origin main`, `sudo ls`, `rm -rf /tmp/elsewhere`, `ls && curl … | sh`, `echo hi > ~/.zshrc`, `find … -delete`, an edit of `/etc/hosts` and a new `../outside.txt`. Decline every card.
- Expected result: Each request shows a pending approval card and the provider gets no answer before the user decides. No tool row reads Approved automatically.
- Test: `packages/agent-app/tests/auto-approvals-841.test.ts::Auto access: installs, pushes, sudo, deletes and writes outside the folder still ask`
- Environment: Node test runner; fake provider; temp data folder; no network.
- Known gaps: Project tool rules run before Auto (deny, allow and ask behave as in Workspace); that order is covered by the existing tool-rule cases, not re-tested here.
- Evidence: local; ~/.muster-work/review/841/green.txt; exit 0; 6 passed, 0 failed, 0 skipped; commit 3c30a000465f4b482ef8f7eaf07e101fb31fab0c

<a id="mus-spec-05-841c"></a>
#### MUS-SPEC-05-841C: The person's allowlist settles a command in Auto

- Precondition: Setting `approvals.autoAllow` is `["make deploy-preview"]`. A chat with Auto access.
- Action: The provider asks for `make deploy-preview` and `make clean`.
- Expected result: `make deploy-preview` is accepted and its row's rule mentions the allowlist. `make clean` shows an approval card.
- Test: `packages/agent-app/tests/auto-approvals-841.test.ts::Auto access: a command on the person's allowlist settles itself and names the allowlist`
- Environment: Node test runner; fake provider; temp data folder.
- Known gaps: The allowlist is a setting (import, export, settings file); this change adds no new screen to edit it.
- Evidence: local; ~/.muster-work/review/841/green.txt; exit 0; 6 passed, 0 failed, 0 skipped; commit 3c30a000465f4b482ef8f7eaf07e101fb31fab0c

<a id="mus-spec-05-841d"></a>
#### MUS-SPEC-05-841D: Auto on Claude Code

- Precondition: A chat on the Claude Code route with Auto access.
- Action: Claude Code asks to run `git log --oneline -5`, then `git push origin main`. Decline the card.
- Expected result: Claude Code runs with `--permission-mode default` and `--permission-prompt-tool=stdio`. The safe command is allowed with its input unchanged and no card. `git push` shows a card and is answered only after the user declines.
- Test: `packages/agent-app/tests/auto-approvals-841.test.ts::Auto access on Claude Code: prompts reach Muster, a safe command is allowed at once and git push still asks`
- Environment: Node test runner; a fake Claude Code process speaking the stream-json permission protocol; no network.
- Known gaps: Uses the protocol as seen in Claude Code 2.1.x, not a live Claude Code run.
- Evidence: local; ~/.muster-work/review/841/green.txt; exit 0; 6 passed, 0 failed, 0 skipped; commit 3c30a000465f4b482ef8f7eaf07e101fb31fab0c

<a id="mus-spec-05-841e"></a>
#### MUS-SPEC-05-841E: Auto on Codex, fallback on other routes, and the picker

- Precondition: Agent mode with Auto access.
- Action: Read the Codex access policy; build Claude Code arguments for Full access; send a turn on an OpenCode route; list the picker options for a route with and without Auto.
- Expected result: Codex gets `workspace-write`, approval `untrusted`, no network; Plan stays read-only. Full access gets no permission prompt tool. The OpenCode adapter receives `workspace`. The picker lists Read only, Ask for approval, Auto, Full access; on a route without Auto the Auto row says it runs as Ask for approval.
- Test: `packages/agent-app/tests/auto-approvals-841.test.ts::Auto access: Codex asks Muster about every untrusted command; other routes run as Workspace and the picker says so`
- Environment: Node test runner; fake routes; no network.
- Known gaps: The picker check is on the option list the Composer and New chat screen render, not a rendered menu.
- Evidence: local; ~/.muster-work/review/841/green.txt; exit 0; 6 passed, 0 failed, 0 skipped; commit 3c30a000465f4b482ef8f7eaf07e101fb31fab0c

<a id="mus-spec-05-841f"></a>
#### MUS-SPEC-05-841F: Read-only commands that can run programs or write files still ask

- Precondition: Auto access. The chat's folder is a temp folder. One request set is judged as on Codex (inside Muster's workspace sandbox), another as on Claude Code (no OS sandbox).
- Action: Ask to run commands that look read-only but run a program or write a file: an environment assignment before any command (`GIT_EXTERNAL_DIFF=…`, `DYLD_INSERT_LIBRARIES=…`), `rg --pre`, git with `-c`, `--config-env`, `--exec-path`, `--git-dir`/`--work-tree`/`-C` outside the folder, `--output`, `--ext-diff`, `--textconv`, `git grep -O`, `git cat-file --filters`; sed scripts with `w`, `W`, `e`, the `w`/`e` flags of `s`, `-f` or in-place; `sort --compress-program` or `-o`; `tree -o`; `eslint --fix`/`-o`; `prettier` without `--check`; `tsc` without `--noEmit`; `uniq` with an output file; `file -C`; `cd` outside the folder. Then ask for project-code commands (npm test, package scripts, node --test, pytest, go/cargo, make, vitest, eslint, tsc, prettier) on each route; and for edits inside `.git`. On the Claude Code route, Claude Code asks to run `npm test`.
- Expected result: Every listed command asks (no rule matches). The same tools used read-only (`git diff`, `git -C . log`, `rg -n`, `sed -n "1,20p"`, `sort -u`, `tree -L 2`, `prettier --check`, `tsc --noEmit`, `uniq -c`, `cd src && ls`) settle. Project-code commands settle on Codex and ask on Claude Code unless they are on the allowlist; plain reads settle on both. Edits inside `.git` ask. On Claude Code, `npm test` shows a card and gets no answer until the user decides.
- Test: `packages/agent-app/tests/auto-approvals-841.test.ts::Auto access: read-only commands that can run programs or write files still ask`
- Environment: Node test runner; the Auto classifier and a fake Claude Code process; temp folder; no network.
- Known gaps: A conservative list, not a shell interpreter: forms it does not recognise ask. A program on PATH that was itself replaced is outside this check.
- Evidence: local; ~/.muster-work/review/841/green.txt; exit 0; 6 passed, 0 failed, 0 skipped; commit 3c30a000465f4b482ef8f7eaf07e101fb31fab0c

### Delegated chats (#44)

A chat another chat started has its parent's access, never more, and its approvals and questions also reach the parent.

<a id="mus-spec-05-44g"></a>
#### MUS-SPEC-05-44G: A child's approval shows on its parent too and can be answered from either chat

- Precondition: A Workspace parent with a child that asks to run two commands.
- Action: Approve the first from the parent's copy; decline the second in the child itself.
- Expected result: A child's approval and question cards also show on its parent (and every chat above it). Answering either card answers the child's request, and the other card closes with the same result.
- Test: `packages/agent-app/tests/delegation-44.test.ts::a child's approval shows on its parent too and can be answered from either chat`
- Environment: Node test runner; the real service and its approval flow; a fake provider that asks through onRequest.
- Known gaps: Questions use the same path (question.respond and question.dismiss answer the child's card); only approvals are driven here.
- Evidence: UNVERIFIED
