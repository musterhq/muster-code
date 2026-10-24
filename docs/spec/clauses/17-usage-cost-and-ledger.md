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
| [MUS-SPEC-17-387A](17-usage-cost-and-ledger.md#mus-spec-17-387a) | After the agent edits one file, checks out a branch that differs in five files, and commits a new file, the Receipt lists the edited file and the committed file only.  | not written yet (#387) |
| [MUS-SPEC-17-387B](17-usage-cost-and-ledger.md#mus-spec-17-387b) | After the agent rebases its branch onto a branch that gained files, the Receipt lists only the file the agent edited.  | not written yet (#387) |

### Files in a Receipt

<a id="mus-spec-17-387a"></a>
#### MUS-SPEC-17-387A: A checkout during a turn is not counted as the turn's edits

- Precondition: A Git folder on `main`. Another branch differs from `main` in five files. A turn starts with its review baseline taken.
- Action: During the turn the agent edits `a.txt`, runs `git checkout` to the other branch, then creates `d.txt` and commits it. The turn settles.
- Expected result: The Receipt lists `a.txt` as modified and `d.txt` as added. None of the five files that the checkout brought in are listed, and the count is 2.
- Test: not written yet (#387)
- Environment: Node test runner; real `git` and a temp folder; the real turn ledger hooks.
- Known gaps: Needs the HEAD reflog (on by default). A move in the same second the turn starts is not told apart from the turn's own. `git reset --soft` is read as a move, so a file edited before it and left uncommitted can be hidden.
- Evidence: UNVERIFIED

<a id="mus-spec-17-387b"></a>
#### MUS-SPEC-17-387B: A rebase during a turn is not counted as the turn's edits

- Precondition: A Git folder on a feature branch. `main` gained commits that add three files. A turn starts with its review baseline taken.
- Action: During the turn the agent edits `a.txt`, commits it and runs `git rebase main`. The turn settles.
- Expected result: The Receipt lists `a.txt` only. The three files rebased in from `main` are not listed, and neither is a file nobody edited.
- Test: not written yet (#387)
- Environment: Node test runner; real `git` and a temp folder; the real turn ledger hooks.
- Known gaps: Same as MUS-SPEC-17-387A. Merge and pull go through the same reflog path but have no test of their own.
- Evidence: UNVERIFIED
