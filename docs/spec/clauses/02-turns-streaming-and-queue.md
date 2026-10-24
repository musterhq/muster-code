# MUS-SPEC-02: Turns, streaming and the message queue

A turn is one run of the agent in reply to a message. The user watches it stream in the transcript and can steer it while it runs.

What the user can do:
- watch replies, reasoning, tool calls and file edits stream into the timeline as they happen;
- stop a turn; queue more messages while a turn runs, edit or remove queued ones, or send one now to steer the running turn;
- see retries, rate limits and failures as plain notices, and continue after a restart.

Boundaries:
- A stopped turn settles every unfinished tool row as Stopped and keeps partial output. A command that never ran says Did not run.
- A queued message is sent once, in order, and is never dropped by a restart or a failed turn.
- When a turn needs to shrink its history, clause [04](04-context-window-and-compaction.md) applies.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-02-387A](02-turns-streaming-and-queue.md#mus-spec-02-387a) | A tool row the provider started and never finished is interrupted, with its output kept, when the turn completes.  | not written yet (#387) |
| [MUS-SPEC-02-387B](02-turns-streaming-and-queue.md#mus-spec-02-387b) | The same row is interrupted when the turn fails.  | not written yet (#387) |
| [MUS-SPEC-02-387C](02-turns-streaming-and-queue.md#mus-spec-02-387c) | A tool row left running when the app closed mid-turn is interrupted when Muster restarts.  | not written yet (#387) |
| [MUS-SPEC-02-473H](02-turns-streaming-and-queue.md#mus-spec-02-473h) | The no-promise rule is in Agent mode instructions and not in Ask or Plan. | [`agent-mode instructions forbid ending a turn on a promise`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-473J](02-turns-streaming-and-queue.md#mus-spec-02-473j) | A closing promise makes the run advanced or plan-only, never completed; ordinary endings stay completed. | [`liveness: a turn that ends promising to report back is not completed`](../../../packages/agent-app/tests/process-continuations.test.ts) |

### Tool rows when a turn ends

<a id="mus-spec-02-387a"></a>
#### MUS-SPEC-02-387A: A completed turn leaves no tool row running

- Precondition: A chat whose provider reports one command finished and one command started but never finished, then ends the turn as completed.
- Action: Send a message and wait for the turn to settle.
- Expected result: The finished command stays completed. The unfinished one is interrupted, reads Stopped, keeps its output and has a duration.
- Test: `packages/agent-app/tests/tool-rows-settle-387.test.ts::#387 a tool the provider never closed is shown as Stopped once a completed turn settles`
- Environment: Node test runner; the agent service with a fake provider and a temp data folder.
- Known gaps: A row of a provider that still has background work for the chat is left alone and not tested here.
- Evidence: UNVERIFIED

<a id="mus-spec-02-387b"></a>
#### MUS-SPEC-02-387B: A failed turn leaves no tool row running

- Precondition: A chat whose provider starts a command, never finishes it, and ends the turn as failed.
- Action: Send a message and wait for the turn to settle.
- Expected result: The unfinished command is interrupted and reads Stopped; the chat shows failed.
- Test: `packages/agent-app/tests/tool-rows-settle-387.test.ts::#387 a tool the provider never closed is shown as Stopped once a failed turn settles`
- Environment: Node test runner; the agent service with a fake provider and a temp data folder.
- Known gaps: A provider that throws instead of returning a result is not covered.
- Evidence: UNVERIFIED

<a id="mus-spec-02-387c"></a>
#### MUS-SPEC-02-387C: A tool row left running by a closed app is stopped on restart

- Precondition: The app closed while a turn was running a command; the chat and the command row are saved as running, next to a finished command.
- Action: Start the agent service on the same data folder.
- Expected result: The chat is interrupted. The running command row is interrupted and reads Stopped; the finished one stays completed.
- Test: `packages/agent-app/tests/tool-rows-settle-387.test.ts::#387 a tool row left running when Muster closed is Stopped after restart`
- Environment: Node test runner; the agent service and the store on a temp data folder.
- Known gaps: Does not check a provider that is still working in the background after the app restarts; nothing survives a restart.
- Evidence: UNVERIFIED

### Turns that end on a promise

<a id="mus-spec-02-473h"></a>
#### MUS-SPEC-02-473H: Agent mode tells the agent never to end a turn on a promise

- Precondition: Chats in Agent, Ask and Plan mode.
- Action: Build the run instructions for each.
- Expected result: Agent mode includes the rule "Never end a turn promising future work" that tells the agent to wait with a tool call, next to the keep-going rule. Ask and Plan do not.
- Test: `packages/agent-app/tests/process-continuations.test.ts::agent-mode instructions forbid ending a turn on a promise`
- Environment: Node test runner; no provider or network.
- Known gaps: Checks the instruction text only. It does not show a model obeying it.
- Evidence: UNVERIFIED

<a id="mus-spec-02-473j"></a>
#### MUS-SPEC-02-473J: A turn that ends on a promise is not counted as completed

- Precondition: Turns whose last paragraph promises to report back later, and turns that end with a result.
- Action: Classify each run, with some tool calls and then with none.
- Expected result: A promise ending counts as advanced with work and plan-only with none. A turn that merely mentions reporting earlier, or says a CI job will report, still counts as completed.
- Test: `packages/agent-app/tests/process-continuations.test.ts::liveness: a turn that ends promising to report back is not completed`
- Environment: Node test runner; no provider or network.
- Known gaps: A unit test of a text classifier, so wording it does not recognise is not caught.
- Evidence: UNVERIFIED
