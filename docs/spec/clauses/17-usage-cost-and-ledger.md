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

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-17-458A](17-usage-cost-and-ledger.md#mus-spec-17-458a) | With two approval requests accepted automatically a turn records 0 approvals; a turn that also shows a card records 1. | [`ledger approvals count only cards shown to the user, never Full-access auto-accepts`](../../../packages/agent-app/tests/ledger-history.test.ts) |

### Approvals in the ledger

<a id="mus-spec-17-458a"></a>
#### MUS-SPEC-17-458A: Approvals in a turn receipt count only cards shown to the user

- Precondition: A chat in Full access, where the provider asks for approval and Muster accepts at once with no card. A second turn where an approval card is shown.
- Action: Run both turns through the ledger's run hooks and settle each one.
- Expected result: The first turn's receipt records 0 approvals. The second turn's receipt records 1.
- Test: `packages/agent-app/tests/ledger-history.test.ts::ledger approvals count only cards shown to the user, never Full-access auto-accepts`
- Environment: Node test runner; in-memory SQLite database; no provider or network.
- Known gaps: Drives the ledger's run hooks with hand-made events, not the agent service. It does not show the service sending the shown-card event when it creates a card.
- Evidence: UNVERIFIED
A PR that changes this area adds its cases here first: one row in this table, then the case block below it (see [acceptance-cases.md](../acceptance-cases.md)).

|---|---|---|
