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
| [MUS-SPEC-02-469A](02-turns-streaming-and-queue.md#mus-spec-02-469a) | In the composer, the draft the runtime hands back after a stopped run appears in the empty input. | [`a run stopped before dispatch brings its text back into the composer`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-469B](02-turns-streaming-and-queue.md#mus-spec-02-469b) | With the queue paused, Enter sends at once with no confirm sheet and does not clear the held messages. | [`a paused queue no longer asks to confirm a send: the message sends and held items stay queued`](../../../packages/agent-app/tests/composer-components.tsx) |

### After Stop

<a id="mus-spec-02-469a"></a>
#### MUS-SPEC-02-469A: The composer takes back a draft the runtime restored

- Precondition: The composer is empty and a run is going. The run then ends as interrupted (stopped before its message was sent) and the chat now carries the draft "do not lose me".
- Action: Deliver the updated chat to the composer.
- Expected result: The composer input shows "do not lose me", so the text is not lost.
- Test: `packages/agent-app/tests/composer-components.tsx::a run stopped before dispatch brings its text back into the composer`
- Environment: Node script with a fake DOM (linkedom); the real composer and store; no Electron.
- Known gaps: The fake DOM has no layout or real typing. The runtime side (the service saving the text as the draft) is covered by a test in codex-alignment.test.ts that also passes without this change, so it is not linked here.
- Evidence: UNVERIFIED

<a id="mus-spec-02-469b"></a>
#### MUS-SPEC-02-469B: A send while the queue is paused goes straight through

- Precondition: The queue is paused after a stop, one message is held, and the composer holds a new message.
- Action: Press Enter in the composer.
- Expected result: No "Send message?" sheet appears. The message is sent, and the composer never asks to clear the queue, so the held message is kept.
- Test: `packages/agent-app/tests/composer-components.tsx::a paused queue no longer asks to confirm a send: the message sends and held items stay queued`
- Environment: Node script with a fake DOM (linkedom); the real composer and store; no Electron.
- Known gaps: Does not show the held message running after the new one; the runtime test "Stop then send keeps the held queue" in codex-alignment.test.ts does, but it also passes without this change, so it is not linked here.
- Evidence: UNVERIFIED
