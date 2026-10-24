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
| [MUS-SPEC-12-157A](12-projects-orgs-and-tasks.md#mus-spec-12-157a) | A task with 2,000 messages still wakes: the run gets the newest messages that fit, the true count, and a logged packet size, and the protocol is never cut. | [`#157: a task with 2,000 messages still wakes; the packet is capped to the newest messages and the cap is logged in the activity`](../../../packages/agent-app/tests/wave1-fix-bounded-wake.test.ts) |
| [MUS-SPEC-12-157B](12-projects-orgs-and-tasks.md#mus-spec-12-157b) | A prompt too big for one argument reaches Gemini on stdin (as its docs describe); a short one stays in argv, and Cursor and OpenCode keep argv. | [`#157: Gemini (whose docs say piped stdin joins --prompt) gets a prompt too big for one argument on stdin; Cursor and OpenCode keep argv, which the bounded packet keeps small`](../../../packages/agent-app/tests/wave1-fix-bounded-wake.test.ts) |
| [MUS-SPEC-12-157C](12-projects-orgs-and-tasks.md#mus-spec-12-157c) | The same start error three times in a row raises one Inbox Problem and stops that task's retries until you resolve it. | [`#157: the same start error three times in a row raises one Problem and stops that task's retries until you act`](../../../packages/agent-app/tests/wave1-fix-bounded-wake.test.ts) |
| [MUS-SPEC-12-157D](12-projects-orgs-and-tasks.md#mus-spec-12-157d) | Different errors, or errors that are not start errors, never add up to a start Problem. | [`#157: different errors, or a run that gets going in between, do not add up to a Problem`](../../../packages/agent-app/tests/wave1-fix-bounded-wake.test.ts) |

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

### Bounded wake context and start failures

<a id="mus-spec-12-157a"></a>
#### MUS-SPEC-12-157A: A task with 2,000 messages still wakes with a bounded, logged packet

- Precondition: A Project task owned by an agent has 2,000 notes in its thread, each about 700 characters.
- Action: Wake the agent on demand.
- Expected result: The run starts and finishes. Its packet says the thread has 2,000 messages and shows only the newest few that fit, oldest first, with a count of the older ones left out. The newest note is in it and the oldest is not. The packet stays near the 8 KB block limit, nothing is cut off from the task protocol, and the task activity has a line giving the packet size and how many of the 2,000 messages were included.
- Test: `packages/agent-app/tests/wave1-fix-bounded-wake.test.ts::#157: a task with 2,000 messages still wakes; the packet is capped to the newest messages and the cap is logged in the activity`
- Environment: Node test runner; the real agent service, real SQLite, a real git repo and a scripted provider.
- Known gaps: The thread is clipped to the newest messages with a count, not summarised by a model. Hindsight recall is not used for the packet.
- Evidence: UNVERIFIED

<a id="mus-spec-12-157b"></a>
#### MUS-SPEC-12-157B: A prompt too big for one argument goes to Gemini on stdin

- Precondition: A Gemini chat whose turn text is 300,000 bytes, and short Gemini, Cursor and OpenCode chats.
- Action: Run each turn with a fake CLI process that records its arguments and stdin.
- Expected result: For Gemini, no argument is larger than 1,000 bytes and the whole text arrives on stdin. A short Gemini prompt stays in argv with nothing on stdin. Cursor and OpenCode keep the prompt in argv with nothing on stdin.
- Test: `packages/agent-app/tests/wave1-fix-bounded-wake.test.ts::#157: Gemini (whose docs say piped stdin joins --prompt) gets a prompt too big for one argument on stdin; Cursor and OpenCode keep argv, which the bounded packet keeps small`
- Environment: Node test runner; fake child processes, no real CLI.
- Known gaps: Only checks what Muster sends; the real Gemini binary was not run (its docs describe stdin joined with --prompt). Cursor and OpenCode are not moved to stdin because their own docs do not confirm it, so a prompt larger than the OS argument limit still cannot start them; the bounded wake packet (case 157A) keeps Muster's own text far below that. Codex and Claude Code already use stdin and are unchanged.
- Evidence: UNVERIFIED

<a id="mus-spec-12-157c"></a>
#### MUS-SPEC-12-157C: Three identical start errors stop a task and raise one Problem

- Precondition: An agent-owned task whose run fails to start with the same error (a missing program) each time.
- Action: Start the task three times, then start it again, wake its agent, and finally resolve the Problem.
- Expected result: After the third start there is exactly one open Problem for the task in the Inbox, naming the error. A fourth start and a wake are refused with no run started, and no second Problem appears. Another task of the same agent still runs. After the Problem is resolved the task can start again.
- Test: `packages/agent-app/tests/wave1-fix-bounded-wake.test.ts::#157: the same start error three times in a row raises one Problem and stops that task's retries until you act`
- Environment: Node test runner; the real agent service and a scripted provider that fails to start.
- Known gaps: Counts errors that look like a failed start (could not start, spawn errors, no usable runner or worktree). Other failures keep their existing retry rules.
- Evidence: UNVERIFIED

<a id="mus-spec-12-157d"></a>
#### MUS-SPEC-12-157D: Errors that are not repeated start errors never raise the Problem

- Precondition: Tasks that fail twice with a start error, or four times with an ordinary model refusal.
- Action: Run each task to its failures.
- Expected result: No start Problem is raised for either task.
- Test: `packages/agent-app/tests/wave1-fix-bounded-wake.test.ts::#157: different errors, or a run that gets going in between, do not add up to a Problem`
- Environment: Node test runner; the real agent service and a scripted provider.
- Known gaps: Does not cover a different start error in between resetting the count beyond the two-then-different case shown.
- Evidence: UNVERIFIED
