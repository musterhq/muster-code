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
| [MUS-SPEC-17-663A](17-usage-cost-and-ledger.md#mus-spec-17-663a) | Claude Code cache writes are priced at 1.25x input in the ledger receipt, with no estimate flag. | [`#663 Claude Code cache writes reach the ledger receipt and are priced at 1.25x the input rate`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663B](17-usage-cost-and-ledger.md#mus-spec-17-663b) | A cache-write price from Settings or the catalog wins over 1.25x input; a negative rate is refused. | [`#663 a cache-write price from Settings or the catalog wins over 1.25x input; a negative rate is refused`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663C](17-usage-cost-and-ledger.md#mus-spec-17-663c) | No cache-write price on a non-Claude model bills writes at the input rate and marks the receipt an estimate. | [`#663 a model with no cache-write price bills writes at the input rate and marks the receipt an estimate`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663D](17-usage-cost-and-ledger.md#mus-spec-17-663d) | A partial usage report marks the ledger receipt as an estimate. | [`#663 a message whose final count never arrived marks the receipt an estimate`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663E](17-usage-cost-and-ledger.md#mus-spec-17-663e) | The Dashboard prices cache writes at the cache-write rate and counts estimated turns. | [`#663 the Dashboard prices cache writes at the cache-write rate and counts estimated turns`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663F](17-usage-cost-and-ledger.md#mus-spec-17-663f) | The chat usage report carries cache-write tokens, prices them at 1.25x input, and keeps old rows. | [`#663 the chat usage report carries cache-write tokens, prices them at 1.25x input, and keeps old rows`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663G](17-usage-cost-and-ledger.md#mus-spec-17-663g) | A Receipt shows estimate beside the cost of a partial turn and nothing for a complete one. | [`#663 a Receipt says estimate when its cost is partial`](../../../packages/agent-app/tests/hub-components.tsx) |
| [MUS-SPEC-17-458A](17-usage-cost-and-ledger.md#mus-spec-17-458a) | With two approval requests accepted automatically a turn records 0 approvals; a turn that also shows a card records 1. | [`ledger approvals count only cards shown to the user, never Full-access auto-accepts`](../../../packages/agent-app/tests/ledger-history.test.ts) |

### Cache-write pricing (#663)

<a id="mus-spec-17-663a"></a>
#### MUS-SPEC-17-663A: Claude Code cache writes are priced above plain input

- Precondition: A Claude Code chat on a model whose Settings price is $3 input and $15 output per million tokens, with no cache-write price. One turn reads 200,000 cached tokens, writes 100,000 cache tokens, sends 10 fresh input tokens and receives 1,000 output tokens.
- Action: Run the turn through the Claude Code adapter (fake CLI output) and let the turn settle.
- Expected result: The receipt records 100,000 cache-write tokens inside its input total, and its cost is $0.99003: cache writes at 1.25 times the input price ($3.75 per million), cache reads and fresh input at $3, output at $15. The receipt is not marked as an estimate.
- Test: `packages/agent-app/tests/cache-write-663.test.ts::#663 Claude Code cache writes reach the ledger receipt and are priced at 1.25x the input rate`
- Environment: Node test runner; fake CLI process; temp database; no network.
- Known gaps: Prices come from Settings; no real provider bill was compared. Cache reads are priced at the input rate unless a cached-input price is set.
- Evidence: UNVERIFIED

<a id="mus-spec-17-663b"></a>
#### MUS-SPEC-17-663B: A cache-write price you set wins over the default

- Precondition: A Claude model has a Settings price with a cache-write rate of $6 per million. A catalog entry declares a cache-write rate. A third Settings price has a negative cache-write rate.
- Action: Run a turn with 100,000 cache-write tokens on the first model, read the catalog entry, and save the third price.
- Expected result: The turn costs cache writes at $6, not 1.25 times input. The catalog rate is read. The negative rate is refused with a message naming cacheWritePerMTok.
- Test: `packages/agent-app/tests/cache-write-663.test.ts::#663 a cache-write price from Settings or the catalog wins over 1.25x input; a negative rate is refused`
- Environment: Node test runner; temp files; no network.
- Known gaps: Does not drive the Settings screen; the field there is covered by the type check only.
- Evidence: UNVERIFIED

<a id="mus-spec-17-663c"></a>
#### MUS-SPEC-17-663C: A model with no cache-write price is priced at input and flagged

- Precondition: A custom model that is not a Claude model, with a Settings price of $4 input and $12 output and no cache-write rate. A turn reports 100,000 cache-write tokens inside 1,000,000 input tokens.
- Action: Let the turn settle and read its receipt.
- Expected result: Cache writes are billed at the input rate, because no other rate is known, and the receipt is marked as an estimate.
- Test: `packages/agent-app/tests/cache-write-663.test.ts::#663 a model with no cache-write price bills writes at the input rate and marks the receipt an estimate`
- Environment: Node test runner; temp database; no network.
- Known gaps: The input-rate fallback is a lower bound; the real provider rate is unknown to Muster.
- Evidence: UNVERIFIED

<a id="mus-spec-17-663d"></a>
#### MUS-SPEC-17-663D: A cut-off message marks the receipt an estimate

- Precondition: A Claude Code turn whose last message never sent its final token count, so the adapter reports it as partial. A second turn has every count.
- Action: Run both turns through the Claude Code adapter and let each settle.
- Expected result: The first receipt is marked as an estimate and still shows a cost. The second has no estimate mark.
- Test: `packages/agent-app/tests/cache-write-663.test.ts::#663 a message whose final count never arrived marks the receipt an estimate`
- Environment: Node test runner; fake CLI process; temp database.
- Known gaps: A later result that fills in the missing count does not clear the mark; the receipt stays an estimate.
- Evidence: UNVERIFIED

<a id="mus-spec-17-663e"></a>
#### MUS-SPEC-17-663E: The Dashboard prices cache writes and counts estimated turns

- Precondition: The ledger holds one turn the provider left unpriced, with 100,000 cache-write tokens on a Claude model priced at $3 input, and one priced turn marked as an estimate.
- Action: Read the Dashboard spend for the month.
- Expected result: The unpriced turn is priced with cache writes at $3.75 per million, and the spend says one turn is an estimate.
- Test: `packages/agent-app/tests/cache-write-663.test.ts::#663 the Dashboard prices cache writes at the cache-write rate and counts estimated turns`
- Environment: Node test runner; temp database.
- Known gaps: Reads the Ledger aggregates, not the Dashboard screen. Counts turns, not dollars, as estimated.
- Evidence: UNVERIFIED

<a id="mus-spec-17-663f"></a>
#### MUS-SPEC-17-663F: Usage reports carry and price cache writes

- Precondition: A Claude Code chat with a Settings price of $3 input and $15 output. An older usage table has rows but no cache-write column.
- Action: Send usage events that include 100,000 cache-write tokens, then read the chat usage report.
- Expected result: The report shows the cache-write tokens and prices them at $3.75 per million. The old table gains the column and keeps its old rows.
- Test: `packages/agent-app/tests/cache-write-663.test.ts::#663 the chat usage report carries cache-write tokens, prices them at 1.25x input, and keeps old rows`
- Environment: Node test runner; temp database.
- Known gaps: Reads the report from the handler, not from the Settings screen.
- Evidence: UNVERIFIED

<a id="mus-spec-17-663g"></a>
#### MUS-SPEC-17-663G: A Receipt says when its cost is an estimate

- Precondition: One ledger receipt marked as an estimate and one that is not.
- Action: Show both receipts on the Ledger page.
- Expected result: The marked receipt shows "estimate" beside its cost. The other does not.
- Test: `packages/agent-app/tests/hub-components.tsx::#663 a Receipt says estimate when its cost is partial`
- Environment: DOM suite (linkedom); no network.
- Known gaps: None known.
- Evidence: UNVERIFIED

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
