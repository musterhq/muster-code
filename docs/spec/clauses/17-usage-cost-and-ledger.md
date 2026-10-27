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
| [MUS-SPEC-17-398A](17-usage-cost-and-ledger.md#mus-spec-17-398a) | Integrity details are collapsed with a plain-language summary. | [`ledger integrity jargon starts behind a details toggle`](../../../packages/agent-app/tests/ui-sweep-dom.tsx) |
| [MUS-SPEC-17-387A](17-usage-cost-and-ledger.md#mus-spec-17-387a) | After the agent edits one file, checks out a branch that differs in five files, and commits a new file, the Receipt lists the edited file and the committed file only. | [`#387 a checkout during a turn is not counted as the turn's edits; the agent's own edit and commit are`](../../../packages/agent-app/tests/ledger-files-387.test.ts) |
| [MUS-SPEC-17-387B](17-usage-cost-and-ledger.md#mus-spec-17-387b) | After the agent rebases its branch onto a branch that gained files, the Receipt lists only the file the agent edited. | [`#387 a rebase during a turn adds none of the rebased-in files to the Receipt`](../../../packages/agent-app/tests/ledger-files-387.test.ts) |
| [MUS-SPEC-17-458A](17-usage-cost-and-ledger.md#mus-spec-17-458a) | With two approval requests accepted automatically a turn records 0 approvals; a turn that also shows a card records 1. | [`ledger approvals count only cards shown to the user, never Full-access auto-accepts`](../../../packages/agent-app/tests/ledger-history.test.ts) |
| [MUS-SPEC-17-573A](17-usage-cost-and-ledger.md#mus-spec-17-573a) | Rows removed from the end of the ledger are reported as a break. | [`verify() notices entries deleted from the end of the chain`](../../../packages/agent-app/tests/turn-ledger-bughunt.test.ts) |
| [MUS-SPEC-17-631A](17-usage-cost-and-ledger.md#mus-spec-17-631a) | In the model picker's All view, a provider whose limit is used up is labelled "Limit reached", the others are not, and every provider stays listed. | [`the model picker flags a provider whose usage limit is reached and keeps the others available`](../../../packages/agent-app/tests/model-picker-dom.tsx) |
| [MUS-SPEC-17-631B](17-usage-cost-and-ledger.md#mus-spec-17-631b) | The composer shows "<provider> has reached its usage limit" with the reset time, still shows it after a remount without a new read, clears when usage drops, and also warns for the short window with no reset time; no extra reads. | [`a provider that hit its usage limit shows a warning in the composer, once per limit window, with no polling`](../../../packages/agent-app/tests/model-picker-dom.tsx) |
| [MUS-SPEC-17-631C](17-usage-cost-and-ledger.md#mus-spec-17-631c) | Dismiss hides the warning in every composer for that limit window, a new window warns again, another provider's chat shows nothing, and a reset time already in the past is not treated as exhausted. | [`dismissing the usage warning hides it for that limit window in every composer; a new window warns again`](../../../packages/agent-app/tests/model-picker-dom.tsx) |
| [MUS-SPEC-17-557A](17-usage-cost-and-ledger.md#mus-spec-17-557a) | 999,999 and 999,500 show as 1M, 999,499 shows as 999K, 999,950 shows as 1M. | [`token counts never read as a thousand of the next unit`](../../../packages/agent-app/tests/token-format-edges.test.ts) |
| [MUS-SPEC-17-557B](17-usage-cost-and-ledger.md#mus-spec-17-557b) | 2,500,000,000 shows as 2.5B, and counts that round up to a billion or down to 999M show the right unit. | [`very large token counts get a billions unit`](../../../packages/agent-app/tests/token-format-edges.test.ts) |
| [MUS-SPEC-17-557C](17-usage-cost-and-ledger.md#mus-spec-17-557c) | formatUsd of -5 returns a dash. | [`a negative cost is not shown as under a cent`](../../../packages/agent-app/tests/token-format-edges.test.ts) |
| [MUS-SPEC-17-557D](17-usage-cost-and-ledger.md#mus-spec-17-557d) | A receipt with 999,990 input tokens reads 1.0M, 2.5 billion reads 2.5B, and 999,960 never contains 1000. | [`a receipt never shows 1000k tokens and shows billions with a B`](../../../packages/agent-app/tests/receipt-token-format.tsx) |
| [MUS-SPEC-17-179A](17-usage-cost-and-ledger.md#mus-spec-17-179a) | After the newest receipt rows are deleted, the chain check fails and points at the first removed entry. | [`deleting the newest receipts is reported by verify`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-179B](17-usage-cost-and-ledger.md#mus-spec-17-179b) | After the whole chain is rewritten with valid hashes, the chain check fails because the head no longer matches the saved head. | [`a fully rewritten chain is reported by verify`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-179C](17-usage-cost-and-ledger.md#mus-spec-17-179c) | A ledger written before the saved head existed adopts its current head, then reports a later truncation; a new receipt does not hide an earlier truncation. | [`an older ledger adopts its head and a later receipt cannot hide a truncation`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-179D](17-usage-cost-and-ledger.md#mus-spec-17-179d) | A receipt whose save fails partway leaves nothing half-written: the check still passes and the next receipt chains on. | [`a receipt that fails to save leaves the ledger passing`](../../../packages/agent-app/tests/turn-ledger-anchor-179.test.ts) |
| [MUS-SPEC-17-95A](17-usage-cost-and-ledger.md#mus-spec-17-95a) | Ledger history for an imported chat names the session's model and provider, not the app default. | [`ledger history attributes imported turns to the session model and provider`](../../../packages/agent-app/tests/conversation-import.test.ts) |
| [MUS-SPEC-17-663A](17-usage-cost-and-ledger.md#mus-spec-17-663a) | Claude Code cache writes are priced at 1.25x input in the ledger receipt, with no estimate flag. | [`#663 Claude Code cache writes reach the ledger receipt and are priced at 1.25x the input rate`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663B](17-usage-cost-and-ledger.md#mus-spec-17-663b) | A cache-write price from Settings or the catalog wins over 1.25x input; a negative rate is refused. | [`#663 a cache-write price from Settings or the catalog wins over 1.25x input; a negative rate is refused`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663C](17-usage-cost-and-ledger.md#mus-spec-17-663c) | No cache-write price on a non-Claude model bills writes at the input rate and marks the receipt an estimate. | [`#663 a model with no cache-write price bills writes at the input rate and marks the receipt an estimate`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663D](17-usage-cost-and-ledger.md#mus-spec-17-663d) | A partial usage report marks the ledger receipt as an estimate. | [`#663 a message whose final count never arrived marks the receipt an estimate`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663E](17-usage-cost-and-ledger.md#mus-spec-17-663e) | The Dashboard prices cache writes at the cache-write rate and counts estimated turns. | [`#663 the Dashboard prices cache writes at the cache-write rate and counts estimated turns`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663F](17-usage-cost-and-ledger.md#mus-spec-17-663f) | The chat usage report carries cache-write tokens, prices them at 1.25x input, and keeps old rows. | [`#663 the chat usage report carries cache-write tokens, prices them at 1.25x input, and keeps old rows`](../../../packages/agent-app/tests/cache-write-663.test.ts) |
| [MUS-SPEC-17-663G](17-usage-cost-and-ledger.md#mus-spec-17-663g) | A Receipt shows estimate beside the cost of a partial turn and nothing for a complete one. | [`#663 a Receipt says estimate when its cost is partial`](../../../packages/agent-app/tests/hub-components.tsx) |

### Files in a Receipt

<a id="mus-spec-17-387a"></a>
#### MUS-SPEC-17-387A: A checkout during a turn is not counted as the turn's edits

- Precondition: A Git folder on `main`. Another branch differs from `main` in five files. A turn starts with its review baseline taken.
- Action: During the turn the agent edits `a.txt`, runs `git checkout` to the other branch, then creates `d.txt` and commits it. The turn settles.
- Expected result: The Receipt lists `a.txt` as modified and `d.txt` as added. None of the five files that the checkout brought in are listed, and the count is 2.
- Test: `packages/agent-app/tests/ledger-files-387.test.ts::#387 a checkout during a turn is not counted as the turn's edits; the agent's own edit and commit are`
- Environment: Node test runner; real `git` and a temp folder; the real turn ledger hooks.
- Known gaps: The turn's own commits are found by commit time (whole seconds), so a commit made in the second the turn starts counts as the turn's. A file edited before a `git reset --soft` and left uncommitted still shows, since it differs from HEAD.
- Evidence: UNVERIFIED

<a id="mus-spec-17-387b"></a>
#### MUS-SPEC-17-387B: A rebase during a turn is not counted as the turn's edits

- Precondition: A Git folder on a feature branch. `main` gained commits that add three files. A turn starts with its review baseline taken.
- Action: During the turn the agent edits `a.txt`, commits it and runs `git rebase main`. The turn settles.
- Expected result: The Receipt lists `a.txt` only. The three files rebased in from `main` are not listed, and neither is a file nobody edited.
- Test: `packages/agent-app/tests/ledger-files-387.test.ts::#387 a rebase during a turn adds none of the rebased-in files to the Receipt`
- Environment: Node test runner; real `git` and a temp folder; the real turn ledger hooks.
- Known gaps: Same as MUS-SPEC-17-387A. Merge and pull take the same path but have no test of their own.
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

<a id="mus-spec-17-573a"></a>
#### MUS-SPEC-17-573A: The ledger check notices entries cut from the end

- Precondition: A turn ledger with three entries that checks out as intact.
- Action: Delete the last row from the table, check the ledger, then delete all rows and check again.
- Expected result: The check fails and says the break is at entry 3. An emptied ledger that once had entries also fails.
- Test: `packages/agent-app/tests/turn-ledger-bughunt.test.ts::verify() notices entries deleted from the end of the chain`
- Environment: Node test runner; in-memory SQLite.
- Known gaps: The ledger is in memory. It does not show how the Dashboard words a failed check.
- Evidence: UNVERIFIED

### Provider usage limit warning

<a id="mus-spec-17-631a"></a>
#### MUS-SPEC-17-631A: The model picker marks a provider whose limit is used up

- Precondition: Three providers are listed. The provider's usage report says its monthly limit is 100% used and resets in an hour. The other two report nothing.
- Action: Open the model picker and look at the "All providers" view.
- Expected result: The section header of the used-up provider reads "Limit reached". The other two headers have no such label and all three providers stay listed, so the user can pick another provider.
- Test: `packages/agent-app/tests/model-picker-dom.tsx::the model picker flags a provider whose usage limit is reached and keeps the others available`
- Environment: DOM suite (`linkedom`); a fake `providers.usage` answer; no network or real provider.
- Known gaps: Shows the label only, not what the provider really returns. It does not show that a send to the used-up provider is blocked; the warning does not block sending.
- Evidence: UNVERIFIED

<a id="mus-spec-17-631b"></a>
#### MUS-SPEC-17-631B: The composer warns when the chosen provider has hit its limit

- Precondition: The selected provider (ChatGPT) reports 100% used on its monthly window, with a reset time in the future.
- Action: Show the composer's usage warning. Switch to another chat so the composer mounts again. Then send a live usage update that drops usage to 21%, and then one that reports the 5-hour window at 100% with no reset time.
- Expected result: The warning reads "ChatGPT has reached its usage limit · resets <time>. Choose a model from another provider to send now." with a Dismiss button. It comes back after the remount without reading usage again. At 21% it disappears. At 100% with no reset time it shows again with "reset time not reported". Live updates never cause a new read.
- Test: `packages/agent-app/tests/model-picker-dom.tsx::a provider that hit its usage limit shows a warning in the composer, once per limit window, with no polling`
- Environment: DOM suite (`linkedom`); a fake usage answer and fake live usage events.
- Known gaps: Mounts the warning component on its own, not inside the full composer, so it does not show where it sits in the composer. It does not show a real provider report.
- Evidence: UNVERIFIED

<a id="mus-spec-17-631c"></a>
#### MUS-SPEC-17-631C: Dismissing the warning lasts for that limit window only

- Precondition: The warning for ChatGPT is showing (the 5-hour window is at 100% with no reset time).
- Action: Click Dismiss. Mount the composer again. Send a usage update with a new reset time a minute away. Show the warning for another provider. Then check a report whose reset time is already in the past.
- Expected result: Dismiss hides the warning, and it stays hidden after a remount. A new limit window with a new reset time shows it again ("resets in 1 min"). A chat on another provider shows nothing. A reset time in the past does not count as exhausted. Remounts and dismissals add no event listeners and no extra reads.
- Test: `packages/agent-app/tests/model-picker-dom.tsx::dismissing the usage warning hides it for that limit window in every composer; a new window warns again`
- Environment: DOM suite (`linkedom`); fake usage answers and events.
- Known gaps: One check covers several steps, so a failure does not say which step broke, and it starts from the state MUS-SPEC-17-631B leaves. The dismissal lives in memory only, so it is gone after a restart.
- Evidence: UNVERIFIED

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

<a id="mus-spec-17-398a"></a>
#### MUS-SPEC-17-398A: Ledger integrity jargon starts behind a details toggle

- Precondition: The ledger has a verified chain.
- Action: Open the ledger.
- Expected result: Integrity details are collapsed with a plain-language summary.
- Test: `packages/agent-app/tests/ui-sweep-dom.tsx::ledger integrity jargon starts behind a details toggle`
- Environment: Node and linkedom with the real renderer and a fixture bridge; responsive navigation uses a window media-query fixture. No desktop app or network.
- Known gaps: Does not exercise a live provider or imported history database. Visual layout is checked separately in a browser harness.
- Evidence: UNVERIFIED
