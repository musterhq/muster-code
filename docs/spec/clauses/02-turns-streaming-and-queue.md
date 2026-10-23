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
