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
| [MUS-SPEC-02-398A](02-turns-streaming-and-queue.md#mus-spec-02-398a) | The header reads Worked for 26s. | [`an imported turn displays its work duration without the import gap`](../../../packages/agent-app/tests/ui-sweep-dom.tsx) |
| [MUS-SPEC-02-387A](02-turns-streaming-and-queue.md#mus-spec-02-387a) | A tool row the provider started and never finished is interrupted, with its output kept, when the turn completes. | [`#387 a tool the provider never closed is shown as Stopped once a completed turn settles`](../../../packages/agent-app/tests/tool-rows-settle-387.test.ts) |
| [MUS-SPEC-02-387B](02-turns-streaming-and-queue.md#mus-spec-02-387b) | The same row is interrupted when the turn fails. | [`#387 a tool the provider never closed is shown as Stopped once a failed turn settles`](../../../packages/agent-app/tests/tool-rows-settle-387.test.ts) |
| [MUS-SPEC-02-387C](02-turns-streaming-and-queue.md#mus-spec-02-387c) | A tool row left running when the app closed mid-turn is interrupted when Muster restarts. | [`#387 a tool row left running when Muster closed is Stopped after restart`](../../../packages/agent-app/tests/tool-rows-settle-387.test.ts) |
| [MUS-SPEC-02-473H](02-turns-streaming-and-queue.md#mus-spec-02-473h) | The no-promise rule is in Agent mode instructions and not in Ask or Plan. | [`agent-mode instructions forbid ending a turn on a promise`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-473J](02-turns-streaming-and-queue.md#mus-spec-02-473j) | A closing promise makes the run advanced or plan-only, never completed; ordinary endings stay completed. | [`liveness: a turn that ends promising to report back is not completed`](../../../packages/agent-app/tests/process-continuations.test.ts) |
| [MUS-SPEC-02-469A](02-turns-streaming-and-queue.md#mus-spec-02-469a) | In the composer, the draft the runtime hands back after a stopped run appears in the empty input. | [`a run stopped before dispatch brings its text back into the composer`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-469B](02-turns-streaming-and-queue.md#mus-spec-02-469b) | With the queue paused, Enter sends at once with no confirm sheet and does not clear the held messages. | [`a paused queue no longer asks to confirm a send: the message sends and held items stay queued`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-479A](02-turns-streaming-and-queue.md#mus-spec-02-479a) | Muster tells a usage limit or a rate limit from other errors and finds when it resets: from the usage windows, then the provider's own words, then a backoff. | [`limits are classified and the reset time is read from usage windows, the provider’s words, or a backoff`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479B](02-turns-streaming-and-queue.md#mus-spec-02-479b) | After a usage limit, the chat reads Limited, the queue waits, and at the reset time the same turn continues and then the queued messages follow in order. | [`a usage limit shows Limited with its reset, queued messages wait, and the turn continues at reset in order`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479C](02-turns-streaming-and-queue.md#mus-spec-02-479c) | If the provider refuses a message with a usage limit before the turn starts, the message is not put back in the composer; it waits and runs at reset. | [`a limited turn that never started waits as Limited without handing its prompt back as a draft, then re-runs it at reset`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479D](02-turns-streaming-and-queue.md#mus-spec-02-479d) | If the provider is still limited at reset, Muster backs off and tries again a bounded number of times, then stops with one notice. | [`a provider that still refuses backs off, says so once, and gives up instead of looping`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479E](02-turns-streaming-and-queue.md#mus-spec-02-479e) | The user can turn off the automatic continue for one chat, or for all chats in Settings. | [`Don’t resume and the Settings switch keep the chat Limited without continuing`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479F](02-turns-streaming-and-queue.md#mus-spec-02-479f) | The resume time of a Limited chat is saved, so a restart does not lose it. | [`a stored resume survives an app restart and is re-armed at launch`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479G](02-turns-streaming-and-queue.md#mus-spec-02-479g) | A chat can have a fallback list; it is off by default. When the chat hits a limit it moves to the next fallback. | [`an opt-in fallback model continues a limited chat at once`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479H](02-turns-streaming-and-queue.md#mus-spec-02-479h) | At launch, chats that were working when Muster crashed continue, except the ones waiting on an approval or being stopped. | [`chats working when Muster crashed continue: native sessions resume, HTTP routes get the message, approvals are left alone`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479I](02-turns-streaming-and-queue.md#mus-spec-02-479i) | Quitting Muster during a turn keeps the turn as interrupted by the quit, and the next launch continues it one time. | [`a quit keeps the live turn and continues it after launch, once; the setting turns it off`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479J](02-turns-streaming-and-queue.md#mus-spec-02-479j) | Queued messages stay saved across a quit, with their files and settings, and each is sent once. | [`the queue survives a quit in order with its files and chips, sends each message once, and drops one already sent`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479K](02-turns-streaming-and-queue.md#mus-spec-02-479k) | A tool row left spinning by a stop or a quit is settled, so it does not spin forever. | [`tool rows left running settle as interrupted on stop and at launch`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479M](02-turns-streaming-and-queue.md#mus-spec-02-479m) | A queued message stays in the queue until its send receipt is saved, so a quit in the middle of sending it does not lose it. | [`#450: a queued message whose dispatch was cut short by a quit is sent once at the next launch`](../../../packages/agent-app/tests/auto-resume.test.ts) |
| [MUS-SPEC-02-479N](02-turns-streaming-and-queue.md#mus-spec-02-479n) | After the automatic retries run out, the chat waits for the limit and re-runs its own prompt, so the prompt is not also put back as a draft. | [`chat.stop cancels a pending retry; exhausted retries keep the admission recovery`](../../../packages/agent-app/tests/admission-retry.test.ts) |
| [MUS-SPEC-02-479O](02-turns-streaming-and-queue.md#mus-spec-02-479o) | A provider failure before the message was delivered is retried up to five times with waits of 1, 2, 4, 8 and 16 seconds. | [`a never-dispatched provider failure is retried automatically, bounded`](../../../packages/agent-app/tests/dogfood-runtime-fixes.test.ts) |
| [MUS-SPEC-02-479P](02-turns-streaming-and-queue.md#mus-spec-02-479p) | The status shown in the header and sidebar says Limited while a resume is pending. | [`a limited chat reads Limited in the header, the sidebar dot and the status view, and a running or given-up chat does not`](../../../packages/agent-app/tests/limit-resume-dom.tsx) |
| [MUS-SPEC-02-479Q](02-turns-streaming-and-queue.md#mus-spec-02-479q) | The chat's notice row says when the limit resets, what Muster will do then, and lets the user choose Resume at reset or Don't resume. | [`the notice row shows the reset time, what happens then, and Resume at reset or Don’t resume for this chat`](../../../packages/agent-app/tests/limit-resume-dom.tsx) |
| [MUS-SPEC-02-479R](02-turns-streaming-and-queue.md#mus-spec-02-479r) | The notice row words a rate limit differently from a usage limit, and says plainly when Muster gave up. | [`a rate limit and a gave-up chat each say so in their own words`](../../../packages/agent-app/tests/limit-resume-dom.tsx) |
| [MUS-SPEC-02-479S](02-turns-streaming-and-queue.md#mus-spec-02-479s) | The Limited row has a fallback model picker that starts with no fallback. | [`the fallback model is off by default and choosing one is saved for the chat`](../../../packages/agent-app/tests/limit-resume-dom.tsx) |
| [MUS-SPEC-02-479T](02-turns-streaming-and-queue.md#mus-spec-02-479t) | The limit row appears only while the chat is Limited, and the queue explains that it waits. | [`a running chat shows no limit row, and the queue says it waits for the usage limit to reset`](../../../packages/agent-app/tests/limit-resume-dom.tsx) |
| [MUS-SPEC-02-479U](02-turns-streaming-and-queue.md#mus-spec-02-479u) | Settings › General lets the user turn off continuing after a limit and continuing after a restart. | [`Settings › General has both continue switches, on by default, and they save through settings.set`](../../../packages/agent-app/tests/limit-resume-dom.tsx) |
| [MUS-SPEC-02-567A](02-turns-streaming-and-queue.md#mus-spec-02-567a) | A command left running by the CLI is killed on Stop and the run settles as Stopped within 5 seconds. | [`Claude Code: Stop ends the commands the CLI started and the run settles`](../../../packages/agent-app/tests/adapter-process-tree.test.ts) |
| [MUS-SPEC-02-567B](02-turns-streaming-and-queue.md#mus-spec-02-567b) | A command left running by the OpenCode CLI is killed on Stop and the run settles as Stopped within 5 seconds. | [`OpenCode: Stop ends the commands the CLI started and the run settles`](../../../packages/agent-app/tests/adapter-process-tree.test.ts) |
| [MUS-SPEC-02-478A](02-turns-streaming-and-queue.md#mus-spec-02-478a) | The steer is wrapped in a note that says to fold the message in, continue the current task and not stop after acknowledging it, and it ends with the user's words. | [`Claude Code: a steer tells the model to continue the current task, and the run stays open until the work after it ends`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478B](02-turns-streaming-and-queue.md#mus-spec-02-478b) | An accepted steer reaches the closing request at the tool-call cap; a steer written during the closing status, or after the run, is refused so it queues. | [`HTTP route: at the turn’s tool-call cap, accepted steers reach the closing request and later ones are refused`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478C](02-turns-streaming-and-queue.md#mus-spec-02-478c) | A failed steer and a failed fallback return a refusal that names the error, so the message queues and shows why. | [`Codex: when the fallback steer throws, the reason comes back and the message is not reported as steered`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478D](02-turns-streaming-and-queue.md#mus-spec-02-478d) | A "socket hang up" steer returns a refusal with the reason; "no active turn" returns false so the message queues quietly. | [`Codex: a transport error with no fallback is surfaced too; "no active turn" still queues quietly`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478E](02-turns-streaming-and-queue.md#mus-spec-02-478e) | The steer returns a refusal that names the first error ("expected turn mismatch"), not a silent false. | [`Codex: a fallback that answers false after a failed steer reports the first error`](../../../packages/agent-app/tests/steer-default.test.ts) |
| [MUS-SPEC-02-478F](02-turns-streaming-and-queue.md#mus-spec-02-478f) | With nothing stored the setting is Steer; Enter steers, a refused steer queues the message with a reason, and the draft clears. | [`while a run goes, Enter steers by default and a refused steer falls back to the queue`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-478G](02-turns-streaming-and-queue.md#mus-spec-02-478g) | Cmd+Enter queues the message and sends no steer for it. | [`Cmd+Enter while a run goes queues the message instead of steering`](../../../packages/agent-app/tests/composer-components.tsx) |
| [MUS-SPEC-02-555A](02-turns-streaming-and-queue.md#mus-spec-02-555a) | After the message you were editing is sent and leaves the queue, Alt+Down on another queued message still sends a reorder request. | [`Alt+Down still reorders the queue after the message being edited has been sent`](../../../packages/agent-app/tests/queue-stale-edit-dom.tsx) |
| [MUS-SPEC-02-476A](02-turns-streaming-and-queue.md#mus-spec-02-476a) | The agent asks a question without stopping: the tool answers at once with the default, a question card appears, and the run is not paused. | [`ask_user returns at once with the default, posts a non-blocking question card, and the run keeps going`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476B](02-turns-streaming-and-queue.md#mus-spec-02-476b) | A question with no default or no question text is refused. | [`ask_user without a default or question is refused, and no card is posted`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476C](02-turns-streaming-and-queue.md#mus-spec-02-476c) | An answer given while the run goes steers the run, once. | [`an answer while the run is going is delivered as a steer; answering twice is a no-op`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476D](02-turns-streaming-and-queue.md#mus-spec-02-476d) | An answer after the run ended starts the next turn. | [`an answer after the run ended is queued and starts the next turn`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476E](02-turns-streaming-and-queue.md#mus-spec-02-476e) | On a route that cannot steer, the answer becomes the next turn. | [`a route that cannot steer gets the answer as the next turn`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476F](02-turns-streaming-and-queue.md#mus-spec-02-476f) | Dismissing the card sends nothing. | [`dismissing an ask_user card delivers nothing; the agent keeps its default`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476G](02-turns-streaming-and-queue.md#mus-spec-02-476g) | The question tool never asks for approval. | [`the muster_ask server never raises an approval card, in any access mode`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476H](02-turns-streaming-and-queue.md#mus-spec-02-476h) | Command-line routes are given the question tool. | [`CLI routes get the muster_ask MCP server when the tool host runs`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476I](02-turns-streaming-and-queue.md#mus-spec-02-476i) | Model-router routes get ask_user as a built-in tool at every access level. | [`HTTP routes: ask_user is a native tool at every access level and returns at once`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-476J](02-turns-streaming-and-queue.md#mus-spec-02-476j) | Agent mode tells the model to use ask_user instead of ending the turn. | [`agent instructions prefer ask_user over ending the turn to ask (agent mode only)`](../../../packages/agent-app/tests/ask-user-nonblocking.test.ts) |
| [MUS-SPEC-02-569A](02-turns-streaming-and-queue.md#mus-spec-02-569a) | 2000 streamed pieces in one burst end up as the full text with a timeline revision below 50. | [`2000 deltas in one burst are stored with a handful of writes, and the final text is complete`](../../../packages/agent-app/tests/stream-write-cost.test.ts) |
| [MUS-SPEC-02-608A](02-turns-streaming-and-queue.md#mus-spec-02-608a) | After three failed reconnects the turn stops in under 200ms as failed and retryable, with the HTTPS proxy named and no credentials; later events add nothing, and a new run on the same adapter completes. | [`failing transport stops after three reconnect failures, explains proxy and allows manual retry`](../../../packages/agent-app/tests/network-reconnect.test.ts) |
| [MUS-SPEC-02-608B](02-turns-streaming-and-queue.md#mus-spec-02-608b) | A reconnect that stalls after one failure is stopped when the reconnect time limit passes, with the proxy named. | [`stalled reconnect stops by deadline without further transport events`](../../../packages/agent-app/tests/network-reconnect.test.ts) |
| [MUS-SPEC-02-608C](02-turns-streaming-and-queue.md#mus-spec-02-608c) | A failed web request to a model gives a plain cause for a proxy, DNS, certificate or refused connection, marks the turn as not sent, and never shows the user name or password in the address. | [`HTTP fetch failures explain nested proxy, DNS, TLS and refused causes without credentials`](../../../packages/agent-app/tests/network-reconnect.test.ts) |
| [MUS-SPEC-02-608D](02-turns-streaming-and-queue.md#mus-spec-02-608d) | The failure banner for a network error shows Retry even with an empty draft, runs the turn retry once per click with a busy state, and never sends the text in the composer instead. | [`a failed network turn offers Retry, which re-runs the turn and never sends the draft in its place`](../../../packages/agent-app/tests/recovery-notice.tsx) |
| [MUS-SPEC-02-579A](02-turns-streaming-and-queue.md#mus-spec-02-579a) | After a crash, Continue anyway and then Steer on a queued message send it once; the app-server's saved copy is deleted, so it does not send it again when the thread goes idle. | [`a message queued before a crash is sent once after Continue anyway and Steer`](../../../packages/agent-app/tests/queue-after-crash-579.test.ts) |

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

### Usage limits

<a id="mus-spec-02-479a"></a>
#### MUS-SPEC-02-479A: A usage limit is told apart from other errors, and its reset time is read from the best source

- Precondition: Error texts from providers, and usage windows where the five-hour window is full and the weekly one is half used.
- Action: Classify each text and work out the reset time.
- Expected result: Usage limits and rate limits are recognised (429 and 503 count as rate limits); a context-length error and "permission denied" are not. A reset is read from "try again in 2 hours 5 minutes", "resets in 12 min", a unix time, an ISO time, Retry-After and a clock time like "resets 3pm". The full window decides over the half-used one. If a provider is refused again at its reset time, its word is not trusted twice and a backoff is used. A rate limit retries sooner than a usage window, and Codex and Claude Code sessions resume natively while an HTTP route does not.
- Test: `packages/agent-app/tests/auto-resume.test.ts::limits are classified and the reset time is read from usage windows, the provider’s words, or a backoff`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the helpers directly, not through a running chat.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479b"></a>
#### MUS-SPEC-02-479B: A chat that hits a usage limit shows Limited, then continues at reset and sends the queue in order

- Precondition: A chat is running and has two queued messages. The provider then fails with "usage limit, try again in 1 seconds".
- Action: Wait for the reset time.
- Expected result: The chat has a resume time (taken from the provider's words), reads Limited and has its queue paused as "limited". Nothing is sent early. At reset the same thread gets "Continue from where you stopped.", then the two queued messages run in order, each once. The chat ends completed with no resume left and an empty queue.
- Test: `packages/agent-app/tests/auto-resume.test.ts::a usage limit shows Limited with its reset, queued messages wait, and the turn continues at reset in order`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: Short timers replace the real hours of waiting.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479c"></a>
#### MUS-SPEC-02-479C: A limited turn that never started waits and re-runs its own prompt

- Precondition: The provider refuses the first message with a usage limit before it starts.
- Action: Wait for the reset time.
- Expected result: The chat waits as Limited and the draft stays empty (the message would otherwise be sent twice). At reset the original prompt runs once, and the transcript holds one copy of the user message.
- Test: `packages/agent-app/tests/auto-resume.test.ts::a limited turn that never started waits as Limited without handing its prompt back as a draft, then re-runs it at reset`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479d"></a>
#### MUS-SPEC-02-479D: A provider that keeps refusing is retried a few times, then Muster stops

- Precondition: The provider answers every run with a usage limit.
- Action: Send a message and wait.
- Expected result: There is the first run plus three automatic continuations, and each continuation is the "Continue" message. There is one notice line, updated in place, that says Muster stopped continuing. The chat no longer reads as waiting, and no more runs start afterwards.
- Test: `packages/agent-app/tests/auto-resume.test.ts::a provider that still refuses backs off, says so once, and gives up instead of looping`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479e"></a>
#### MUS-SPEC-02-479E: Don't resume and the Settings switch stop the automatic continue

- Precondition: A chat is Limited with a resume pending.
- Action: Choose Don't resume for the chat. Then turn the Settings switch off and hit another limit.
- Expected result: With Don't resume the chat does not continue at reset. With the setting off, a new limit makes Don't resume the default for that chat and nothing continues.
- Test: `packages/agent-app/tests/auto-resume.test.ts::Don’t resume and the Settings switch keep the chat Limited without continuing`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479f"></a>
#### MUS-SPEC-02-479F: A pending resume survives a restart

- Precondition: A chat is Limited with a resume an hour away. Muster quits, and the saved resume time is moved closer.
- Action: Start Muster again with a new service on the same data folder.
- Expected result: The chat is still Limited with resume on. When the time comes, it continues with the "Continue" message.
- Test: `packages/agent-app/tests/auto-resume.test.ts::a stored resume survives an app restart and is re-armed at launch`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: Edits the saved time in the database to avoid a real hour of waiting.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479g"></a>
#### MUS-SPEC-02-479G: A fallback model lets a Limited chat carry on at once

- Precondition: A chat has a fallback provider and model set, and the first provider answers with a usage limit.
- Action: Send a message.
- Expected result: The chat continues straight away on the fallback provider as a fresh conversation (no old thread id), with the earlier conversation as a summary and the "Continue" message. A timeline note says it switched to a fallback. Before it is set, the list is empty.
- Test: `packages/agent-app/tests/auto-resume.test.ts::an opt-in fallback model continues a limited chat at once`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479n"></a>
#### MUS-SPEC-02-479N: When the provider stays unavailable after the retries, the chat waits as rate limited and does not also hand the prompt back

- Precondition: A message is refused as not delivered, again and again, until the retries are used up.
- Action: Send a message and let the retries run out.
- Expected result: The chat is failed with the "after 5 automatic retries" reason, the draft is empty, and the chat has a resume pending for a rate limit.
- Test: `packages/agent-app/tests/admission-retry.test.ts::chat.stop cancels a pending retry; exhausted retries keep the admission recovery`
- Environment: Node test runner; the real agent service with a fake provider and mocked timers.
- Known gaps: The same test also checks that Stop cancels a pending retry; that part does not depend on this change.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479o"></a>
#### MUS-SPEC-02-479O: A failure before the message was sent is retried five times, doubling the wait

- Precondition: The provider fails five times in a row before delivering.
- Action: Run the retry helper with the timers mocked.
- Expected result: It makes the first call plus five retries, then gives up with a failed result. The waits are 1000, 2000, 4000, 8000 and 16000 ms.
- Test: `packages/agent-app/tests/dogfood-runtime-fixes.test.ts::a never-dispatched provider failure is retried automatically, bounded`
- Environment: Node test runner; mocked timers; no network.
- Known gaps: Calls the retry helper directly, not through a chat.
- Evidence: UNVERIFIED

### Restart and crash

<a id="mus-spec-02-479h"></a>
#### MUS-SPEC-02-479H: After a crash, working chats continue; chats waiting on you do not

- Precondition: The data folder holds a Claude Code chat with a session, an HTTP-route chat, a chat with a pending approval and a chat being stopped, all marked running.
- Action: Start Muster.
- Expected result: Only two chats continue. The Claude Code chat resumes its session with "Continue from where you stopped.", and the HTTP chat gets the restart message. The chat with the approval stays interrupted and the stopping one is not continued.
- Test: `packages/agent-app/tests/auto-resume.test.ts::chats working when Muster crashed continue: native sessions resume, HTTP routes get the message, approvals are left alone`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479i"></a>
#### MUS-SPEC-02-479I: A quit is not a Stop: the turn continues at the next launch, once

- Precondition: A turn is running and Muster quits. It then quits again during the continuation.
- Action: Start Muster again each time. Then turn the restart setting off, send a message and quit.
- Expected result: The first quit says "Muster quit while this was working. It continues when Muster starts again." and never says Stopped. The next launch continues the same thread. A continuation that was itself cut short is not continued again. With the setting off nothing continues, and the chat says to send a message to continue.
- Test: `packages/agent-app/tests/auto-resume.test.ts::a quit keeps the live turn and continues it after launch, once; the setting turns it off`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479k"></a>
#### MUS-SPEC-02-479K: Tool rows that were still running become Interrupted

- Precondition: A saved chat has a tool row marked running. A new chat then runs a command, and the user presses Stop.
- Action: Start Muster, then stop the running chat.
- Expected result: The old row is Interrupted at launch. The stopped chat's tool row is Interrupted too.
- Test: `packages/agent-app/tests/auto-resume.test.ts::tool rows left running settle as interrupted on stop and at launch`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

### The durable queue

<a id="mus-spec-02-479j"></a>
#### MUS-SPEC-02-479J: The queue survives a quit in order and nothing is sent twice

- Precondition: Three messages are queued during a turn (one with a file and a high effort). Muster quits. One of them already has a send receipt.
- Action: Start Muster again.
- Expected result: The queue still holds the three messages in order with the file. After launch the interrupted turn continues first, then the first queued message with its file, then the second. The one with a receipt is dropped and never sent again, and the queue ends empty.
- Test: `packages/agent-app/tests/auto-resume.test.ts::the queue survives a quit in order with its files and chips, sends each message once, and drops one already sent`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479m"></a>
#### MUS-SPEC-02-479M: A queued message cut off by a quit is sent once at the next launch

- Precondition: A completed chat has a queued message and no receipt for it.
- Action: Start Muster.
- Expected result: The message is sent once with its own text, and the queue is empty afterwards.
- Test: `packages/agent-app/tests/auto-resume.test.ts::#450: a queued message whose dispatch was cut short by a quit is sent once at the next launch`
- Environment: Node test runner; the real agent service with a fake provider and short timers; no network.
- Known gaps: Seeds the saved state directly instead of killing the app mid-send.
- Evidence: UNVERIFIED

### The Limited chip, notice row and settings

<a id="mus-spec-02-479p"></a>
#### MUS-SPEC-02-479P: A Limited chat reads Limited, and a running or given-up chat does not

- Precondition: A chat with a usage-limit resume pending.
- Action: Read its display status and draw the status dot.
- Expected result: The status is limited and the dot reads "Limited". If the chat is running again it reads running. If Muster gave up it reads failed.
- Test: `packages/agent-app/tests/limit-resume-dom.tsx::a limited chat reads Limited in the header, the sidebar dot and the status view, and a running or given-up chat does not`
- Environment: Node script with a fake DOM (linkedom); the real components; no Electron.
- Known gaps: The fake DOM has no real styles, so the colour of the dot is not checked.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479q"></a>
#### MUS-SPEC-02-479Q: The notice row shows the reset time and lets the user choose per chat

- Precondition: A Limited chat with a reset 42 minutes away.
- Action: Draw the row, click Don't resume, click Resume at reset, then draw a chat set to not resume.
- Expected result: The row says "Usage limit reached · resets" with the time and that Muster continues and the queue follows in order. Resume at reset is chosen by default and there is no Continue anyway button. Clicking Don't resume sends one chat.autoResume with resume off. Clicking the already chosen option sends nothing. A not-resuming chat says to send a message when it resets.
- Test: `packages/agent-app/tests/limit-resume-dom.tsx::the notice row shows the reset time, what happens then, and Resume at reset or Don’t resume for this chat`
- Environment: Node script with a fake DOM (linkedom); the real components; no Electron.
- Known gaps: The fake DOM has no real layout.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479r"></a>
#### MUS-SPEC-02-479R: A rate limit and a gave-up chat are worded differently

- Precondition: A Limited chat with a rate limit, and one that Muster gave up on.
- Action: Draw the row for each.
- Expected result: The rate limit says "Rate limited by the provider · retrying at" with the time. The gave-up chat says "Still limited after repeated tries. Muster stopped continuing this chat." and has no Don't resume button.
- Test: `packages/agent-app/tests/limit-resume-dom.tsx::a rate limit and a gave-up chat each say so in their own words`
- Environment: Node script with a fake DOM (linkedom); the real components; no Electron.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479s"></a>
#### MUS-SPEC-02-479S: The fallback model is off by default and a choice is saved for the chat

- Precondition: A Limited chat, and a provider with a ready model.
- Action: Open the picker and choose the model.
- Expected result: The picker starts at "No fallback model", lists the ready models, and choosing one sends chat.fallbacks with that provider and model.
- Test: `packages/agent-app/tests/limit-resume-dom.tsx::the fallback model is off by default and choosing one is saved for the chat`
- Environment: Node script with a fake DOM (linkedom); the real components; no Electron.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479t"></a>
#### MUS-SPEC-02-479T: A running chat shows no limit row, and a paused queue says why

- Precondition: A running chat, a plain failed chat, and a queue paused as "limited".
- Action: Draw each.
- Expected result: The running chat has no limit row. The plain failure keeps its normal failure banner. The queue says "Queue waits for the usage limit to reset".
- Test: `packages/agent-app/tests/limit-resume-dom.tsx::a running chat shows no limit row, and the queue says it waits for the usage limit to reset`
- Environment: Node script with a fake DOM (linkedom); the real components; no Electron.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-479u"></a>
#### MUS-SPEC-02-479U: Settings has two continue switches, on by default

- Precondition: Settings › General is open with nothing changed.
- Action: Read both switches, then turn each off.
- Expected result: "Continue when a usage limit resets" and "Continue interrupted chats after a restart" are both on. Turning them off saves chats.resumeAfterRestart and chats.resumeAfterLimit as false.
- Test: `packages/agent-app/tests/limit-resume-dom.tsx::Settings › General has both continue switches, on by default, and they save through settings.set`
- Environment: Node script with a fake DOM (linkedom); the real components; no Electron.
- Known gaps: Settings are held by a fake host, not the real settings store.
- Evidence: UNVERIFIED

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

### Non-blocking questions (ask_user)

<a id="mus-spec-02-476a"></a>
#### MUS-SPEC-02-476A: The agent can ask a question without stopping its turn

- Precondition: The agent is running a turn in a chat.
- Action: The agent calls ask_user with a question, two options and a default.
- Expected result: The tool returns at once with "continue now with" the default. A pending question card shows the options and the default, with no deadline. The chat stays Running (not Waiting), the composer is not taken over by the card, and the question does not count as a blocking request.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::ask_user returns at once with the default, posts a non-blocking question card, and the run keeps going`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: Checks the card data and the status view model, not the rendered card.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476b"></a>
#### MUS-SPEC-02-476B: A question with no default or no question text is refused

- Precondition: The agent is running a turn.
- Action: The agent calls ask_user with a question but no default, and the parser is given a default but no question.
- Expected result: The call returns an error that says it needs a default, and no question card is added. The parser rejects the call with a message.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::ask_user without a default or question is refused, and no card is posted`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476c"></a>
#### MUS-SPEC-02-476C: An answer given while the run goes steers the run, once

- Precondition: An ask_user card is pending and the run is still going on a route that can steer.
- Action: The user answers the card, then answers it again, then answers with a different choice.
- Expected result: The first answer reaches the agent as one steer that names the question and the answer, and shows once in the timeline. The card is marked answered and delivered by steer. The repeat answers send nothing more, and nothing is queued.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::an answer while the run is going is delivered as a steer; answering twice is a no-op`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: The fake provider records steers; no real model reads them.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476d"></a>
#### MUS-SPEC-02-476D: An answer after the run ended starts the next turn

- Precondition: An ask_user card is pending and the run has finished, so the chat is completed.
- Action: The user answers the card, then answers it again.
- Expected result: The card stays answerable after the run ended. The answer is queued and starts a new turn whose prompt holds the question and the answer. It is not sent as a steer. A second answer does not start another turn.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::an answer after the run ended is queued and starts the next turn`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476e"></a>
#### MUS-SPEC-02-476E: On a route that cannot steer, the answer becomes the next turn

- Precondition: An ask_user card is pending and the run is going on a route that cannot take a steer.
- Action: The user answers the card.
- Expected result: The answer is queued and the card says it was queued. When the run ends, the next turn starts with the answer in its prompt.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::a route that cannot steer gets the answer as the next turn`
- Environment: Node test runner; the real agent service with a fake provider that cannot steer; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476f"></a>
#### MUS-SPEC-02-476F: Dismissing the card sends nothing

- Precondition: An ask_user card is pending.
- Action: The user dismisses the card.
- Expected result: The card is marked dismissed and no steer or message is sent, so the agent keeps its default.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::dismissing an ask_user card delivers nothing; the agent keeps its default`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476g"></a>
#### MUS-SPEC-02-476G: The question tool never asks for approval

- Precondition: A run uses a command-line route with the muster_ask question tool.
- Action: The route asks for approval to call the tool, and for an elicitation from the same server.
- Expected result: Both requests are accepted at once and no approval card is added to the chat.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::the muster_ask server never raises an approval card, in any access mode`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: Checks one access mode in the fixture; the rule is the same for each mode.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476h"></a>
#### MUS-SPEC-02-476H: Command-line routes are given the question tool

- Precondition: The agent service is started with the question tool host turned on.
- Action: A chat is sent to a command-line route.
- Expected result: The run's config has a muster_ask server with a command, the chat id, and a 64-character hex token.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::CLI routes get the muster_ask MCP server when the tool host runs`
- Environment: Node test runner; the real agent service with a fake provider; no network.
- Known gaps: Does not start the tool server or call it from a real command-line agent.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476i"></a>
#### MUS-SPEC-02-476I: Model-router routes get ask_user as a built-in tool at every access level

- Precondition: An HTTP route can post question cards.
- Action: List the tools for read-only, workspace and full access, with and without the card hook. Then run the tool with a question and default.
- Expected result: ask_user is offered at all three levels, only when the route can post the card, and the instructions mention it. Running it returns the "continue now" text at once, passes on the question and default, and shows start and finish rows under the muster_ask server.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::HTTP routes: ask_user is a native tool at every access level and returns at once`
- Environment: Node test runner; the tool executor with a fake hook; no network.
- Known gaps: Does not run a real model that chooses to call the tool.
- Evidence: UNVERIFIED

<a id="mus-spec-02-476j"></a>
#### MUS-SPEC-02-476J: Agent mode tells the model to use ask_user instead of ending the turn

- Precondition: A run starts in agent mode, then in ask mode.
- Action: Build the run instructions for each mode.
- Expected result: Agent mode includes the line that says to use ask_user instead of ending the turn to ask. Ask mode does not.
- Test: `packages/agent-app/tests/ask-user-nonblocking.test.ts::agent instructions prefer ask_user over ending the turn to ask (agent mode only)`
- Environment: Node test runner; no provider or network.
- Known gaps: Shows the instruction is present, not that a model follows it.
- Evidence: UNVERIFIED

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

### Network failures and reconnects

<a id="mus-spec-02-608a"></a>
#### MUS-SPEC-02-608A: A broken connection stops after three failed reconnects

- Precondition: A turn is running through a transport that keeps reporting that it is reconnecting because the proxy fails. The error text contains a user name and password in the proxy address.
- Action: The transport reports the failure three times. Then it reports once more and sends more text. Then a new run is started on the same adapter.
- Expected result: After the third failure the turn ends within 200ms as failed, marked retryable, and the reason names the HTTPS proxy. Neither the user name nor the password appears. The transport is closed, and the extra failure and text change nothing. The new run completes.
- Test: `packages/agent-app/tests/network-reconnect.test.ts::failing transport stops after three reconnect failures, explains proxy and allows manual retry`
- Environment: Node test runner; a fake transport; no network or provider.
- Known gaps: Uses a fake transport, not a real provider that loses its connection. The retry button is checked in MUS-SPEC-02-608D.
- Evidence: UNVERIFIED

<a id="mus-spec-02-608b"></a>
#### MUS-SPEC-02-608B: A stalled reconnect stops at the time limit

- Precondition: A turn is running and its transport has reported one reconnect failure, then goes quiet.
- Action: Let the reconnect time limit pass (the clock is faked, so no real wait).
- Expected result: The turn ends as failed and the reason names the HTTPS proxy, without any more events from the transport.
- Test: `packages/agent-app/tests/network-reconnect.test.ts::stalled reconnect stops by deadline without further transport events`
- Environment: Node test runner; a fake transport and a fake clock.
- Known gaps: Shows the limit with a fake clock. The real limit is 30 seconds; the test uses the constant, not a real wait.
- Evidence: UNVERIFIED

<a id="mus-spec-02-608c"></a>
#### MUS-SPEC-02-608C: A failed web request explains why, in plain words

- Precondition: A model provider reached over a web address. The request fails with a proxy error, a missing host, an expired certificate or a refused connection, and the address in the error holds a user name and password.
- Action: Run a turn against each of the four failures.
- Expected result: Each turn fails with a message naming its cause (HTTPS proxy, DNS, TLS certificate, connection refused), is marked as not sent to the provider, and the message contains neither the user name nor the password.
- Test: `packages/agent-app/tests/network-reconnect.test.ts::HTTP fetch failures explain nested proxy, DNS, TLS and refused causes without credentials`
- Environment: Node test runner; the real web adapter with a fetch that always throws.
- Known gaps: Four error codes only. Other network errors fall back to a general message, which `tests/network-reconnect.test.ts` also checks but is not linked here.
- Evidence: UNVERIFIED

<a id="mus-spec-02-608d"></a>
#### MUS-SPEC-02-608D: Retry on a network failure re-runs the turn, not the draft

- Precondition: A chat's last turn failed on a network error and can be retried. The composer is empty.
- Action: Look at the banner, click Retry, let it finish, then type a follow-up message in the composer and click Retry again.
- Expected result: The banner shows the reason and an enabled Retry button, even though the composer is empty. While a retry runs the button reads "Retrying…" and is disabled. After the second click the turn retry has run twice and no message was sent: the follow-up in the composer stays unsent.
- Test: `packages/agent-app/tests/recovery-notice.tsx::a failed network turn offers Retry, which re-runs the turn and never sends the draft in its place`
- Environment: DOM suite (`linkedom`), run with `tests/run-recovery-notice.mjs`; the app's calls are faked.
- Known gaps: The retry handler is a stand-in that counts calls, so the test does not show the turn really starting again. It is not part of `test:renderer`; run it by hand.
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

<a id="mus-spec-02-398a"></a>
#### MUS-SPEC-02-398A: An imported turn displays its work duration without the import gap

- Precondition: A completed 26-second turn has an import notice a month later.
- Action: Render its folded turn header.
- Expected result: The header reads Worked for 26s.
- Test: `packages/agent-app/tests/ui-sweep-dom.tsx::an imported turn displays its work duration without the import gap`
- Environment: Node and linkedom with the real renderer and a fixture bridge; responsive navigation uses a window media-query fixture. No desktop app or network.
- Known gaps: Does not exercise a live provider or imported history database. Visual layout is checked separately in a browser harness.
- Evidence: UNVERIFIED
