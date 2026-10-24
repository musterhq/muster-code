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

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-02-387A](02-turns-streaming-and-queue.md#mus-spec-02-387a) | A tool row the provider started and never finished is interrupted, with its output kept, when the turn completes.  | not written yet (#387) |
| [MUS-SPEC-02-387B](02-turns-streaming-and-queue.md#mus-spec-02-387b) | The same row is interrupted when the turn fails.  | not written yet (#387) |
| [MUS-SPEC-02-387C](02-turns-streaming-and-queue.md#mus-spec-02-387c) | A tool row left running when the app closed mid-turn is interrupted when Muster restarts.  | not written yet (#387) |

### Tool rows when a turn ends

<a id="mus-spec-02-387a"></a>
#### MUS-SPEC-02-387A: A completed turn leaves no tool row running

- Precondition: A chat whose provider reports one command finished and one command started but never finished, then ends the turn as completed.
- Action: Send a message and wait for the turn to settle.
- Expected result: The finished command stays completed. The unfinished one is interrupted, reads Stopped, keeps its output and has a duration.
- Test: not written yet (#387)
- Environment: Node test runner; the agent service with a fake provider and a temp data folder.
- Known gaps: A row of a provider that still has background work for the chat is left alone and not tested here.
- Evidence: UNVERIFIED

<a id="mus-spec-02-387b"></a>
#### MUS-SPEC-02-387B: A failed turn leaves no tool row running

- Precondition: A chat whose provider starts a command, never finishes it, and ends the turn as failed.
- Action: Send a message and wait for the turn to settle.
- Expected result: The unfinished command is interrupted and reads Stopped; the chat shows failed.
- Test: not written yet (#387)
- Environment: Node test runner; the agent service with a fake provider and a temp data folder.
- Known gaps: A provider that throws instead of returning a result is not covered.
- Evidence: UNVERIFIED

<a id="mus-spec-02-387c"></a>
#### MUS-SPEC-02-387C: A tool row left running by a closed app is stopped on restart

- Precondition: The app closed while a turn was running a command; the chat and the command row are saved as running.
- Action: Start the agent service on the same data folder.
- Expected result: The chat is interrupted and the command row is interrupted and reads Stopped.
- Test: not written yet (#387)
- Environment: Node test runner; the agent service and the store on a temp data folder.
- Known gaps: Rows in chats that were not running when the app closed are not touched.
- Evidence: UNVERIFIED
