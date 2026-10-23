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
| [MUS-SPEC-02-608A](02-turns-streaming-and-queue.md#mus-spec-02-608a) | After three failed reconnects the turn stops in under 200ms as failed and retryable, with the HTTPS proxy named and no credentials; later events add nothing, and a new run on the same adapter completes. | [`failing transport stops after three reconnect failures, explains proxy and allows manual retry`](../../../packages/agent-app/tests/network-reconnect.test.ts) |
| [MUS-SPEC-02-608B](02-turns-streaming-and-queue.md#mus-spec-02-608b) | A reconnect that stalls after one failure is stopped when the reconnect time limit passes, with the proxy named. | [`stalled reconnect stops by deadline without further transport events`](../../../packages/agent-app/tests/network-reconnect.test.ts) |
| [MUS-SPEC-02-608C](02-turns-streaming-and-queue.md#mus-spec-02-608c) | A failed web request to a model gives a plain cause for a proxy, DNS, certificate or refused connection, marks the turn as not sent, and never shows the user name or password in the address. | [`HTTP fetch failures explain nested proxy, DNS, TLS and refused causes without credentials`](../../../packages/agent-app/tests/network-reconnect.test.ts) |
| [MUS-SPEC-02-608D](02-turns-streaming-and-queue.md#mus-spec-02-608d) | The failure banner for a network error shows Retry even with an empty draft, runs the turn retry once per click with a busy state, and never sends the text in the composer instead. | [`a failed network turn offers Retry, which re-runs the turn and never sends the draft in its place`](../../../packages/agent-app/tests/recovery-notice.tsx) |

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
