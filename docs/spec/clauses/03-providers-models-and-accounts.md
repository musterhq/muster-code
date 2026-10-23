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
| [MUS-SPEC-03-1A](03-providers-models-and-accounts.md#mus-spec-03-1a) | All four turns complete without reconnecting; one request per turn with valid credentials; real counters preserved. | [`router usage compatibility: two independent chats complete successive turns without reconnecting`](../../../packages/agent-app/tests/router-usage-workflow.test.ts) |
| [MUS-SPEC-03-1B](03-providers-models-and-accounts.md#mus-spec-03-1b) | The first turn completes and the truncated one fails, on the same thread. | [`router usage compatibility: a genuinely truncated stream still fails`](../../../packages/agent-app/tests/router-usage-workflow.test.ts) |
| [MUS-SPEC-03-1C](03-providers-models-and-accounts.md#mus-spec-03-1c) | 404 without the private path; nothing forwarded; the real request is forwarded unchanged. | [`router bridge: a request without the private path prefix is refused and never forwarded`](../../../packages/agent-app/tests/responses-compat.test.ts) |
| [MUS-SPEC-03-1D](03-providers-models-and-accounts.md#mus-spec-03-1d) | 502 naming ECONNREFUSED, with no credentials or address in it. | [`router bridge: when the router cannot be reached the 502 says why, without the address or credentials`](../../../packages/agent-app/tests/responses-compat.test.ts) |

### Configured routers
<a id="mus-spec-03-1a"></a>
#### MUS-SPEC-03-1A: A router reply that leaves out usage counters still completes

- Precondition: Two chats use a configured Responses router signed in through a credential helper. The router's completed replies leave out `cached_tokens` and `reasoning_tokens`.
- Action: Send two messages in each chat, through Muster and the real coding client.
- Expected result: All four turns complete with their answer and no reconnect. Each turn sends one request with the user's credentials, each chat keeps its own thread, and counters the router does send (2 cached, 1 reasoning) are kept.
- Test: `packages/agent-app/tests/router-usage-workflow.test.ts::router usage compatibility: two independent chats complete successive turns without reconnecting`
- Environment: Node test runner; a local mock router; the real coding client installed (CI pins it and sets MUSTER_REQUIRE_CODEX_E2E=1 so the test cannot skip).
- Known gaps: Skips when the coding client is not installed and MUSTER_REQUIRE_CODEX_E2E is unset. Does not repair a router's signed thinking history.
- Evidence: UNVERIFIED

<a id="mus-spec-03-1b"></a>
#### MUS-SPEC-03-1B: A cut-off router reply still fails

- Precondition: A configured Responses router has completed one turn with missing usage counters, then ends the next reply without its completion event.
- Action: Send the next message in the same chat.
- Expected result: The first turn completes without reconnecting. The cut-off turn fails with a stream or completion error, keeps the chat's thread, and every request keeps the user's credentials and model.
- Test: `packages/agent-app/tests/router-usage-workflow.test.ts::router usage compatibility: a genuinely truncated stream still fails`
- Environment: Node test runner; a local mock router; the real coding client installed.
- Known gaps: Skips when the coding client is not installed and MUSTER_REQUIRE_CODEX_E2E is unset.
- Evidence: UNVERIFIED

<a id="mus-spec-03-1c"></a>
#### MUS-SPEC-03-1C: Only Muster's own client can use the router connection

- Precondition: Muster has opened its local connection to a configured router.
- Action: Send one request without the connection's private path and one with it.
- Expected result: The request without the private path is refused with 404 and never reaches the router. The real request reaches the router at its own path with the user's credentials unchanged.
- Test: `packages/agent-app/tests/responses-compat.test.ts::router bridge: a request without the private path prefix is refused and never forwarded`
- Environment: Node test runner; a local mock router; no network.
- Known gaps: Another program on the same computer that learns the private path could still use it while the chat runs.
- Evidence: UNVERIFIED

<a id="mus-spec-03-1d"></a>
#### MUS-SPEC-03-1D: A router that cannot be reached says why

- Precondition: A configured router address where nothing is listening.
- Action: Send a request through Muster's router connection.
- Expected result: It fails with 502 and a message that names the cause (ECONNREFUSED). The message holds no credentials and no address.
- Test: `packages/agent-app/tests/responses-compat.test.ts::router bridge: when the router cannot be reached the 502 says why, without the address or credentials`
- Environment: Node test runner; no network.
- Known gaps: Only the system error code is shown, not the router's own error text.
- Evidence: UNVERIFIED

