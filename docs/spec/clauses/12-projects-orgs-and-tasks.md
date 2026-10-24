# MUS-SPEC-12: Projects, orgs, tasks and check-out

A Project groups chats, tasks and agents around shared goals. An org is the team of agents and people that works on them. This is the Paperclip-style workspace.

What the user can do:
- create Projects and orgs, hire agents into an org chart, and set their roles and budgets;
- create tasks as threads with properties (status, owner, priority, labels, sub-tasks), and see them in the Inbox, My work, All tasks, the Dashboard and the Roster;
- let an agent check out a task, work on it, and hand it back; see runs and activity.

Boundaries:
- A task is checked out by at most one agent at a time.
- Agent wakes that were waiting are not lost when Muster quits; they resume once when it opens.
- Opening an org's page switches to that org first.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-12-558A](12-projects-orgs-and-tasks.md#mus-spec-12-558a) | After the chosen Group has no items left, the Inbox lists the remaining items instead of an empty list. | [`the Inbox shows the remaining items when the chosen group has none left`](../../../packages/agent-app/tests/inbox-group-stale-dom.tsx) |
| [MUS-SPEC-12-558B](12-projects-orgs-and-tasks.md#mus-spec-12-558b) | A failed impact check shows its error and a Try again button, and clicking it shows the impact list. | [`archive confirmation offers Try again after a failed impact check`](../../../packages/agent-app/tests/project-confirm-retry-dom.tsx) |
| [MUS-SPEC-12-558C](12-projects-orgs-and-tasks.md#mus-spec-12-558c) | After the runtime rejects a quiet-hours value of 9999, the field shows the saved value 8. | [`a quiet-hours value the runtime rejects is replaced by the saved value`](../../../packages/agent-app/tests/checkout-settings-reject-dom.tsx) |
| [MUS-SPEC-12-683A](12-projects-orgs-and-tasks.md#mus-spec-12-683a) | When the hand-back countdown runs out, the timer callback finishes only once the hand-back has gone through, however long reading the chat takes. | [`#683 plain folder: the countdown's timer callback finishes only when the hand-back is done`](../../../packages/agent-app/tests/checkout-service.test.ts) |
| [MUS-SPEC-12-462A](12-projects-orgs-and-tasks.md#mus-spec-12-462a) | The run carries a protocol that limits stopping to user-only decisions, tells the agent to poll running work and no longer says not to wait. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-462B](12-projects-orgs-and-tasks.md#mus-spec-12-462b) | The protocol and the end-of-run line tell the agent to post the handoff comment with task_comment instead of asking. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-447A](12-projects-orgs-and-tasks.md#mus-spec-12-447a) | A check-out idle for days becomes one Needs-you item with how long it has been idle and a server note saying the same; Keep, Release and Hand back each clear it and do what they say. | [`#447 a check-out idle for days becomes ONE Needs-you item with how long, one server note, and Keep, Release and Hand back each do what they say`](../../../packages/agent-app/tests/checkout-service.test.ts) |

### Hub pages that recover from stale or failed states

<a id="mus-spec-12-558a"></a>
#### MUS-SPEC-12-558A: The Inbox shows what is left when the chosen group is empty

- Precondition: The Inbox has two items in groups Alpha and Beta, and the user has chosen the group Alpha.
- Action: The Alpha item is resolved, so only the Beta item is left, and the Inbox is drawn again.
- Expected result: The Inbox shows the Beta item. It does not stay empty behind a Group control that is hidden because only one group is left.
- Test: `packages/agent-app/tests/inbox-group-stale-dom.tsx::the Inbox shows the remaining items when the chosen group has none left`
- Environment: Node and linkedom: a DOM suite with the real InboxPage; no server.
- Known gaps: Does not click the Group menu back to Everything; only the fall-back is checked.
- Evidence: UNVERIFIED

<a id="mus-spec-12-558b"></a>
#### MUS-SPEC-12-558B: Archive and delete confirmations offer Try again when the impact check fails

- Precondition: The user opens the archive confirmation for a project, and the first impact check fails with "busy".
- Action: Click Try again.
- Expected result: The error is shown with a Try again button. After the click the impact check runs again and the impact list appears.
- Test: `packages/agent-app/tests/project-confirm-retry-dom.tsx::archive confirmation offers Try again after a failed impact check`
- Environment: Node and linkedom: a DOM suite with the real ConfirmProjectAction and a fake bridge; no server.
- Known gaps: Only the archive action is run; delete uses the same dialog code.
- Evidence: UNVERIFIED

<a id="mus-spec-12-558c"></a>
#### MUS-SPEC-12-558C: A rejected check-out setting is put back to the saved value

- Precondition: The Local checkouts card in Settings shows a quiet-hours value of 8, and the runtime rejects any value above 720.
- Action: Type 9999 in the field and leave it.
- Expected result: The runtime's error is reported and the field goes back to the saved 8. It does not keep showing 9999 as if saved.
- Test: `packages/agent-app/tests/checkout-settings-reject-dom.tsx::a quiet-hours value the runtime rejects is replaced by the saved value`
- Environment: Node and linkedom: a DOM suite with the real LocalCheckoutsCard and a fake bridge; no server.
- Known gaps: Only the quiet-hours field is run; the device-name field uses the same recovery code.
- Evidence: UNVERIFIED

### Hand-back of a plain folder

<a id="mus-spec-12-683a"></a>
#### MUS-SPEC-12-683A: A countdown that ran out has handed the task back

- Precondition: A task checked out into a plain folder, a file added and one edited in it, a finished turn, and the 60 second countdown running. Reading the chat is slow (150 ms), as on a loaded machine.
- Action: The countdown runs out.
- Expected result: When the timer callback has finished, the task is handed back to the reviewer with the added file listed; it is never still checked out because the hand-back was still in flight.
- Test: `packages/agent-app/tests/checkout-service.test.ts::#683 plain folder: the countdown's timer callback finishes only when the hand-back is done`
- Environment: Node test runner; the checkout service with a fake server, a fake timer and a temp folder.
- Known gaps: The real timer ignores what the callback returns. Change detection by file content was already correct and is not part of this case.
- Evidence: UNVERIFIED

<a id="mus-spec-12-447a"></a>
#### MUS-SPEC-12-447A: An idle check-out asks its owner what to do

- Precondition: A task checked out on this Mac and left alone, with the clock moving from two days to eight days and then a day more.
- Action: Check the stale check-outs and read the Inbox items, then press Keep, Release or Hand back.
- Expected result: At two days there is nothing. At eight days there is exactly one Needs-you item for the check-out ("No activity for 8 days") and one note on the server task that says "Idle for 8 days"; checking again does not add another note or item. Keep clears the item (a later quiet stretch brings it back with its own note), Release clears it and puts the task back, Hand back clears it. Activity in another chat of the same worktree means no note and no item. Nothing is handed back or released by itself.
- Test: `packages/agent-app/tests/checkout-service.test.ts::#447 a check-out idle for days becomes ONE Needs-you item with how long, one server note, and Keep, Release and Hand back each do what they say`
- Environment: Node test runner; the checkout service with a fake server and a movable clock.
- Known gaps: The Inbox row buttons and the merge into the Inbox list are not driven here; they call the same Keep, Release and Hand back service methods.
- Evidence: UNVERIFIED

### Task protocol

<a id="mus-spec-12-462a"></a>
#### MUS-SPEC-12-462A: A task run waits on running work and stops only for the user

- Precondition: A Project task is assigned to an agent and a run starts.
- Action: Read the task protocol that is sent to the agent with the run.
- Expected result: Step 6 tells the agent to stop and ask only when the user alone can decide (an approval, a credential or a product choice). For a build, tests, a deploy or a long command it tells the agent to keep its turn open and poll with a tool call. The old line "Do not wait or poll" is gone.
- Test: `packages/agent-app/tests/wave4-task-tools.test.ts::G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`
- Environment: Node test runner; temp data folder; local tool host on a loopback port; no provider or network.
- Known gaps: Checks the protocol text that the run carries. It does not show a model waiting on a build.
- Evidence: UNVERIFIED

<a id="mus-spec-12-462b"></a>
#### MUS-SPEC-12-462B: The agent posts the handoff comment itself

- Precondition: A Project task run, with run comments on.
- Action: Read the task protocol and the end-of-run line sent with the run.
- Expected result: Step 4 tells the agent to post the handoff comment itself with task_comment and never to draft it and ask the user. The end-of-run line says to post it with task_comment and not to ask whether to post.
- Test: `packages/agent-app/tests/wave4-task-tools.test.ts::G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`
- Environment: Node test runner; temp data folder; local tool host on a loopback port; no provider or network.
- Known gaps: Checks the wording the run carries. There was no code path that drafts and asks, so no behaviour beyond the instructions is shown.
- Evidence: UNVERIFIED
