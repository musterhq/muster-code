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
| [MUS-SPEC-02-567A](02-turns-streaming-and-queue.md#mus-spec-02-567a) | A command left running by the CLI is killed on Stop and the run settles as Stopped within 5 seconds. | [`Claude Code: Stop ends the commands the CLI started and the run settles`](../../../packages/agent-app/tests/adapter-process-tree.test.ts) |
| [MUS-SPEC-02-567B](02-turns-streaming-and-queue.md#mus-spec-02-567b) | A command left running by the OpenCode CLI is killed on Stop and the run settles as Stopped within 5 seconds. | [`OpenCode: Stop ends the commands the CLI started and the run settles`](../../../packages/agent-app/tests/adapter-process-tree.test.ts) |
| [MUS-SPEC-02-473H](02-turns-streaming-and-queue.md#mus-spec-02-473h) | The no-promise rule is in Agent mode instructions and not in Ask or Plan. | [`agent-mode instructions forbid ending a turn on a promise`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-473J](02-turns-streaming-and-queue.md#mus-spec-02-473j) | A closing promise makes the run advanced or plan-only, never completed; ordinary endings stay completed. | [`liveness: a turn that ends promising to report back is not completed`](../../../packages/agent-app/tests/process-continuations.test.ts) |

### Stopping CLI agents

<a id="mus-spec-02-567a"></a>
#### MUS-SPEC-02-567A: Stop ends the commands a Claude Code chat started

- Precondition: A Claude Code chat is running a CLI that started a long command (`sleep 30`) which holds the output pipe open.
- Action: Press Stop.
- Expected result: The run settles with "Stopped." within 5 seconds and the long command is no longer running.
- Test: `packages/agent-app/tests/adapter-process-tree.test.ts::Claude Code: Stop ends the commands the CLI started and the run settles`
- Environment: Node test runner; no network, no provider. POSIX only (process groups); the test skips itself on Windows. Uses a small shell script as the CLI.
- Known gaps: Uses a fake CLI script, not the real Claude Code. Not run on Windows.
- Evidence: UNVERIFIED

<a id="mus-spec-02-567b"></a>
#### MUS-SPEC-02-567B: Stop ends the commands an OpenCode chat started

- Precondition: An OpenCode chat is running a CLI that started a long command (`sleep 30`) which holds the output pipe open.
- Action: Press Stop.
- Expected result: The run settles with "Stopped." within 5 seconds and the long command is no longer running.
- Test: `packages/agent-app/tests/adapter-process-tree.test.ts::OpenCode: Stop ends the commands the CLI started and the run settles`
- Environment: Node test runner; no network, no provider. POSIX only (process groups); the test skips itself on Windows. Uses a small shell script as the CLI.
- Known gaps: Uses a fake CLI script, not the real OpenCode. Not run on Windows.
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
