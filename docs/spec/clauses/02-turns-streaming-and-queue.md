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
