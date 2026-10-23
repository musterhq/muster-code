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
| [MUS-SPEC-03-567A](03-providers-models-and-accounts.md#mus-spec-03-567a) | The Gemini arguments carry the whole message in `--prompt=…` or as a token that does not start with "-". | [`Gemini: a prompt starting with a dash is never a separate argv token after --prompt`](../../../packages/agent-app/tests/cli-dash-prompt.test.ts) |
| [MUS-SPEC-03-567B](03-providers-models-and-accounts.md#mus-spec-03-567b) | For the message "--version is wrong in package.json, fix it" the OpenCode argument holding it does not start with a dash. | [`OpenCode: a message starting with dashes is not passed as a flag`](../../../packages/agent-app/tests/cli-dash-prompt.test.ts) |

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
