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
| [MUS-SPEC-02-569A](02-turns-streaming-and-queue.md#mus-spec-02-569a) | 2000 streamed pieces in one burst end up as the full text with a timeline revision below 50. | [`2000 deltas in one burst are stored with a handful of writes, and the final text is complete`](../../../packages/agent-app/tests/stream-write-cost.test.ts) |

### Streaming cost

<a id="mus-spec-02-569a"></a>
#### MUS-SPEC-02-569A: A streamed reply is saved in a few writes, not one per token

- Precondition: A chat whose provider streams 2000 small pieces of text in one burst.
- Action: Send a message and wait for the turn to complete.
- Expected result: The saved reply is the whole text, completed, and the timeline revision stays under 50 (one write per piece would pass 2000).
- Test: `packages/agent-app/tests/stream-write-cost.test.ts::2000 deltas in one burst are stored with a handful of writes, and the final text is complete`
- Environment: Node test runner; no network, no provider. Real agent service with a fake provider and a temp data folder.
- Known gaps: Counts writes by the timeline revision, not time. The "about a third of the time" figure for 20 chats of 600 KB is from the author's run and is not tested.
- Evidence: UNVERIFIED
