# MUS-SPEC-03: Providers, models and accounts

A provider is where the agent's model runs: a local coding agent CLI, an HTTP model router, or a custom endpoint. An account is the sign-in or key the provider uses.

What the user can do:
- connect, sign in to and remove providers, including custom OpenAI-compatible endpoints;
- see each provider's models, hide models, set default models and prices, and pick a model and reasoning effort per chat;
- see when a provider is missing, signed out or failing, with a plain fix.

Boundaries:
- Keys and tokens live in the system secret store, never in plain settings files (clause [19](19-security-and-redaction.md)).
- A model list that cannot be read falls back to the last good list or a built-in one, and says so.
- Context window sizes are clause [04](04-context-window-and-compaction.md). Usage and cost are clause [17](17-usage-cost-and-ledger.md).

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-03-568A](03-providers-models-and-accounts.md#mus-spec-03-568a) | About 90 KB of three-byte characters from run_command comes back with no "�" and in the right order. | [`run_command output keeps multi-byte characters that straddle pipe chunks`](../../../packages/agent-app/tests/http-tools-encoding.test.ts) |
| [MUS-SPEC-03-568B](03-providers-models-and-accounts.md#mus-spec-03-568b) | Reading a file larger than the limit that is made of two-byte characters returns text with no "�". | [`read_file cut at the size limit does not end in a broken character`](../../../packages/agent-app/tests/http-tools-encoding.test.ts) |
| [MUS-SPEC-03-568C](03-providers-models-and-accounts.md#mus-spec-03-568c) | A Latin-1 file is either left byte-for-byte unchanged with a message that names UTF-8, or only the edited bytes change. | [`edit_file refuses a file that is not UTF-8 instead of rewriting its other bytes`](../../../packages/agent-app/tests/http-tools-encoding.test.ts) |
| [MUS-SPEC-03-568D](03-providers-models-and-accounts.md#mus-spec-03-568d) | After keeping the newest 80 messages the history starts with a user message even when two user messages came in a row. | [`trimming to the newest 80 messages never leaves the history starting with a reply`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-568E](03-providers-models-and-accounts.md#mus-spec-03-568e) | After a size trim the history still starts with a user message. | [`trimming by size never leaves the history starting with a reply`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-568F](03-providers-models-and-accounts.md#mus-spec-03-568f) | A saved file that starts with a reply and holds an empty reply is resumed as q, "(no reply)", q2, a. | [`a history saved by an older build is resent from its first user message, with no empty reply`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-568G](03-providers-models-and-accounts.md#mus-spec-03-568g) | After a turn that only streamed reasoning, the next request to the Anthropic API holds no empty message. | [`a turn that produced no text is not resent as an empty assistant message`](../../../packages/agent-app/tests/http-history-shape.test.ts) |

### HTTP routes: text and history

<a id="mus-spec-03-568a"></a>
#### MUS-SPEC-03-568A: Command output keeps multi-byte characters

- Precondition: A chat on a router or API route; the agent runs a command that prints 30,000 "€" characters.
- Action: Run the command through the route's `run_command` tool.
- Expected result: The result holds no "�" replacement characters and starts with the expected text.
- Test: `packages/agent-app/tests/http-tools-encoding.test.ts::run_command output keeps multi-byte characters that straddle pipe chunks`
- Environment: Node test runner; no network, no provider. POSIX shell; the test skips itself on Windows.
- Known gaps: Calls the tool handler directly, not a full model turn.
- Evidence: UNVERIFIED

<a id="mus-spec-03-568b"></a>
#### MUS-SPEC-03-568B: A large file read is cut on a character boundary

- Precondition: A file bigger than the read limit made of two-byte "é" characters.
- Action: Read it with the route's `read_file` tool.
- Expected result: The text is cut at the limit without ending in a broken character.
- Test: `packages/agent-app/tests/http-tools-encoding.test.ts::read_file cut at the size limit does not end in a broken character`
- Environment: Node test runner; no network, no provider.
- Known gaps: Calls the tool handler directly, not a full model turn.
- Evidence: UNVERIFIED

<a id="mus-spec-03-568c"></a>
#### MUS-SPEC-03-568C: edit_file does not damage a file that is not UTF-8

- Precondition: A Latin-1 file `latin1.txt` with an accented letter.
- Action: Ask `edit_file` to change `value = 2` to `value = 3`.
- Expected result: Either the edit is refused, the file is unchanged and the message says UTF-8, or the file differs only in the edited text.
- Test: `packages/agent-app/tests/http-tools-encoding.test.ts::edit_file refuses a file that is not UTF-8 instead of rewriting its other bytes`
- Environment: Node test runner; no network, no provider.
- Known gaps: The test allows both outcomes. The shipped behaviour is to refuse, so a fix that edits correctly would also pass.
- Evidence: UNVERIFIED

<a id="mus-spec-03-568d"></a>
#### MUS-SPEC-03-568D: Trimming a long history by count keeps it starting with your message

- Precondition: A saved history with two user messages in a row at the start, followed by 40 reply and message pairs.
- Action: Save it and open the thread again.
- Expected result: The first message is from the user.
- Test: `packages/agent-app/tests/http-history-shape.test.ts::trimming to the newest 80 messages never leaves the history starting with a reply`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the history store, not a request to the Anthropic API.
- Evidence: UNVERIFIED

<a id="mus-spec-03-568e"></a>
#### MUS-SPEC-03-568E: Trimming a long history by size keeps it starting with your message

- Precondition: A history with a small size limit and a steer message sent with no reply in between.
- Action: Save it and open the thread again.
- Expected result: The first message is from the user.
- Test: `packages/agent-app/tests/http-history-shape.test.ts::trimming by size never leaves the history starting with a reply`
- Environment: Node test runner; no network, no provider.
- Known gaps: Tests the history store, not a request to the Anthropic API.
- Evidence: UNVERIFIED

<a id="mus-spec-03-568f"></a>
#### MUS-SPEC-03-568F: A history saved by an older build is repaired when resumed

- Precondition: A thread file on disk that starts with an assistant message and has an empty assistant message in it.
- Action: Open that thread.
- Expected result: The history starts at the first user message and the empty reply reads "(no reply)".
- Test: `packages/agent-app/tests/http-history-shape.test.ts::a history saved by an older build is resent from its first user message, with no empty reply`
- Environment: Node test runner; no network, no provider. Temp folder.
- Known gaps: Tests the history store, not a request to the Anthropic API.
- Evidence: UNVERIFIED

<a id="mus-spec-03-568g"></a>
#### MUS-SPEC-03-568G: A reply with no text is not resent as an empty message

- Precondition: An Anthropic route chat whose first turn streamed only reasoning and no text.
- Action: Send a second message in the same thread and read the request body.
- Expected result: No message in the request has empty text.
- Test: `packages/agent-app/tests/http-history-shape.test.ts::a turn that produced no text is not resent as an empty assistant message`
- Environment: Node test runner; no network, no provider. Fake `fetch` returns canned streams; no network.
- Known gaps: Uses a fake API, so the real API's reaction to an empty message is not shown.
- Evidence: UNVERIFIED
