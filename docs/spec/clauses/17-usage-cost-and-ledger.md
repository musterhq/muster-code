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
| [MUS-SPEC-17-290A](17-usage-cost-and-ledger.md#mus-spec-17-290a) | A task run's Receipt lists the file the run wrote, and Outputs shows it, even when the folder's snapshot is slow. | [`S63 a slow review snapshot still lists the changed file in the Receipt and in Outputs`](../../../packages/agent-app/tests/e2e-fixes.test.ts) |

<a id="mus-spec-17-290a"></a>
#### MUS-SPEC-17-290A: A slow folder snapshot never loses the files a run changed

- Precondition: A project task with an agent that writes one file during its turn. Taking the snapshot of the folder before the turn is slow (one second per snapshot step), so it is still running when the agent starts to write.
- Action: Start the task and wait for the run to settle.
- Expected result: The run's Receipt lists the file as added, attributed to the task's owner, and Outputs lists the file.
- Test: `packages/agent-app/tests/e2e-fixes.test.ts::S63 a slow review snapshot still lists the changed file in the Receipt and in Outputs`
- Environment: Node test runner; real git, a temp repo and a git wrapper script that delays write-tree (not run on Windows).
- Known gaps: Not run on Windows. The agent is scripted, so the real model round trip is not shown.
- Evidence: UNVERIFIED
