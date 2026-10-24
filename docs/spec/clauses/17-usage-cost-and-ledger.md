# MUS-SPEC-17: Usage, cost and the ledger

Muster counts tokens and cost per turn, per chat, per agent and per Project. The ledger is the record of every turn's usage.

What the user can do:
- see tokens and cost for a turn, a chat and a Project, and in the Dashboard;
- set prices for models, including custom provider models;
- see provider rate limits and plan usage where the provider reports them.

Boundaries:
- A price set by the user wins over the catalog price, and a price change applies to new turns only.
- A turn with no known price counts as unpriced, never as free.
- Token counts match what the provider reports, counted once per model response.

## Acceptance cases

A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-17-95A](17-usage-cost-and-ledger.md#mus-spec-17-95a) | Ledger history for an imported chat names the session's model and provider, not the app default. | [`ledger history attributes imported turns to the session model and provider`](../../../packages/agent-app/tests/conversation-import.test.ts) |

### Imported chats in the ledger
<a id="mus-spec-17-95a"></a>
#### MUS-SPEC-17-95A: Imported turns are attributed to the model that ran them

- Precondition: A Codex session that ran `gpt-6-codex` on `openai` is imported into a chat that holds the app's default model.
- Action: Build the ledger history.
- Expected result: Every history entry for the imported turns has model `gpt-6-codex` and provider `openai`.
- Test: `packages/agent-app/tests/conversation-import.test.ts::ledger history attributes imported turns to the session model and provider`
- Environment: Node test runner; the agent service with a fake provider; fixture sessions in a temp folder.
- Known gaps: Turns sent in Muster after the import keep the chat's own model; that is not shown here. Imported turns carry no token counts.
- Evidence: UNVERIFIED
