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
| [MUS-SPEC-17-387A](17-usage-cost-and-ledger.md#mus-spec-17-387a) | After the agent edits one file, checks out a branch that differs in five files, and commits a new file, the Receipt lists the edited file and the committed file only.  | not written yet (#387) |
| [MUS-SPEC-17-387B](17-usage-cost-and-ledger.md#mus-spec-17-387b) | After the agent rebases its branch onto a branch that gained files, the Receipt lists only the file the agent edited.  | not written yet (#387) |
| [MUS-SPEC-17-458A](17-usage-cost-and-ledger.md#mus-spec-17-458a) | With two approval requests accepted automatically a turn records 0 approvals; a turn that also shows a card records 1. | [`ledger approvals count only cards shown to the user, never Full-access auto-accepts`](../../../packages/agent-app/tests/ledger-history.test.ts) |

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
