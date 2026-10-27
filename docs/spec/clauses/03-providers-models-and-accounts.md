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
| [MUS-SPEC-03-721H](03-providers-models-and-accounts.md#mus-spec-03-721h) | With no Codex, npm, Node or other app on the machine, installing Codex gives a managed copy that reports its version, and chats run that native binary. | [`MUS-SPEC-03-721H: on a machine with no Codex, npm or Node, one click installs a Codex that runs`](../../../packages/agent-app/tests/cli-maintenance.test.ts) |
| [MUS-SPEC-03-721I](03-providers-models-and-accounts.md#mus-spec-03-721i) | A download whose checksum does not match the registry's fails with a message naming the checksum, leaves no files and does not change which Codex chats use. | [`MUS-SPEC-03-721I: a download that fails its checksum installs nothing`](../../../packages/agent-app/tests/cli-maintenance.test.ts) |
| [MUS-SPEC-03-1A](03-providers-models-and-accounts.md#mus-spec-03-1a) | All four turns complete without reconnecting; one request per turn with valid credentials; real counters preserved. | [`router usage compatibility: two independent chats complete successive turns without reconnecting`](../../../packages/agent-app/tests/router-usage-workflow.test.ts) |
| [MUS-SPEC-03-1B](03-providers-models-and-accounts.md#mus-spec-03-1b) | The first turn completes and the truncated one fails, on the same thread. | [`router usage compatibility: a genuinely truncated stream still fails`](../../../packages/agent-app/tests/router-usage-workflow.test.ts) |
| [MUS-SPEC-03-1C](03-providers-models-and-accounts.md#mus-spec-03-1c) | 404 without the private path; nothing forwarded; the real request is forwarded unchanged. | [`router bridge: a request without the private path prefix is refused and never forwarded`](../../../packages/agent-app/tests/responses-compat.test.ts) |
| [MUS-SPEC-03-1D](03-providers-models-and-accounts.md#mus-spec-03-1d) | 502 naming ECONNREFUSED, with no credentials or address in it. | [`router bridge: when the router cannot be reached the 502 says why, without the address or credentials`](../../../packages/agent-app/tests/responses-compat.test.ts) |
| [MUS-SPEC-03-588A](03-providers-models-and-accounts.md#mus-spec-03-588a) | A ChatGPT route with an older profile catalog also offers the newer models in Codex's own account cache, after the catalog's models, each once. | [`a stale profile catalog does not hide the newer models the account cache lists`](../../../packages/agent-app/tests/codex-catalog-merge-588.test.ts) |
| [MUS-SPEC-03-588B](03-providers-models-and-accounts.md#mus-spec-03-588b) | Models the cache or the profile catalog marks hidden, and ids that are not OpenAI's, are not added; a gateway profile catalog is not extended. | [`hidden models and non-OpenAI ids stay out of the merged list, and a gateway catalog is not extended`](../../../packages/agent-app/tests/codex-catalog-merge-588.test.ts) |
| [MUS-SPEC-03-463A](03-providers-models-and-accounts.md#mus-spec-03-463a) | After a busy turn full of tool rows, the digest for the new provider still holds the first request, the last five user messages, the last assistant summary and the folder's branch and changes; the repo's own hook does not run. | [`digest on a busy turn still leads with the task: first request, last 5 user messages, last summary and git state`](../../../packages/agent-app/tests/fork-edit.test.ts) |
| [MUS-SPEC-03-567A](03-providers-models-and-accounts.md#mus-spec-03-567a) | The Gemini arguments carry the whole message in `--prompt=…` or as a token that does not start with "-". | [`Gemini: a prompt starting with a dash is never a separate argv token after --prompt`](../../../packages/agent-app/tests/cli-dash-prompt.test.ts) |
| [MUS-SPEC-03-567B](03-providers-models-and-accounts.md#mus-spec-03-567b) | For the message "--version is wrong in package.json, fix it" the OpenCode argument holding it does not start with a dash. | [`OpenCode: a message starting with dashes is not passed as a flag`](../../../packages/agent-app/tests/cli-dash-prompt.test.ts) |
| [MUS-SPEC-03-568A](03-providers-models-and-accounts.md#mus-spec-03-568a) | About 90 KB of three-byte characters from run_command comes back with no "�" and in the right order. | [`run_command output keeps multi-byte characters that straddle pipe chunks`](../../../packages/agent-app/tests/http-tools-encoding.test.ts) |
| [MUS-SPEC-03-568B](03-providers-models-and-accounts.md#mus-spec-03-568b) | Reading a file larger than the limit that is made of two-byte characters returns text with no "�". | [`read_file cut at the size limit does not end in a broken character`](../../../packages/agent-app/tests/http-tools-encoding.test.ts) |
| [MUS-SPEC-03-568C](03-providers-models-and-accounts.md#mus-spec-03-568c) | A Latin-1 file is either left byte-for-byte unchanged with a message that names UTF-8, or only the edited bytes change. | [`edit_file refuses a file that is not UTF-8 instead of rewriting its other bytes`](../../../packages/agent-app/tests/http-tools-encoding.test.ts) |
| [MUS-SPEC-03-568D](03-providers-models-and-accounts.md#mus-spec-03-568d) | After keeping the newest 80 messages the history starts with a user message even when two user messages came in a row. | [`trimming to the newest 80 messages never leaves the history starting with a reply`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-568E](03-providers-models-and-accounts.md#mus-spec-03-568e) | After a size trim the history still starts with a user message. | [`trimming by size never leaves the history starting with a reply`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-568F](03-providers-models-and-accounts.md#mus-spec-03-568f) | A saved file that starts with a reply and holds an empty reply is resumed as q, "(no reply)", q2, a. | [`a history saved by an older build is resent from its first user message, with no empty reply`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-568G](03-providers-models-and-accounts.md#mus-spec-03-568g) | After a turn that only streamed reasoning, the next request to the Anthropic API holds no empty message. | [`a turn that produced no text is not resent as an empty assistant message`](../../../packages/agent-app/tests/http-history-shape.test.ts) |
| [MUS-SPEC-03-688A](03-providers-models-and-accounts.md#mus-spec-03-688a) | The second request carries the first reply's thinking block, with its text and signature exactly as received, then the tool call, then the tool result. | [`a tool round sends the signed thinking and tool call back exactly as received`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688B](03-providers-models-and-accounts.md#mus-spec-03-688b) | The request for the second turn holds the first turn's user message, every assistant block (thinking with signature, tool call, final text) and the tool result, unchanged, before the new message. | [`the next turn resends every earlier block unchanged`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688C](03-providers-models-and-accounts.md#mus-spec-03-688c) | The next request carries the redacted_thinking block with its data unchanged. | [`redacted thinking is sent back unchanged`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688D](03-providers-models-and-accounts.md#mus-spec-03-688d) | The thinking text reaches the chat's reasoning stream, and the answer text reaches the reply, in order. | [`thinking and text stream to the chat as they arrive`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688E](03-providers-models-and-accounts.md#mus-spec-03-688e) | Each request offers the tools that access level allows, in the Messages tool format: Read only can only read and list, Workspace can also edit files, Full access can also run commands. | [`the tools offered follow the chat's access level`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688F](03-providers-models-and-accounts.md#mus-spec-03-688f) | The turn fails with the router's error message, and nothing is resent. | [`a router error fails the turn with its message`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688G](03-providers-models-and-accounts.md#mus-spec-03-688g) | The request carries the saved earlier blocks, signatures included, unchanged. | [`a restart continues with the saved blocks unchanged`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688H](03-providers-models-and-accounts.md#mus-spec-03-688h) | The router receives a Messages request (not a Codex run) with the chat's prompt and tools; the Codex client is never started; the instructions sent do not mention tools the Messages route lacks. | [`a Claude model in a Full access chat on a router gateway runs over the Messages API, with the overrides the service adds`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-688I](03-providers-models-and-accounts.md#mus-spec-03-688i) | The combo whose probe reports a Claude model runs over the Messages API; the one that reports a GPT model runs on Codex; each is probed once inside the cache window and again after it. | [`a router combo runs over the Messages API only when its probe reports a Claude model, and the answer is cached`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-688J](03-providers-models-and-accounts.md#mus-spec-03-688j) | Both turns run on the Codex client; the router receives no Messages request. | [`Workspace chats and turns with project tools stay on the Codex route`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-688K](03-providers-models-and-accounts.md#mus-spec-03-688k) | The second turn does not resume the Codex thread; the Messages request holds a summary of the first exchange before the new message; the chat says a fresh conversation started and records the Messages thread. | [`the first Messages turn after a Codex turn starts a fresh conversation with a summary, not the Codex thread`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-688L](03-providers-models-and-accounts.md#mus-spec-03-688l) | The turn is retried once with a freshly fetched token and completes; the second request carries the new token. | [`a 401 is retried once with a fresh token before the turn fails`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-688M](03-providers-models-and-accounts.md#mus-spec-03-688m) | The Messages-lane chat is interrupted with no recovery needed and the provider is never asked; the same chat on the Codex client still needs recovery. | [`a run on the Messages lane that was open when Muster closed is interrupted, never asked about at the provider`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-688N](03-providers-models-and-accounts.md#mus-spec-03-688n) | The saved conversation starts with a user message that holds the person's own text, stays within its limits and holds no image data. | [`saved Claude history never starts with an assistant message`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688O](03-providers-models-and-accounts.md#mus-spec-03-688o) | An error event before any content is retried once and the turn completes; an error after text has streamed fails the turn without resending; every request asks for high effort. | [`an error event before any content is sent once more; after content it fails the turn`](../../../packages/agent-app/tests/claude-messages-driver.test.ts) |
| [MUS-SPEC-03-688P](03-providers-models-and-accounts.md#mus-spec-03-688p) | The turn runs over the Messages API with a native ask_user tool offered; the call returns the default at once, a non-blocking question card is posted, and the turn completes on the Messages lane. | [`a Full access Claude turn still runs over the Messages API when the service adds the ask_user server, and ask_user returns the default`](../../../packages/agent-app/tests/claude-messages-lane.test.ts) |
| [MUS-SPEC-03-716A](03-providers-models-and-accounts.md#mus-spec-03-716a) | A resume refused with "replay state expired or is unavailable" before the turn starts is retried once on a fresh thread: the message reaches the provider twice at most, the retry resumes nothing and starts with a summary of the earlier messages, one notice says a fresh conversation started, and the chat ends completed on the new thread. | [`a resumed router thread whose replay state expired starts one fresh conversation with a summary`](../../../packages/agent-app/tests/replay-expired-716.test.ts) |
| [MUS-SPEC-03-716B](03-providers-models-and-accounts.md#mus-spec-03-716b) | If the fresh conversation is refused with the same error there is no third attempt and the error is shown through the usual recovery notice. | [`when the fresh conversation is refused with the same 409 there is no third attempt and the error is shown`](../../../packages/agent-app/tests/replay-expired-716.test.ts) |
| [MUS-SPEC-03-716C](03-providers-models-and-accounts.md#mus-spec-03-716c) | A 409 with other text, or the same text after the turn produced output, does not start a fresh conversation. | [`a 409 with other text, or after the turn produced output, does not start a fresh conversation`](../../../packages/agent-app/tests/replay-expired-716.test.ts) |
| [MUS-SPEC-03-722A](03-providers-models-and-accounts.md#mus-spec-03-722a) | After the router loses an earlier tool call's replay state, the next message completes on the same thread with the earlier tool output still in the history: one refused request, one accepted retry, no fresh-conversation notice, and the turn after it is not refused. | [`a router that lost an old tool call's replay state does not reset the chat: same thread, full history, no fresh conversation`](../../../packages/agent-app/tests/router-replay-722.test.ts) |
| [MUS-SPEC-03-722B](03-providers-models-and-accounts.md#mus-spec-03-722b) | Only the replay refusal is retried, and only once; any other 409 reaches the coding client unchanged with its request sent as is. | [`the bridge retries only the replay refusal, only once, and passes every other 409 through unchanged`](../../../packages/agent-app/tests/router-replay-722.test.ts) |
| [MUS-SPEC-03-724A](03-providers-models-and-accounts.md#mus-spec-03-724a) | The first message on the new provider carries a summary of the earlier conversation ahead of the new text and says so in a notice; later messages continue the new provider conversation without it. | [`switching a chat to a model on another provider keeps the conversation: the first message there carries the earlier one`](../../../packages/agent-app/tests/provider-switch-context-724.test.ts) |
| [MUS-SPEC-03-724B](03-providers-models-and-accounts.md#mus-spec-03-724b) | The next message continues the same provider thread with no summary added. | [`another model on the same provider account continues the same provider conversation without a summary`](../../../packages/agent-app/tests/provider-switch-context-724.test.ts) |
| [MUS-SPEC-03-720A](03-providers-models-and-accounts.md#mus-spec-03-720a) | The chat runs in Muster's own coding-client home under its data folder: no thread or thread index is written to the person's home, the person's profile is untouched, and follow-ups continue the same thread. | [`a new chat runs in Muster’s own coding-client home: nothing is written to the person’s home, which keeps its configuration`](../../../packages/agent-app/tests/own-codex-home-720.test.ts) |
| [MUS-SPEC-03-720B](03-providers-models-and-accounts.md#mus-spec-03-720b) | A chat started before the change continues on its own thread with its earlier messages, and the person's copy of that thread is not written to again. | [`a chat started before the change continues its own thread with its history, without writing to the person’s home again`](../../../packages/agent-app/tests/own-codex-home-720.test.ts) |
| [MUS-SPEC-03-720C](03-providers-models-and-accounts.md#mus-spec-03-720c) | Usage limits recorded in the person's home by their other coding apps still show for that account, the newest reading winning. | [`usage limits recorded by the person’s other coding apps still show for a chat that runs in Muster’s own home`](../../../packages/agent-app/tests/own-codex-home-720.test.ts) |
| [MUS-SPEC-03-730A](03-providers-models-and-accounts.md#mus-spec-03-730a) | Claude Code starts once in the chat folder against the router URL with the route token, the chosen model with every alias pinned to it, no Anthropic API key, Workspace's permission mode and the user's tool server; the Codex client and the Messages API are not used; the answer shows and the thread is a Claude Code thread. | [`a Workspace router Claude turn with a user tool server runs through Claude Code against the router, never the Codex client`](../../../packages/agent-app/tests/router-claude-code-730.test.ts) |
| [MUS-SPEC-03-730B](03-providers-models-and-accounts.md#mus-spec-03-730b) | The second turn resumes the first turn's Claude Code session with the new message alone. | [`the next router Claude turn resumes the same Claude Code session without a summary`](../../../packages/agent-app/tests/router-claude-code-730.test.ts) |
| [MUS-SPEC-03-730C](03-providers-models-and-accounts.md#mus-spec-03-730c) | A GPT model, a GPT combo and a connector turn on the same router run on the Codex client; only the Claude combo's turn starts Claude Code. | [`on one router, only the Claude turn runs through Claude Code; GPT models, GPT combos and connector turns stay on the Codex client`](../../../packages/agent-app/tests/router-claude-code-730.test.ts) |
| [MUS-SPEC-03-730D](03-providers-models-and-accounts.md#mus-spec-03-730d) | After a Codex turn, Claude Code starts a fresh session whose prompt carries a summary of the earlier messages; the turn after continues that session with no summary. | [`a chat whose earlier turn ran on the Codex client moves to Claude Code with a summary, then continues that session`](../../../packages/agent-app/tests/router-claude-code-730.test.ts) |
| [MUS-SPEC-03-740A](03-providers-models-and-accounts.md#mus-spec-03-740a) | With a Codex profile inherited from the parent shell, a config.toml provider route still lists its models and answers a chat with its own provider. | [`(b) a Codex config.toml provider with [auth] command: models listed and a chat answered with the command’s token`](../../../packages/agent-app/tests/provider-auth-e2e.test.ts) |

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

### Model lists that go stale

<a id="mus-spec-03-588a"></a>
#### MUS-SPEC-03-588A: A stale profile catalog does not hide newer account models

- Precondition: The ChatGPT sign-in has a profile whose `model_catalog_json` lists GPT-5.5 and GPT-5.6 Luna. Codex's own account cache (`models_cache.json`) lists those and also GPT-6.1 Sol, GPT-6 Sol and GPT-6 Luna.
- Action: Open the model list for OpenAI (ChatGPT sign-in).
- Expected result: All five models are offered, once each. The profile's models keep their order and come first; the newer ones follow in the cache's order. The route's detail line says how many came from the account cache.
- Test: `packages/agent-app/tests/codex-catalog-merge-588.test.ts::a stale profile catalog does not hide the newer models the account cache lists`
- Environment: Node test runner; a temp Codex home with a profile, a catalog, a cache and a fake sign-in.
- Known gaps: Does not run Codex. Muster does not fetch the account list itself; it reads what Codex last saved. There is no refresh button or last-updated time.
- Evidence: UNVERIFIED

<a id="mus-spec-03-588b"></a>
#### MUS-SPEC-03-588B: Hidden models and other providers' catalogs stay as they are

- Precondition: The same ChatGPT profile catalog marks one model hidden. The cache lists that model as visible, another model as hidden, and one non-OpenAI id. A second profile for a gateway lists its own models, and the cache lists others.
- Action: Open the model lists for both routes.
- Expected result: The ChatGPT route does not offer the model its catalog hides, the model the cache hides, or the non-OpenAI id. The gateway route offers exactly its own catalog.
- Test: `packages/agent-app/tests/codex-catalog-merge-588.test.ts::hidden models and non-OpenAI ids stay out of the merged list, and a gateway catalog is not extended`
- Environment: Node test runner; a temp Codex home.
- Known gaps: A model removed from the cache stays offered while the profile catalog still lists it.
- Evidence: UNVERIFIED

### Switching provider keeps the task

<a id="mus-spec-03-463a"></a>
#### MUS-SPEC-03-463A: A new provider is told the task, even after a long run of tool calls

- Precondition: A chat has a first request, eight user messages, an assistant summary and then 30 more tool rows, in a folder that is a git repo on branch `feature-x` with one untracked file.
- Action: Build the digest the new provider receives when the chat is switched to it.
- Expected result: The digest holds the first request, the last five user messages (not older ones), the last assistant summary, the branch name and the changed file. The task comes before the late tool rows and the digest stays inside its size cap. A repo hook set as `core.fsmonitor` does not run.
- Test: `packages/agent-app/tests/fork-edit.test.ts::digest on a busy turn still leads with the task: first request, last 5 user messages, last summary and git state`
- Environment: Node test runner; a temporary git repo and the `git` binary; no provider or network.
- Known gaps: Calls the digest builder directly, not through a provider switch in a running chat.
- Evidence: UNVERIFIED

### Messages that start with a dash

<a id="mus-spec-03-567a"></a>
#### MUS-SPEC-03-567A: A message starting with "-" reaches Gemini CLI as the message

- Precondition: The user sends "- fix the list bullets" to a Gemini CLI chat.
- Action: Build the Gemini CLI arguments for that message.
- Expected result: The message is passed as `--prompt=<message>` (or a value that does not start with a dash), so the CLI does not read it as options.
- Test: `packages/agent-app/tests/cli-dash-prompt.test.ts::Gemini: a prompt starting with a dash is never a separate argv token after --prompt`
- Environment: Node test runner; no network, no provider.
- Known gaps: Checks the arguments, not a run of the real Gemini CLI. The fake-CLI test in cli-agents.test.ts follows the new form.
- Evidence: UNVERIFIED

<a id="mus-spec-03-567b"></a>
#### MUS-SPEC-03-567B: A message starting with "--" reaches OpenCode as the message

- Precondition: The user sends "--version is wrong in package.json, fix it" to an OpenCode chat.
- Action: Run the OpenCode adapter with a fake process and read the arguments it spawned.
- Expected result: The argument that holds the message does not start with "-", so the CLI does not read it as an option.
- Test: `packages/agent-app/tests/cli-dash-prompt.test.ts::OpenCode: a message starting with dashes is not passed as a flag`
- Environment: Node test runner; no network, no provider. Fake child process; nothing is launched.
- Known gaps: Checks the arguments, not a run of the real OpenCode.
- Evidence: UNVERIFIED

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

### Claude models on a configured router

<a id="mus-spec-03-688a"></a>
#### MUS-SPEC-03-688A: Signed thinking is sent back unchanged across tool rounds

- Precondition: A chat on a Claude model of a configured router. The router answers in the Messages format: a thinking block with its signature, then a tool call; then a final answer.
- Action: Send one message that makes the model read a file with a tool.
- Expected result: The second request carries the first reply's thinking block, with its text and signature exactly as received, then the tool call, then the tool result. The turn completes with the final answer.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::a tool round sends the signed thinking and tool call back exactly as received`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: The router is a local fake; the live router is checked by hand (see the PR). Only Full access chats with no Project, mailbox, terminal, SSH, sandbox or user tool servers and no goal run on this route; Workspace and Read-only chats, sandbox chats and those turns stay on the Codex client.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688b"></a>
#### MUS-SPEC-03-688B: The next turn keeps the earlier turns' blocks

- Precondition: The chat from 688A finished one turn that used a tool.
- Action: Send a second message.
- Expected result: The request for the second turn holds the first turn's user message, every assistant block (thinking with signature, tool call, final text) and the tool result, unchanged, before the new message.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::the next turn resends every earlier block unchanged`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: Uses the same fake router.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688c"></a>
#### MUS-SPEC-03-688C: Redacted thinking is kept as received

- Precondition: The router's reply holds a redacted_thinking block and a tool call.
- Action: Send a message and let the tool round run.
- Expected result: The next request carries the redacted_thinking block with its data unchanged.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::redacted thinking is sent back unchanged`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688d"></a>
#### MUS-SPEC-03-688D: Thinking streams to the chat and text streams to the answer

- Precondition: The router streams thinking deltas, then text deltas.
- Action: Send a message.
- Expected result: The thinking text reaches the chat's reasoning stream, and the answer text reaches the reply, in order.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::thinking and text stream to the chat as they arrive`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: Checks the adapter's callbacks, not the rendered transcript.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688e"></a>
#### MUS-SPEC-03-688E: Tools follow the chat's access level

- Precondition: Three chats on the same Claude route: Read only, Workspace and Full access.
- Action: Send a message in each.
- Expected result: Each request offers the tools that access level allows, in the Messages tool format: Read only can only read and list, Workspace can also edit files, Full access can also run commands.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::the tools offered follow the chat's access level`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688f"></a>
#### MUS-SPEC-03-688F: A failed reply says why

- Precondition: The router answers a request with a 400 error.
- Action: Send a message.
- Expected result: The turn fails with the router's error message, and nothing is resent.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::a router error fails the turn with its message`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688g"></a>
#### MUS-SPEC-03-688G: A restart continues the same conversation

- Precondition: A chat finished a tool turn, and its conversation is saved to disk.
- Action: Start a new adapter on the same folder (as after a restart) and send the next message on the same thread.
- Expected result: The request carries the saved earlier blocks, signatures included, unchanged.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::a restart continues with the saved blocks unchanged`
- Environment: Node test runner; the adapter talks to a fake router over fetch; no network.
- Known gaps: Uses a temp folder for the saved conversation.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688h"></a>
#### MUS-SPEC-03-688H: A Claude model in a Full access chat runs over the Messages API

- Precondition: Claude Code is not installed. A Full access Agent chat on a router gateway route (a Codex configuration), model `cc/claude-opus-5-5`. The service adds its usual per-chat tool servers (browser, canvas, background commands).
- Action: Send a message.
- Expected result: The router receives a Messages request (not a Codex run) with the chat's prompt and tools; the Codex client is never started; the instructions sent do not mention tools the Messages route lacks.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::a Claude model in a Full access chat on a router gateway runs over the Messages API, with the overrides the service adds`
- Environment: Node test runner; the real service and domains with a fake router over fetch and a fake Codex client; no network.
- Known gaps: With Claude Code installed these turns run through Claude Code instead (730A). Without it, Workspace and Read-only chats, chats in a sandbox and turns with Project, mailbox, terminal, SSH or user tool servers or an active goal stay on the Codex client (688J). The canvas, background-command and computer-use tools are not offered on the Messages route.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688i"></a>
#### MUS-SPEC-03-688I: A router combo is routed by the model it really runs

- Precondition: Claude Code is not installed. Two Full access chats on a router gateway route, one on a combo (`intelligent-planner`) whose Messages answer reports `claude-opus-5-5`, one on a combo (`executor`) whose answer reports `gpt-5.6-terra`.
- Action: Send two messages in each chat, then wait past the cache window and send one more in the first.
- Expected result: The combo whose probe reports a Claude model runs over the Messages API; the one that reports a GPT model runs on Codex; each is probed once inside the cache window and again after it.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::a router combo runs over the Messages API only when its probe reports a Claude model, and the answer is cached`
- Environment: Node test runner; a fake router over fetch, a fake Codex client and a fake clock; no network.
- Known gaps: A combo that sends different requests to different backends is routed by what the probe saw. A failed probe sends the turn to Codex and is retried after one minute.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688j"></a>
#### MUS-SPEC-03-688J: Without Claude Code, Workspace chats and turns with project tools stay on Codex

- Precondition: Claude Code is not installed. A Claude model on a router gateway route. One chat has Workspace access. Another has Full access, but the turn carries a user tool server.
- Action: Send a message in each.
- Expected result: Both turns run on the Codex client; the router receives no Messages request.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::Workspace chats and turns with project tools stay on the Codex route`
- Environment: Node test runner; a fake router over fetch and a fake Codex client; no network.
- Known gaps: Claude models in these turns still hit the signed-thinking failure (#688) and the Codex client's reconnects. With Claude Code installed they run through it instead (730A).
- Evidence: UNVERIFIED

<a id="mus-spec-03-688k"></a>
#### MUS-SPEC-03-688K: Switching from Codex to the Messages route keeps the conversation

- Precondition: A chat finished one turn on the Codex client (Workspace access) and has a Codex thread. Its access is then raised to Full.
- Action: Send a second message.
- Expected result: The second turn does not resume the Codex thread; the Messages request holds a summary of the first exchange before the new message; the chat says a fresh conversation started and records the Messages thread.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::the first Messages turn after a Codex turn starts a fresh conversation with a summary, not the Codex thread`
- Environment: Node test runner; the real service with a fake router over fetch and a fake Codex client; no network.
- Known gaps: Context blocks the Codex thread held are sent again with the summary, so the first Messages turn is larger.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688l"></a>
#### MUS-SPEC-03-688L: An expired router token is refreshed once

- Precondition: A Full access chat on a Claude model of a router gateway route whose auth helper hands out a new token when asked to refresh. The router answers 401 to the old token.
- Action: Send a message.
- Expected result: The turn is retried once with a freshly fetched token and completes; the second request carries the new token.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::a 401 is retried once with a fresh token before the turn fails`
- Environment: Node test runner; a fake router over fetch; no network.
- Known gaps: A second 401 fails the turn with the router's message.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688m"></a>
#### MUS-SPEC-03-688M: A Messages-route run cut off by closing Muster needs no recovery

- Precondition: A chat was running on the Messages route when Muster closed. Another chat was running on the Codex client.
- Action: Start Muster again and reconcile the first chat.
- Expected result: The Messages-lane chat is interrupted with no recovery needed and the provider is never asked; the same chat on the Codex client still needs recovery.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::a run on the Messages lane that was open when Muster closed is interrupted, never asked about at the provider`
- Environment: Node test runner; a temporary data folder; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688n"></a>
#### MUS-SPEC-03-688N: Saved Claude history always starts with the person's message

- Precondition: A conversation with far more tool rounds than the saved history keeps, and tool results that carried images.
- Action: Save it and open it again.
- Expected result: The saved conversation starts with a user message that holds the person's own text, stays within its limits and holds no image data.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::saved Claude history never starts with an assistant message`
- Environment: Node test runner; no network.
- Known gaps: When one turn alone exceeds the limits its history is dropped, and the next turn starts with only the new message.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688o"></a>
#### MUS-SPEC-03-688O: A router hiccup before any output is retried once

- Precondition: A Claude model on a configured router. The router sometimes answers a streamed request with an error event before any content ("Claude returned an empty response"), as seen on the live router.
- Action: Send a message when the first answer is such an error, then send one whose error arrives after some text has streamed.
- Expected result: The first turn sends the same request once more and completes with the second answer. The second turn fails with the router's message and nothing is resent, because text already reached the chat. Every request asks the router for at least high effort, so tool turns keep their thinking.
- Test: `packages/agent-app/tests/claude-messages-driver.test.ts::an error event before any content is sent once more; after content it fails the turn`
- Environment: Node test runner; a scripted router; no network.
- Known gaps: Only one retry; a router that keeps failing fails the turn. The live router's effort behaviour is measured, not documented by the router.
- Evidence: UNVERIFIED

<a id="mus-spec-03-688p"></a>
#### MUS-SPEC-03-688P: The ask_user server does not move a Claude turn off the Messages API

- Precondition: A Full access Agent chat on a router gateway route, model `cc/claude-opus-5-5`. The service adds its usual per-chat tool servers, including the `muster_ask` server (#476). The router's first answer is an `ask_user` call with a default.
- Action: Send a message.
- Expected result: The turn runs over the Messages API (the Codex client never starts) and the request offers a native `ask_user` tool. The call returns at once with the default, a non-blocking question card is posted, and the turn continues and completes on the Messages lane.
- Test: `packages/agent-app/tests/claude-messages-lane.test.ts::a Full access Claude turn still runs over the Messages API when the service adds the ask_user server, and ask_user returns the default`
- Environment: Node test runner; the real service, ask_user tool host and provider adapter with a fake router over fetch and a fake Codex client; no network.
- Known gaps: The `muster_ask` MCP server itself is dropped on this lane (it has no MCP client); the native tool takes its place.
- Evidence: UNVERIFIED

<a id="mus-spec-03-716a"></a>
#### MUS-SPEC-03-716A: A chat whose router conversation expired continues on a fresh one

- Precondition: A chat on a Claude model of a router gateway route (for example `intelligent-planner`) has a saved provider thread from days earlier. The router no longer holds that conversation's Claude replay state, so resuming it is refused with HTTP 409 "replay state expired or is unavailable" before the turn starts.
- Action: Send a message.
- Expected result: Muster tries the saved thread once, then runs the same message once more on a fresh thread. The retry resumes nothing and starts with a summary of the earlier messages, then "Current user request:" and the message. The chat shows one notice that the earlier conversation could no longer be continued and a fresh one started with a summary, ends completed, and keeps the new thread. The expired-state error is not shown.
- Test: `packages/agent-app/tests/replay-expired-716.test.ts::a resumed router thread whose replay state expired starts one fresh conversation with a summary`
- Environment: Node test runner; the real service and provider adapter with a fake Codex client; no network.
- Known gaps: Recognised by the router's words, not by model id; the live router is not exercised.
- Evidence: UNVERIFIED

<a id="mus-spec-03-716b"></a>
#### MUS-SPEC-03-716B: An expired conversation is retried once, never looped

- Precondition: As MUS-SPEC-03-716A, but the router also refuses the fresh conversation with the same 409.
- Action: Send a message.
- Expected result: The provider is asked twice (the resume and one fresh attempt), never a third time. The chat shows the usual recovery notice with the provider's words, and one notice that a fresh conversation was tried.
- Test: `packages/agent-app/tests/replay-expired-716.test.ts::when the fresh conversation is refused with the same 409 there is no third attempt and the error is shown`
- Environment: Node test runner; the real service and provider adapter with a fake Codex client; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-716c"></a>
#### MUS-SPEC-03-716C: Other 409 errors and failures after output are not retried as new conversations

- Precondition: A chat with a saved provider thread. One resume is refused with a 409 that says something else; another is refused with the replay-state text but only after the turn was accepted and streamed output.
- Action: Send a message in each chat.
- Expected result: Each message reaches the provider once, no fresh conversation starts and no "fresh conversation" notice appears.
- Test: `packages/agent-app/tests/replay-expired-716.test.ts::a 409 with other text, or after the turn produced output, does not start a fresh conversation`
- Environment: Node test runner; the real service and provider adapter with a fake Codex client; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Claude tool history on a configured router

<a id="mus-spec-03-722a"></a>
#### MUS-SPEC-03-722A: A chat keeps its thread when the router lost an old tool call's replay state

- Precondition: A chat on a Claude route of a configured Responses router (for example `intelligent-planner`) ran a tool in an earlier turn. The router keeps each tool call's signed thinking itself and has since dropped it (expiry, eviction or restart), so it refuses any request whose history contains that call with HTTP 409 "replay state expired or is unavailable".
- Action: Send the next message in the chat, through Muster and the real coding client, then one more.
- Expected result: Both messages complete on the chat's original thread. The router sees one refused request and one accepted retry in which the earlier tool exchange is plain text that still contains its output; the following turn is accepted on its first request. No "fresh conversation" notice appears.
- Test: `packages/agent-app/tests/router-replay-722.test.ts::a router that lost an old tool call's replay state does not reset the chat: same thread, full history, no fresh conversation`
- Environment: Node test runner; a local mock router that applies the live router's rule; the real coding client installed (CI sets MUSTER_REQUIRE_CODEX_E2E=1 so the test cannot skip).
- Known gaps: Skips when the coding client is not installed and MUSTER_REQUIRE_CODEX_E2E is unset. Which ids are stale is remembered for the life of the coding client process; after a restart the first request is refused once more and retried.
- Evidence: UNVERIFIED

<a id="mus-spec-03-722b"></a>
#### MUS-SPEC-03-722B: Only the replay refusal is retried, once

- Precondition: The router bridge forwards a request that contains a tool exchange.
- Action: The router answers a 409 with other text; then it answers the replay refusal to both the request and its retry.
- Expected result: The other 409 reaches the client with its headers and body, after exactly one request sent unchanged. The replay refusal causes exactly one retry, with the tool exchange as plain messages that keep the output, and the second refusal is passed to the client.
- Test: `packages/agent-app/tests/router-replay-722.test.ts::the bridge retries only the replay refusal, only once, and passes every other 409 through unchanged`
- Environment: Node test runner; the bridge against a local fixture server; no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

### Changing a chat's model

<a id="mus-spec-03-724a"></a>
#### MUS-SPEC-03-724A: A switch to another provider keeps the conversation

- Precondition: A chat has exchanged messages on one provider account (for example a Codex sign-in model).
- Action: Pick a model on a different provider or account (for example a router model) and send a message; then send one more.
- Expected result: The first message on the new provider carries a summary of the earlier conversation ahead of the new text, and the chat says so in one notice. The next message continues the new provider's conversation with only its own text.
- Test: `packages/agent-app/tests/provider-switch-context-724.test.ts::switching a chat to a model on another provider keeps the conversation: the first message there carries the earlier one`
- Environment: Node test runner; the real service with a fake provider adapter that keeps its own conversations per provider; no network.
- Known gaps: The summary is bounded (first request, recent messages, last reply, recent activity and workspace state), not the full transcript.
- Evidence: UNVERIFIED

<a id="mus-spec-03-724b"></a>
#### MUS-SPEC-03-724B: Another model on the same account continues the thread

- Precondition: A chat has exchanged messages on one provider account.
- Action: Pick another model on the same account and send a message.
- Expected result: The message continues the same provider thread, with no summary added (the provider still holds the conversation).
- Test: `packages/agent-app/tests/provider-switch-context-724.test.ts::another model on the same provider account continues the same provider conversation without a summary`
- Environment: Node test runner; the real service with a fake provider adapter; no network.
- Known gaps: Guard for existing behaviour, so it passes on main by design; it keeps the fix from adding a summary where none is needed.
- Evidence: UNVERIFIED

### Muster's own coding-client home

<a id="mus-spec-03-720a"></a>
#### MUS-SPEC-03-720A: A new chat runs in Muster's own home

- Precondition: The person has a coding-client home with a sign-in or profile (here a router profile with an auth helper).
- Action: Start a chat on that profile, send a message, then a follow-up.
- Expected result: The run reaches the router through the person's profile; the thread is stored under `<dataDir>/codex-home/<id>/sessions`, the person's home gets no rollout and no thread index, the profile file is unchanged, and the follow-up continues the same thread.
- Test: `packages/agent-app/tests/own-codex-home-720.test.ts::a new chat runs in Muster’s own coding-client home: nothing is written to the person’s home, which keeps its configuration`
- Environment: Node test runner; the real service, provider adapter and installed coding client against a local mock router; temporary home and data folders.
- Known gaps: A ChatGPT sign-in kept only in the Keychain is tied to the home's path, so that route keeps the person's home; Windows without symlink rights copies shared files instead of linking them.
- Evidence: UNVERIFIED

<a id="mus-spec-03-720b"></a>
#### MUS-SPEC-03-720B: A chat from before the change keeps its thread

- Precondition: A chat ran on an earlier build, so its thread is in the person's home.
- Action: Open it on this build and send a message that depends on the earlier one.
- Expected result: The chat keeps its provider thread, the model sees the earlier message, the person's copy of the thread does not grow, and no new thread appears there.
- Test: `packages/agent-app/tests/own-codex-home-720.test.ts::a chat started before the change continues its own thread with its history, without writing to the person’s home again`
- Environment: Node test runner; the real service, provider adapter and installed coding client against a local mock router; temporary home and data folders.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-720c"></a>
#### MUS-SPEC-03-720C: Usage limits still show

- Precondition: A chat has run in Muster's own home, and another coding app has since recorded a newer rate-limit reading for the same account in the person's home.
- Action: Read the usage for that account.
- Expected result: The newer reading from the person's home is shown.
- Test: `packages/agent-app/tests/own-codex-home-720.test.ts::usage limits recorded by the person’s other coding apps still show for a chat that runs in Muster’s own home`
- Environment: Node test runner; the real service, provider adapter and installed coding client against a local mock router; temporary home and data folders.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-730a"></a>
#### MUS-SPEC-03-730A: A router Claude turn with the user's tool servers runs through Claude Code against the router

- Precondition: Claude Code is installed. A Workspace chat on a router gateway route (credentials `Bearer test-token`, base URL `router.test/v1`), model `cc/claude-opus-5-5`. The turn carries a user tool server (`projectdb`). The machine also has an Anthropic API key in its environment.
- Action: Send a message.
- Expected result: Claude Code is started once, in the chat folder, against `router.test` (base URL without `/v1`) with the route's token, the model `cc/claude-opus-5-5` and every model alias pinned to it, no Anthropic API key, Workspace's permission mode and the `projectdb` server in its tool config. The Codex client never runs and the router receives no Messages request. The chat shows Claude Code's answer and completes, and its thread is recorded as a Claude Code thread.
- Test: `packages/agent-app/tests/router-claude-code-730.test.ts::a Workspace router Claude turn with a user tool server runs through Claude Code against the router, never the Codex client`
- Environment: Node test runner; the real service, domains, provider adapter and Claude Code adapter, with a fake `claude` executable that records its arguments and environment and answers in Claude Code's stream-json; a fake router over fetch and a fake Codex client; no network.
- Known gaps: The fake executable stands in for Claude Code; the real CLI against the router was checked by hand (see #730). A route whose token is fetched by a command is read once per turn, so a token that expires during a single long turn is not refreshed mid-turn.
- Evidence: UNVERIFIED

<a id="mus-spec-03-730b"></a>
#### MUS-SPEC-03-730B: The next turn continues the same Claude Code session

- Precondition: The chat from 730A has finished one turn through Claude Code.
- Action: Send a second message.
- Expected result: Claude Code is started with `--resume` and the first turn's session id, the prompt is the new message alone (no summary of earlier messages), and the turn completes.
- Test: `packages/agent-app/tests/router-claude-code-730.test.ts::the next router Claude turn resumes the same Claude Code session without a summary`
- Environment: As 730A.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-730c"></a>
#### MUS-SPEC-03-730C: On one router, only Claude turns run through Claude Code

- Precondition: Claude Code is installed. On the same router gateway route, a Full access chat on `gpt-5.6-terra`, a Full access chat on the combo `executor` (whose probe reports a GPT model), a Full access chat on `cc/claude-opus-5-5` whose turn asks for app connectors, and a Full access chat on the combo `intelligent-planner` (whose probe reports a Claude model).
- Action: Send a message in each.
- Expected result: The GPT, GPT-combo and connector turns run on the Codex client. Claude Code is started once, for the `intelligent-planner` turn, and that chat's thread is a Claude Code thread. The router receives no Messages turn.
- Test: `packages/agent-app/tests/router-claude-code-730.test.ts::on one router, only the Claude turn runs through Claude Code; GPT models, GPT combos and connector turns stay on the Codex client`
- Environment: As 730A.
- Known gaps: App connectors are only offered by the Codex client, so a Claude turn that asks for them still runs there.
- Evidence: UNVERIFIED

<a id="mus-spec-03-730d"></a>
#### MUS-SPEC-03-730D: A chat whose earlier turns ran on the Codex client keeps its conversation on Claude Code

- Precondition: A router Claude chat finished a turn on the Codex client (before Claude Code was installed, or on an older build), so it has a Codex thread. Claude Code is now installed.
- Action: Send a message.
- Expected result: Claude Code starts a new session (no `--resume` of the Codex thread id) and its prompt holds a summary of the earlier messages ahead of the new one; the Codex client does not run; the turn after that resumes the Claude Code session with no summary.
- Test: `packages/agent-app/tests/router-claude-code-730.test.ts::a chat whose earlier turn ran on the Codex client moves to Claude Code with a summary, then continues that session`
- Environment: As 730A.
- Known gaps: None known.
- Evidence: UNVERIFIED

<a id="mus-spec-03-740a"></a>
#### MUS-SPEC-03-740A: A route ignores a Codex profile inherited from the parent shell

- Precondition: Muster starts with `MUSTER_CODEX_PROFILE` already set by its parent shell (as in a terminal opened inside Muster). The user's `config.toml` has a `[model_providers.mockroute]` table with an `[auth]` command and no catalog.
- Action: Let Muster discover the route, then send a chat on it.
- Expected result: The route lists the router's models with the command's token, and the chat completes on mockroute. Codex never tries to load the inherited profile.
- Test: `packages/agent-app/tests/provider-auth-e2e.test.ts::(b) a Codex config.toml provider with [auth] command: models listed and a chat answered with the command’s token`
- Environment: Node test runner; the real Codex binary against a local mock router; skipped when no Codex binary is installed.
- Known gaps: Covers a provider route; a profile route clears the inherited provider the same way but has no case of its own.
- Evidence: UNVERIFIED

<a id="mus-spec-03-721h"></a>
#### MUS-SPEC-03-721H: Codex installs on a clean machine without npm, Node or another app

- Precondition: No Codex on PATH or in standard locations, no other desktop app bundle, no npm and no Node (`PATH` is empty). The registry publishes `@openai/codex` with a build for this machine.
- Action: Install Codex from Settings or the setup guide (`providers.cli.update` for `codex`).
- Expected result: The latest version is read from the registry, the platform build is downloaded and checked against the registry's sha512, and the managed copy reports its version. `MUSTER_CODEX_COMMAND` points at the native binary inside its package layout, so starting it needs no Node.
- Test: `packages/agent-app/tests/cli-maintenance.test.ts::MUS-SPEC-03-721H: on a machine with no Codex, npm or Node, one click installs a Codex that runs`
- Environment: Node test runner; a local registry serving a stand-in binary; skipped on platforms with no Codex build. A manual run against the real registry is in the PR evidence.
- Known gaps: Claude Code and OpenCode still install through npm.
- Evidence: UNVERIFIED

<a id="mus-spec-03-721i"></a>
#### MUS-SPEC-03-721I: A Codex download that fails its checksum installs nothing

- Precondition: As 721H, but the registry's checksum does not match the download.
- Action: Install Codex.
- Expected result: The install fails with "nothing changed" and a reason naming the checksum; the version folder is removed and `MUSTER_CODEX_COMMAND` is unchanged.
- Test: `packages/agent-app/tests/cli-maintenance.test.ts::MUS-SPEC-03-721I: a download that fails its checksum installs nothing`
- Environment: As 721H.
- Known gaps: None known.
- Evidence: UNVERIFIED
