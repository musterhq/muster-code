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
| [MUS-SPEC-12-683A](12-projects-orgs-and-tasks.md#mus-spec-12-683a) | When the hand-back countdown runs out, the timer callback finishes only once the hand-back has gone through, however long reading the chat takes. | [`#683 plain folder: the countdown's timer callback finishes only when the hand-back is done`](../../../packages/agent-app/tests/checkout-service.test.ts) |
| [MUS-SPEC-12-462A](12-projects-orgs-and-tasks.md#mus-spec-12-462a) | The run carries a protocol that limits stopping to user-only decisions, tells the agent to poll running work and no longer says not to wait. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-462B](12-projects-orgs-and-tasks.md#mus-spec-12-462b) | The protocol and the end-of-run line tell the agent to post the handoff comment with task_comment instead of asking. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |

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
