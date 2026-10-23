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
| [MUS-SPEC-03-463A](03-providers-models-and-accounts.md#mus-spec-03-463a) | After a busy turn full of tool rows, the digest for the new provider still holds the first request, the last five user messages, the last assistant summary and the folder's branch and changes; the repo's own hook does not run. | [`digest on a busy turn still leads with the task: first request, last 5 user messages, last summary and git state`](../../../packages/agent-app/tests/fork-edit.test.ts) |

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
