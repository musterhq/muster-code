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
| [MUS-SPEC-02-478A](02-turns-streaming-and-queue.md#mus-spec-02-478a) | The steer is wrapped in a note that says to fold the message in, continue the current task and not stop after acknowledging it, and it ends with the user's words. | [`Claude Code: a steer tells the model to continue the current task, and the run stays open until the work after it ends`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478B](02-turns-streaming-and-queue.md#mus-spec-02-478b) | An accepted steer reaches the closing request at the tool-call cap; a steer written during the closing status, or after the run, is refused so it queues. | [`HTTP route: at the turn’s tool-call cap, accepted steers reach the closing request and later ones are refused`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478C](02-turns-streaming-and-queue.md#mus-spec-02-478c) | A failed steer and a failed fallback return a refusal that names the error, so the message queues and shows why. | [`Codex: when the fallback steer throws, the reason comes back and the message is not reported as steered`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478D](02-turns-streaming-and-queue.md#mus-spec-02-478d) | A "socket hang up" steer returns a refusal with the reason; "no active turn" returns false so the message queues quietly. | [`Codex: a transport error with no fallback is surfaced too; "no active turn" still queues quietly`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478E](02-turns-streaming-and-queue.md#mus-spec-02-478e) | The steer returns a refusal that names the first error ("expected turn mismatch"), not a silent false. | [`Codex: a fallback that answers false after a failed steer reports the first error`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478F](02-turns-streaming-and-queue.md#mus-spec-02-478f) | With nothing stored the setting is Steer; Enter steers, a refused steer queues the message with a reason, and the draft clears. | [`while a run goes, Enter steers by default and a refused steer falls back to the queue`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-478G](02-turns-streaming-and-queue.md#mus-spec-02-478g) | Cmd+Enter queues the message and sends no steer for it. | [`Cmd+Enter while a run goes queues the message instead of steering`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-473H](02-turns-streaming-and-queue.md#mus-spec-02-473h) | The no-promise rule is in Agent mode instructions and not in Ask or Plan. | [`agent-mode instructions forbid ending a turn on a promise`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-473J](02-turns-streaming-and-queue.md#mus-spec-02-473j) | A closing promise makes the run advanced or plan-only, never completed; ordinary endings stay completed. | [`liveness: a turn that ends promising to report back is not completed`](../../../packages/agent-app/tests/process-continuations.test.ts) |

### Steering a running turn

<a id="mus-spec-02-478a"></a>
#### MUS-SPEC-02-478A: A steer to Claude Code tells the model to carry on

- Precondition: A Claude Code run is going and has started to work.
- Action: Send a steer ("use blue, not red"). Then the steer's result arrives and more work follows.
- Expected result: The steer is wrapped in a note that says to fold the message in, continue the current task and not stop after acknowledging it, and it ends with the user's words. The run stays open through the work that follows the steer's result, and finishes with the last result.
- Test: `packages/agent-app/tests/steer-default.test.ts::Claude Code: a steer tells the model to continue the current task, and the run stays open until the work after it ends`
- Environment: Node test runner; the real Claude Code adapter with a fake process; no network.
- Known gaps: A fake process stands in for the CLI, so it does not show a real model following the note.
- Evidence: UNVERIFIED

<a id="mus-spec-02-478b"></a>
#### MUS-SPEC-02-478B: At the tool-call limit, an accepted steer is read and a later one is refused

- Precondition: A model-router run is on its last allowed round of tool calls.
- Action: Send a steer during that last round, then try another steer while the closing status is written, then one more after the run.
- Expected result: The steer sent during the last round is accepted and is in the closing request. The steer sent while the closing status is written is refused, so it goes to the queue instead of being lost. A steer after the run is refused too.
- Test: `packages/agent-app/tests/steer-default.test.ts::HTTP route: at the turn’s tool-call cap, accepted steers reach the closing request and later ones are refused`
- Environment: Node test runner; the real HTTP adapter with a fake fetch; no network.
- Known gaps: Shows the round cap with 63 rounds of 16 tool calls; the other limits (time) use the same closing step.
- Evidence: UNVERIFIED

<a id="mus-spec-02-478c"></a>
#### MUS-SPEC-02-478C: A failed steer on Codex gives a reason, so the message queues

- Precondition: A Codex run is going and the first steer call fails.
- Action: Steer the run while the fallback steer call also fails with "app-server connection closed".
- Expected result: The steer returns a refusal that says the agent could not take the message mid-run and names the error. It is not reported as steered, so the composer queues it and shows the reason.
- Test: `packages/agent-app/tests/steer-default.test.ts::Codex: when the fallback steer throws, the reason comes back and the message is not reported as steered`
- Environment: Node test runner; the real provider adapter with a fake Codex client; no network.
- Known gaps: A fake client stands in for the Codex app server.
- Evidence: UNVERIFIED

<a id="mus-spec-02-478d"></a>
#### MUS-SPEC-02-478D: A Codex transport error is shown; "no active turn" still queues quietly

- Precondition: A Codex run is going and the steer call fails, with no fallback steer available.
- Action: Steer with a "socket hang up" error, then steer with a "no active turn" error.
- Expected result: The "socket hang up" steer returns a refusal with the reason. The "no active turn" steer returns false, so the message queues with no error shown.
- Test: `packages/agent-app/tests/steer-default.test.ts::Codex: a transport error with no fallback is surfaced too; "no active turn" still queues quietly`
- Environment: Node test runner; the real provider adapter with a fake Codex client; no network.
- Known gaps: A fake client stands in for the Codex app server.
- Evidence: UNVERIFIED

<a id="mus-spec-02-478e"></a>
#### MUS-SPEC-02-478E: When the fallback steer says no, the first error is reported

- Precondition: A Codex run is going. The first steer fails with "expected turn mismatch" and the fallback steer answers false.
- Action: Steer the run.
- Expected result: The steer returns a refusal that names the first error ("expected turn mismatch"), not a silent false.
- Test: `packages/agent-app/tests/steer-default.test.ts::Codex: a fallback that answers false after a failed steer reports the first error`
- Environment: Node test runner; the real provider adapter with a fake Codex client; no network.
- Known gaps: A fake client stands in for the Codex app server.
- Evidence: UNVERIFIED

<a id="mus-spec-02-478f"></a>
#### MUS-SPEC-02-478F: Enter during a run steers by default and falls back to the queue

- Precondition: A chat is running, with nothing stored for the Enter setting, and the draft is "follow up".
- Action: Press Enter in the composer. The steer is refused.
- Expected result: The setting reads Steer and the send button reads "Steer (Enter) · Queue ⌘Enter". Enter calls steer with the draft. When the steer is refused the message is queued, the status says why, the draft clears and the queued row shows at once.
- Test: `packages/agent-app/tests/composer-components.tsx::while a run goes, Enter steers by default and a refused steer falls back to the queue`
- Environment: Node script with a fake DOM (linkedom); the real composer and store; no Electron.
- Known gaps: The fake DOM has no real keyboard or layout. The steer refusal is faked by the test host.
- Evidence: UNVERIFIED

<a id="mus-spec-02-478g"></a>
#### MUS-SPEC-02-478G: Cmd+Enter during a run queues instead of steering

- Precondition: A chat is running with the default (Steer) setting, and the draft is "queue me".
- Action: Press Cmd+Enter in the composer.
- Expected result: The message is queued and no steer is sent for it.
- Test: `packages/agent-app/tests/composer-components.tsx::Cmd+Enter while a run goes queues the message instead of steering`
- Environment: Node script with a fake DOM (linkedom); the real composer and store; no Electron.
- Known gaps: The fake DOM has no real keyboard or layout.
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
