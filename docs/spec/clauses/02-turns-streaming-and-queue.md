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
| [MUS-SPEC-02-555A](02-turns-streaming-and-queue.md#mus-spec-02-555a) | After the message you were editing is sent and leaves the queue, Alt+Down on another queued message still sends a reorder request. | [`Alt+Down still reorders the queue after the message being edited has been sent`](../../../packages/agent-app/tests/queue-stale-edit-dom.tsx) |

### Editing a queued message

<a id="mus-spec-02-555a"></a>
#### MUS-SPEC-02-555A: A queued message that is sent while you edit it does not lock the queue

- Precondition: Three messages are queued. The first one is open in the queue editor. The runtime then sends it, so only two remain.
- Action: Press Alt+Down on the first remaining queued message.
- Expected result: The editor for the sent message is closed, and the queue sends one reorder request for the key press.
- Test: `packages/agent-app/tests/queue-stale-edit-dom.tsx::Alt+Down still reorders the queue after the message being edited has been sent`
- Environment: Real QueuedMessages component in a DOM suite (linkedom); fake app bridge; no network.
- Known gaps: The queue is fed by the test, not by a real running turn. It checks the reorder request, not the new order on screen.
- Evidence: UNVERIFIED
