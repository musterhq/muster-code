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
| [MUS-SPEC-17-631A](17-usage-cost-and-ledger.md#mus-spec-17-631a) | In the model picker's All view, a provider whose limit is used up is labelled "Limit reached", the others are not, and every provider stays listed. | [`the model picker flags a provider whose usage limit is reached and keeps the others available`](../../../packages/agent-app/tests/model-picker-dom.tsx) |
| [MUS-SPEC-17-631B](17-usage-cost-and-ledger.md#mus-spec-17-631b) | The composer shows "<provider> has reached its usage limit" with the reset time, still shows it after a remount without a new read, clears when usage drops, and also warns for the short window with no reset time; no extra reads. | [`a provider that hit its usage limit shows a warning in the composer, once per limit window, with no polling`](../../../packages/agent-app/tests/model-picker-dom.tsx) |
| [MUS-SPEC-17-631C](17-usage-cost-and-ledger.md#mus-spec-17-631c) | Dismiss hides the warning in every composer for that limit window, a new window warns again, another provider's chat shows nothing, and a reset time already in the past is not treated as exhausted. | [`dismissing the usage warning hides it for that limit window in every composer; a new window warns again`](../../../packages/agent-app/tests/model-picker-dom.tsx) |

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
