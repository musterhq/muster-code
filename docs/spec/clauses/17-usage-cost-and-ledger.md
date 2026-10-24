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
| [MUS-SPEC-17-179A](17-usage-cost-and-ledger.md#mus-spec-17-179a) | After the newest receipt rows are deleted, the chain check fails and points at the first removed entry. | [`deleting the newest receipts is reported by verify`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-179B](17-usage-cost-and-ledger.md#mus-spec-17-179b) | After the whole chain is rewritten with valid hashes, the chain check fails because the head no longer matches the saved head. | [`a fully rewritten chain is reported by verify`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-179C](17-usage-cost-and-ledger.md#mus-spec-17-179c) | A ledger written before the saved head existed adopts its current head, then reports a later truncation; a new receipt does not hide an earlier truncation. | [`an older ledger adopts its head and a later receipt cannot hide a truncation`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-179D](17-usage-cost-and-ledger.md#mus-spec-17-179d) | A receipt whose save fails partway leaves nothing half-written: the check still passes and the next receipt chains on. | [`a receipt that fails to save leaves the ledger passing`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |

### Ledger head anchor

<a id="mus-spec-17-179a"></a>
#### MUS-SPEC-17-179A: Deleting the newest receipts fails the chain check

- Precondition: a ledger with three receipts.
- Action: delete the newest receipt row directly in the database, then run the chain check.
- Expected result: the check fails (`ok` is false), and `brokenAt` is the entry number of the removed receipt. With nothing deleted it passes.
- Test: `packages/agent-app/tests/turn-ledger-anchor-179.test.ts::deleting the newest receipts is reported by verify`
- Environment: Node with `node:sqlite`, in-memory database.
- Known gaps: someone who can edit the database file can also edit the saved head, which lives in the same database file.
- Evidence: UNVERIFIED

<a id="mus-spec-17-179b"></a>
#### MUS-SPEC-17-179B: A rewritten chain fails the chain check

- Precondition: a ledger with three receipts.
- Action: replace every receipt with different content and recompute all hashes so the chain links up, then run the chain check.
- Expected result: the check fails, because the new head is not the head saved when the last receipt was written.
- Test: `packages/agent-app/tests/turn-ledger-anchor-179.test.ts::a fully rewritten chain is reported by verify`
- Environment: Node with `node:sqlite`, in-memory database.
- Known gaps: same as 179A: the saved head sits in the same database file.
- Evidence: UNVERIFIED

<a id="mus-spec-17-179c"></a>
#### MUS-SPEC-17-179C: Older ledgers are adopted, and later receipts cannot hide a truncation

- Precondition: a ledger created before the saved head existed (the head record is missing), and a second ledger whose newest receipt was deleted.
- Action: open the older ledger and check it, then delete its newest receipt and check again. On the second ledger, append a new receipt after the deletion and check again.
- Expected result: the older ledger passes on first open, then fails after the deletion. On the second ledger the check still fails after the new receipt was appended.
- Test: `packages/agent-app/tests/turn-ledger-anchor-179.test.ts::an older ledger adopts its head and a later receipt cannot hide a truncation`
- Environment: Node with `node:sqlite`, in-memory database.
- Known gaps: an older ledger that was already truncated before this version first opened it cannot be told apart from an intact one.
- Evidence: UNVERIFIED

<a id="mus-spec-17-179d"></a>
#### MUS-SPEC-17-179D: A failed save leaves the ledger consistent

- Precondition: a ledger with two receipts.
- Action: make the saved-head update fail right after a receipt row is written (as a crash or a full disk would), finish that turn, then finish one more turn normally.
- Expected result: the failed save leaves no receipt behind and the chain check still passes with two entries; the next turn is saved and the check passes with three.
- Test: `packages/agent-app/tests/turn-ledger-anchor-179.test.ts::a receipt that fails to save leaves the ledger passing`
- Environment: Node with `node:sqlite`, in-memory database.
- Known gaps: a real power loss is simulated by a database trigger that fails the update, not by killing the process.
- Evidence: UNVERIFIED
