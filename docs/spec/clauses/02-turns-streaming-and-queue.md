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
