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
| [MUS-SPEC-02-473H](02-turns-streaming-and-queue.md#mus-spec-02-473h) | The no-promise rule is in Agent mode instructions and not in Ask or Plan. | [`agent-mode instructions forbid ending a turn on a promise`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-473J](02-turns-streaming-and-queue.md#mus-spec-02-473j) | A closing promise makes the run advanced or plan-only, never completed; ordinary endings stay completed. | [`liveness: a turn that ends promising to report back is not completed`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-579A](02-turns-streaming-and-queue.md#mus-spec-02-579a) | After a crash, Continue anyway and then Steer on a queued message send it once; the app-server's saved copy is deleted, so it does not send it again when the thread goes idle. | [`a message queued before a crash is sent once after Continue anyway and Steer`](../../../packages/agent-app/tests/queue-after-crash-579.test.ts) |

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

### A queued message after a crash

<a id="mus-spec-02-579a"></a>
#### MUS-SPEC-02-579A: A message queued during a turn that crashed is sent once after Continue anyway and Steer

- Precondition: A Codex chat has a running turn and one follow-up queued while it ran; the follow-up is held by the app-server's own queue. Muster is killed without closing and relaunched over the same data folder, so the chat shows "May still be running at the provider" with the follow-up still queued.
- Action: Click Continue anyway, then Steer on the queued message. Then the thread goes idle and the app-server starts whatever it still holds for it.
- Expected result: The provider receives the queued text exactly once, the transcript has one copy of it, and the queue is empty. The app-server's saved copy was deleted as soon as the session came back, so it is not sent a second time.
- Test: `packages/agent-app/tests/queue-after-crash-579.test.ts::a message queued before a crash is sent once after Continue anyway and Steer`
- Environment: Node test runner; the agent service with a fake Codex-style provider that keeps its saved queue across a relaunch and sends it when the thread goes idle; no network.
- Known gaps: The fake app-server models the real one's queue persistence and idle send from its documented methods, not from a live Codex. A provider that keeps no queue of its own never double-sends, and Continue anyway then Steer on it already sent once.
- Evidence: UNVERIFIED
