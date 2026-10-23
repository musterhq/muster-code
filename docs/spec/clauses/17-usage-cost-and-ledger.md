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
| [MUS-SPEC-17-573A](17-usage-cost-and-ledger.md#mus-spec-17-573a) | Rows removed from the end of the ledger are reported as a break. | [`verify() notices entries deleted from the end of the chain`](../../../packages/agent-app/tests/turn-ledger-bughunt.test.ts) |

<a id="mus-spec-17-573a"></a>
#### MUS-SPEC-17-573A: The ledger check notices entries cut from the end

- Precondition: A turn ledger with three entries that checks out as intact.
- Action: Delete the last row from the table, check the ledger, then delete all rows and check again.
- Expected result: The check fails and says the break is at entry 3. An emptied ledger that once had entries also fails.
- Test: `packages/agent-app/tests/turn-ledger-bughunt.test.ts::verify() notices entries deleted from the end of the chain`
- Environment: Node test runner; in-memory SQLite.
- Known gaps: The ledger is in memory. It does not show how the Dashboard words a failed check.
- Evidence: UNVERIFIED
