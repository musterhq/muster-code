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
| [MUS-SPEC-17-557A](17-usage-cost-and-ledger.md#mus-spec-17-557a) | 999,999 and 999,500 show as 1M, 999,499 shows as 999K, 999,950 shows as 1M. | [`token counts never read as a thousand of the next unit`](../../../packages/agent-app/tests/token-format-edges.test.ts) |
| [MUS-SPEC-17-557B](17-usage-cost-and-ledger.md#mus-spec-17-557b) | 2,500,000,000 shows as 2.5B, and counts that round up to a billion or down to 999M show the right unit. | [`very large token counts get a billions unit`](../../../packages/agent-app/tests/token-format-edges.test.ts) |
| [MUS-SPEC-17-557C](17-usage-cost-and-ledger.md#mus-spec-17-557c) | formatUsd of -5 returns a dash. | [`a negative cost is not shown as under a cent`](../../../packages/agent-app/tests/token-format-edges.test.ts) |
| [MUS-SPEC-17-557D](17-usage-cost-and-ledger.md#mus-spec-17-557d) | A receipt with 999,990 input tokens reads 1.0M, 2.5 billion reads 2.5B, and 999,960 never contains 1000. | [`a receipt never shows 1000k tokens and shows billions with a B`](../../../packages/agent-app/tests/receipt-token-format.tsx) |
| [MUS-SPEC-17-458A](17-usage-cost-and-ledger.md#mus-spec-17-458a) | With two approval requests accepted automatically a turn records 0 approvals; a turn that also shows a card records 1. | [`ledger approvals count only cards shown to the user, never Full-access auto-accepts`](../../../packages/agent-app/tests/ledger-history.test.ts) |

### Showing token counts and cost

<a id="mus-spec-17-557a"></a>
#### MUS-SPEC-17-557A: A token count never reads as a thousand of the next unit

- Precondition: Token totals just under one million, such as 999,499, 999,500 and 999,999.
- Action: Format each total for display.
- Expected result: A total that rounds up to a million shows as 1M, not 1000K. A total that rounds below it keeps the K unit.
- Test: `packages/agent-app/tests/token-format-edges.test.ts::token counts never read as a thousand of the next unit`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the formatter directly, not a screen that shows it. This is the only test for this behaviour.
- Evidence: UNVERIFIED

<a id="mus-spec-17-557b"></a>
#### MUS-SPEC-17-557B: Very large token counts show in billions

- Precondition: Token totals of 999,499,999, 999,999,999, 2.5 billion and one trillion.
- Action: Format each total for display.
- Expected result: Totals of a billion or more show a B unit, such as 2.5B. A total just under a billion shows 999M or 1B depending on rounding.
- Test: `packages/agent-app/tests/token-format-edges.test.ts::very large token counts get a billions unit`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the formatter directly, not a screen that shows it. This is the only test for this behaviour.
- Evidence: UNVERIFIED

<a id="mus-spec-17-557c"></a>
#### MUS-SPEC-17-557C: A negative cost is not shown as under a cent

- Precondition: A cost value below zero, which can come from a bad price or a bad total.
- Action: Format the cost for display.
- Expected result: The cost shows as a dash, not as "<$0.01".
- Test: `packages/agent-app/tests/token-format-edges.test.ts::a negative cost is not shown as under a cent`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the formatter directly. It does not show where a negative cost comes from.
- Evidence: UNVERIFIED

<a id="mus-spec-17-557d"></a>
#### MUS-SPEC-17-557D: A turn receipt never shows 1000k tokens

- Precondition: A turn receipt in the Hub whose input token count is 999,990, 999,960 or 2.5 billion.
- Action: Render the receipt and read its summary line.
- Expected result: The summary reads "1.0M in" for 999,990 and "2.5B in" for 2.5 billion, and never shows 1000 for 999,960.
- Test: `packages/agent-app/tests/receipt-token-format.tsx::a receipt never shows 1000k tokens and shows billions with a B`
- Environment: Node and react-dom/server: the real Receipt component rendered to markup; no server.
- Known gaps: Renders to static markup, so layout is not checked.
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
