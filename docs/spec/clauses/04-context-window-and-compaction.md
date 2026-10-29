# MUS-SPEC-04: Context window and compaction

The context window is how much of a chat the model can read at once. Compaction shortens a long chat so it fits again. The context meter in the composer shows how full the window is.

What the user can do:
- see how full the window is, and where the size came from;
- set their own window size for a model in Settings › Models, which wins over every other source;
- compact a chat by hand at any time.

Boundaries:
- Muster compacts a chat on its own only when the window size is declared (set by the user, a model catalog, a router listing or the provider). It never compacts on a guess.
- The meter and the compaction trigger always use the same window.
- When the engine reports a window clearly smaller than the catalog or router listing (under 95% of it), the engine's window is used: it is the one the model really runs with. A report counts only for the model that made it.
- Which models exist and their prices are clause [03](03-providers-models-and-accounts.md). Token counts and cost are clause [17](17-usage-cost-and-ledger.md).

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-04-1A](04-context-window-and-compaction.md#mus-spec-04-1a) | The window comes from your setting first, then the catalog, the router listing, the provider report, observed usage and finally the 128K default. A provider report smaller than the catalog or listing wins over them. | [`#668 resolver order: override > catalog > listing > reported > observed > default`](../../../packages/agent-app/tests/context-window-668.test.ts) |
| [MUS-SPEC-04-1B](04-context-window-and-compaction.md#mus-spec-04-1b) | Observed usage raises a guessed or listed window that is too small, and never lowers a window or overrides a catalog or reported one. | [`#668 observed usage only raises a guess: it never lowers a window and never overrides a declared one`](../../../packages/agent-app/tests/context-window-668.test.ts) |
| [MUS-SPEC-04-2A](04-context-window-and-compaction.md#mus-spec-04-2a) | A chat on a default or observed window is never compacted automatically; a window you set compacts at 85%. | [`#668 a default or observed window never starts a proactive compaction; a declared one does`](../../../packages/agent-app/tests/context-window-668.test.ts) |
| [MUS-SPEC-04-2B](04-context-window-and-compaction.md#mus-spec-04-2b) | The meter shows the same window size and compaction point that the trigger uses. | [`#668 the meter and the trigger resolve the same window`](../../../packages/agent-app/tests/context-window-668.test.ts) |
| [MUS-SPEC-04-2C](04-context-window-and-compaction.md#mus-spec-04-2c) | Through a running chat on a router model with no listed window, three turns at 300K tokens each complete on the same thread with no automatic compaction and no compaction request. | [`#668 a router combo with no listed window keeps working at 300K tokens: no automatic compaction, turns complete`](../../../packages/agent-app/tests/compaction-426.test.ts) |
| [MUS-SPEC-04-5A](04-context-window-and-compaction.md#mus-spec-04-5a) | Through a running Codex chat on a model listed at 1M that Codex runs at 258,400, the meter reads 58% at 151K, marks compaction at 85% of 258,400, and Muster compacts once the chat passes 95% of 258,400. | [`#739 a Codex chat on a router model listed at 1M that Codex runs at 258,400: the meter reads the real fill and Muster compacts before the window is full`](../../../packages/agent-app/tests/engine-window-739.test.ts) |
| [MUS-SPEC-04-5B](04-context-window-and-compaction.md#mus-spec-04-5b) | Codex is launched with a compaction point of 85% of the window it reported when that window is smaller than ours, and keeps 850K when it took the 1M window. | [`#739 the compaction point Codex is launched with is never above the window Codex reported`](../../../packages/agent-app/tests/engine-window-739.test.ts) |
| [MUS-SPEC-04-5C](04-context-window-and-compaction.md#mus-spec-04-5c) | After a chat switches models, the window the old model reported no longer sets the meter, the launch or Muster's trigger; it applies again, after a restart too, when the chat switches back. | [`#739 a window one model reported never caps the model the chat switches to, and it is back when the chat switches back`](../../../packages/agent-app/tests/engine-window-739.test.ts) |
| [MUS-SPEC-04-5D](04-context-window-and-compaction.md#mus-spec-04-5d) | For a report of 950,000 (Codex took 1M) and of 258,400, the meter marks compaction at the same point Codex is launched with. | [`#739 when Codex adopts the listed window the meter and the launch agree on one compaction point`](../../../packages/agent-app/tests/engine-window-739.test.ts) |
| [MUS-SPEC-04-3A](04-context-window-and-compaction.md#mus-spec-04-3a) | On an observed window the meter reads "at least N" with no percentage and no compaction point; a default estimate is labelled as one. | [`#668 meter: observed usage reads "at least N" with no percentage; a default estimate is labelled and never compacts`](../../../packages/agent-app/tests/context-window-668.test.ts) |
| [MUS-SPEC-04-4A](04-context-window-and-compaction.md#mus-spec-04-4a) | Saved per-model windows keep only valid sizes on valid model keys; invalid sizes are refused with a plain message. | [`#668 the policy keeps valid windows per model and drops the rest`](../../../packages/agent-app/tests/context-window-668.test.ts) |
| [MUS-SPEC-04-4B](04-context-window-and-compaction.md#mus-spec-04-4b) | The Settings field accepts 1M, 1.5m, 200k and 1,000,000, and rejects text that is not a size. | [`#668 the Settings field reads 1M, 200k and 1,000,000`](../../../packages/agent-app/tests/context-window-668.test.ts) |

### Which window a chat uses

<a id="mus-spec-04-1a"></a>
#### MUS-SPEC-04-1A: Your window wins, then the declared sources, then the default

- Precondition: A model has a catalog window of 200K, a provider report of 400K, observed usage of 900K, and the user has set 1M for it.
- Action: Resolve the window for that model, then remove each source in turn. Then resolve a 200K catalog window with a 64K report, and a 1M listed window with a 258,400 report.
- Expected result: The user's 1M wins over everything. Without it, the order is catalog, router listing, provider report, observed usage, then the 128K default, and each result names its source. A report under 95% of the catalog or listing wins: 64K and 258,400, both marked as reported.
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 resolver order: override > catalog > listing > reported > observed > default`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the shared resolver directly, not through a running chat. MUS-SPEC-04-2B ties it to the meter and the trigger.
- Evidence: UNVERIFIED

<a id="mus-spec-04-1b"></a>
#### MUS-SPEC-04-1B: Observed usage only raises a guess

- Precondition: A model with no declared window, one with a 128K router listing, one with a 200K catalog window, and one with a 500K provider report.
- Action: Resolve each window after the chat has accepted 100K, 300K or 900K tokens.
- Expected result: Usage under the 128K guess changes nothing. Usage above a listed window raises it to the observed amount. A catalog window and a provider-reported window are kept.
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 observed usage only raises a guess: it never lowers a window and never overrides a declared one`
- Environment: Node test runner; no provider or network.
- Known gaps: Does not show where observed usage is recorded during a live turn.
- Evidence: UNVERIFIED

### When Muster compacts

<a id="mus-spec-04-2a"></a>
#### MUS-SPEC-04-2A: No automatic compaction on a guessed window

- Precondition: A router chat whose model lists no window has accepted about 300K tokens.
- Action: Ask the trigger where the chat should compact, with no window set, then with the user's 1M window, then with a 100K window the chat is already over.
- Expected result: With no declared window the chat never compacts on its own. With 1M it compacts at 850K (85%). With 100K and 95K used it compacts at 85K.
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 a default or observed window never starts a proactive compaction; a declared one does`
- Environment: Node test runner; no provider or network.
- Known gaps: Does not run a real compaction turn or check the "too long" error retry.
- Evidence: UNVERIFIED

<a id="mus-spec-04-2b"></a>
#### MUS-SPEC-04-2B: The meter and the trigger agree

- Precondition: A model with a 128K router listing and a user window of 1M; the chat has used about 300K tokens.
- Action: Build the composer's meter view and the compaction trigger for the same chat.
- Expected result: Both use the 1M window marked "set by you", the meter shows 30% and the meter's compaction point equals the trigger's 850K.
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 the meter and the trigger resolve the same window`
- Environment: Node test runner; renderer view model only, no DOM.
- Known gaps: Checks the meter's view model, not the rendered composer.
- Evidence: UNVERIFIED

<a id="mus-spec-04-2c"></a>
#### MUS-SPEC-04-2C: A chat on a router model with no listed window keeps working

- Precondition: A chat on an HTTP router model that lists no context window. Each turn reports 300K tokens used, past 85% of the 128K default.
- Action: Send three messages in a row through the running app.
- Expected result: All three reach the model and complete on the same provider thread. No automatic compaction row appears and the provider is never asked to compact.
- Test: `packages/agent-app/tests/compaction-426.test.ts::#668 a router combo with no listed window keeps working at 300K tokens: no automatic compaction, turns complete`
- Environment: Node test runner; the agent service with a fake provider that reports token usage; no network.
- Known gaps: Uses a fake provider, not a live router.
- Evidence: UNVERIFIED

### When the engine runs a smaller window

<a id="mus-spec-04-5a"></a>
#### MUS-SPEC-04-5A: The meter and Muster's trigger follow the window Codex runs

- Precondition: A Codex chat on a router model listed at 1M. Codex reports a 258,400 window with each turn's usage (its fallback for a model it has no metadata for).
- Action: Send a message that leaves 151K tokens in use and read the meter. Send another, then two more at 250K in use.
- Expected result: The meter shows 258,400 as the window, 58% used and compaction at 219,640. The second launch is told the reported 258,400. Under the safety net nothing compacts; past 95% of 258,400 one automatic compaction row appears, reading "250K of 258K tokens".
- Test: `packages/agent-app/tests/engine-window-739.test.ts::#739 a Codex chat on a router model listed at 1M that Codex runs at 258,400: the meter reads the real fill and Muster compacts before the window is full`
- Environment: Node test runner; the agent service with a fake Codex provider that reports usage and window; no network.
- Known gaps: Uses a fake provider, not the Codex binary; the meter is checked through its view model, not the rendered composer.
- Evidence: UNVERIFIED

<a id="mus-spec-04-5b"></a>
#### MUS-SPEC-04-5B: Codex compacts inside the window it reported

- Precondition: A Codex route whose model is listed at 1M.
- Action: Launch a chat with no reported window, then one whose last report was 258,400, then one whose last report was 950,000.
- Expected result: The first and third launches carry model_auto_compact_token_limit=850000. The second carries 219640 (85% of 258,400), never 850000.
- Test: `packages/agent-app/tests/engine-window-739.test.ts::#739 the compaction point Codex is launched with is never above the window Codex reported`
- Environment: Node test runner; the provider adapter with a fake Codex core that records launch overrides.
- Known gaps: Does not run the Codex binary, so it does not show Codex honouring the limit.
- Evidence: UNVERIFIED

<a id="mus-spec-04-5c"></a>
#### MUS-SPEC-04-5C: A reported window belongs to the model that reported it

- Precondition: A Codex chat with two router models listed at 1M. Codex runs advisor at 258,400 and says so; wide reports usage without a window, as Claude Code and HTTP routes do.
- Action: Send on advisor at 151K, switch the chat to wide, send two messages at 300K, switch back to advisor, restart Muster and read the meter.
- Expected result: On advisor the meter reads 58%. After the switch it reads 15% of 1M, wide's launch carries no reported window, 300K reads 30% and nothing compacts. Back on advisor after the restart the window is 258,400 again and the meter reads 100%.
- Test: `packages/agent-app/tests/engine-window-739.test.ts::#739 a window one model reported never caps the model the chat switches to, and it is back when the chat switches back`
- Environment: Node test runner; the agent service with a fake provider, reopened on the same data directory; no network.
- Known gaps: Uses a fake provider; the meter is checked through its view model, not the rendered composer.
- Evidence: UNVERIFIED

<a id="mus-spec-04-5d"></a>
#### MUS-SPEC-04-5D: The meter marks the point Codex compacts at

- Precondition: A Codex route whose model is listed at 1M.
- Action: Launch with a last report of 950,000, then of 258,400, and read the meter with each report.
- Expected result: For 950,000 the meter keeps the 1M window and both the meter and the launch say 850,000. For 258,400 both say 219,640.
- Test: `packages/agent-app/tests/engine-window-739.test.ts::#739 when Codex adopts the listed window the meter and the launch agree on one compaction point`
- Environment: Node test runner; the provider adapter with a fake Codex core that records launch overrides, and the meter's view model.
- Known gaps: Does not run the Codex binary.
- Evidence: UNVERIFIED

### What the meter says

<a id="mus-spec-04-3a"></a>
#### MUS-SPEC-04-3A: An observed window is not shown as 100% full

- Precondition: A chat with no declared window has used 299,984 tokens; another has used 40K.
- Action: Build the meter view for each.
- Expected result: The first reads "observed (at least 299,984)" with no percentage, no remaining count and no compaction point. The second shows 31% of the 128K estimate, is labelled as an estimate and has no compaction point.
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 meter: observed usage reads "at least N" with no percentage; a default estimate is labelled and never compacts`
- Environment: Node test runner; renderer view model only, no DOM.
- Known gaps: Checks the view model text, not the rendered tooltip.
- Evidence: UNVERIFIED

### Setting your own window

<a id="mus-spec-04-4a"></a>
#### MUS-SPEC-04-4A: Only valid window sizes are saved

- Precondition: Saved settings hold windows for a valid model key, a size of 5 tokens, a key without a provider, and a fractional size.
- Action: Load the settings, then validate 1,000,000, NaN and 999 as new sizes.
- Expected result: Only the valid model keeps its 1M window. 1,000,000 is accepted. NaN and 999 are refused with "whole number of tokens".
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 the policy keeps valid windows per model and drops the rest`
- Environment: Node test runner; no provider or network.
- Known gaps: Does not drive the Settings › Models form.
- Evidence: UNVERIFIED

<a id="mus-spec-04-4b"></a>
#### MUS-SPEC-04-4B: The Settings field reads common ways of writing a size

- Precondition: The context window field in Settings › Models.
- Action: Read "1M", "1.5m", "200k", "1,000,000", "lots" and an empty value.
- Expected result: They read as 1,000,000, 1,500,000, 200,000 and 1,000,000. "lots" and an empty value are not a size.
- Test: `packages/agent-app/tests/context-window-668.test.ts::#668 the Settings field reads 1M, 200k and 1,000,000`
- Environment: Node test runner; no provider or network.
- Known gaps: Calls the field's parser, not the rendered field.
- Evidence: UNVERIFIED
