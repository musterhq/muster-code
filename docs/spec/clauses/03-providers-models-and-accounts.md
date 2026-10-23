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

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
