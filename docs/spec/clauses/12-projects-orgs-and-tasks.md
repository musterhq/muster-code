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
| [MUS-SPEC-12-556A](12-projects-orgs-and-tasks.md#mus-spec-12-556a) | After two overlapping workspace reads, the newer org's snapshot is kept when the older read finishes last. | [`a slower workspace read from before an org switch does not overwrite the newer one`](../../../packages/agent-app/tests/hub-store-race.tsx) |
| [MUS-SPEC-12-556B](12-projects-orgs-and-tasks.md#mus-spec-12-556b) | After two overlapping My work reads, a mounted component still shows the newer data. | [`a slower My work read from before an org switch does not overwrite the newer one`](../../../packages/agent-app/tests/hub-store-race.tsx) |
| [MUS-SPEC-12-556C](12-projects-orgs-and-tasks.md#mus-spec-12-556c) | Opening a task and a project in another org does not reject, leaves the route unchanged and raises an error notice with the reason. | [`a failed org switch is reported and the page stays where it was`](../../../packages/agent-app/tests/org-open-failure.tsx) |
| [MUS-SPEC-12-556D](12-projects-orgs-and-tasks.md#mus-spec-12-556d) | A failed My work read shows a Retry button; clicking it reads again and clears the error. | [`My work offers Retry after a failed read, and Retry reads again`](../../../packages/agent-app/tests/my-work-retry-dom.tsx) |
| [MUS-SPEC-12-683A](12-projects-orgs-and-tasks.md#mus-spec-12-683a) | When the hand-back countdown runs out, the timer callback finishes only once the hand-back has gone through, however long reading the chat takes. | [`#683 plain folder: the countdown's timer callback finishes only when the hand-back is done`](../../../packages/agent-app/tests/checkout-service.test.ts) |
| [MUS-SPEC-12-462A](12-projects-orgs-and-tasks.md#mus-spec-12-462a) | The run carries a protocol that limits stopping to user-only decisions, tells the agent to poll running work and no longer says not to wait. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-462B](12-projects-orgs-and-tasks.md#mus-spec-12-462b) | The protocol and the end-of-run line tell the agent to post the handoff comment with task_comment instead of asking. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-447A](12-projects-orgs-and-tasks.md#mus-spec-12-447a) | A check-out idle for days becomes one Needs-you item with how long it has been idle and a server note saying the same; Keep, Release and Hand back each clear it and do what they say. | [`#447 a check-out idle for days becomes ONE Needs-you item with how long, one server note, and Keep, Release and Hand back each do what they say`](../../../packages/agent-app/tests/checkout-service.test.ts) |

### Switching org and reading My work

<a id="mus-spec-12-556a"></a>
#### MUS-SPEC-12-556A: A slower workspace read from before an org switch cannot bring the old org back

- Precondition: The Hub has started a workspace read for the old org, and the user switches org, which starts a second read.
- Action: The newer read finishes first, then the older read finishes.
- Expected result: The Hub keeps the newer org's workspace. The older read is dropped and does not bring the old org's projects and tasks back.
- Test: `packages/agent-app/tests/hub-store-race.tsx::a slower workspace read from before an org switch does not overwrite the newer one`
- Environment: Node, the real hub store and a fake bridge whose reads are finished by the test; no server.
- Known gaps: Drives the store, not a mounted Hub page, so what is drawn is not checked.
- Evidence: UNVERIFIED

<a id="mus-spec-12-556b"></a>
#### MUS-SPEC-12-556B: A slower My work read from before an org switch cannot overwrite the newer one

- Precondition: My work has started a read, and a second read is started right after (as happens after an org switch).
- Action: The second read finishes first, then the first read finishes with older data.
- Expected result: A component showing My work still shows the newer data. The older read is dropped.
- Test: `packages/agent-app/tests/hub-store-race.tsx::a slower My work read from before an org switch does not overwrite the newer one`
- Environment: Node, linkedom, a probe component using the real My work store, and a fake bridge whose reads are finished by the test; no server.
- Known gaps: Uses a small probe component, not the My work page itself.
- Evidence: UNVERIFIED

<a id="mus-spec-12-556c"></a>
#### MUS-SPEC-12-556C: A failed org switch is reported and the page stays where it was

- Precondition: The user opens a task or a project that belongs to another org, and switching to that org fails with "server unreachable".
- Action: Open the task, then open the project.
- Expected result: Both calls end normally with no unhandled error. The Hub does not move to the task or project. An error notice shows the reason.
- Test: `packages/agent-app/tests/org-open-failure.tsx::a failed org switch is reported and the page stays where it was`
- Environment: Node and a fake bridge that fails the org switch; no server.
- Known gaps: Checks the store and the notice list; the notice is not drawn. The handler that opens a task from a chat link is not run.
- Evidence: UNVERIFIED

<a id="mus-spec-12-556d"></a>
#### MUS-SPEC-12-556D: My work offers Retry after a failed read

- Precondition: The My work page is open and its first read fails.
- Action: The page shows "Your work could not be read". Click Retry.
- Expected result: A Retry button is on the page. Clicking it reads again, and the error goes away when the read works.
- Test: `packages/agent-app/tests/my-work-retry-dom.tsx::My work offers Retry after a failed read, and Retry reads again`
- Environment: Node and linkedom: a DOM suite with the real page and a fake bridge; no server.
- Known gaps: None known.
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
