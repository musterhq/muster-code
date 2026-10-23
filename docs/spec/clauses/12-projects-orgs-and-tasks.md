# MUS-SPEC-12: Projects, orgs, tasks and check-out

A Project groups chats, tasks and agents around shared goals. An org is the team of agents and people that works on them. This is the Paperclip-style workspace.

What the user can do:
- create Projects and orgs, hire agents into an org chart, and set their roles and budgets;
- create tasks as threads with properties (status, owner, priority, labels, sub-tasks), and see them in the Inbox, My work, All tasks, the Dashboard and the Roster;
- let an agent check out a task, work on it, and hand it back; see runs and activity.

Boundaries:
- A task is checked out by at most one agent at a time.
- Agent wakes that were waiting are not lost when Muster quits; they resume once when it opens.
- Opening an org's page switches to that org first.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-12-573A](12-projects-orgs-and-tasks.md#mus-spec-12-573a) | Two wakes asked at once leave one waiting wake and one timer. | [`two simultaneous wakes inside the minimum gap coalesce into one waiting wake and one timer`](../../../packages/agent-app/tests/wake-queue-bughunt.test.ts) |
| [MUS-SPEC-12-573B](12-projects-orgs-and-tasks.md#mus-spec-12-573b) | The gap is measured from the start of the delayed wake. | [`the minimum gap is measured from when a delayed wake actually started, not from when it was first requested`](../../../packages/agent-app/tests/wake-queue-bughunt.test.ts) |
| [MUS-SPEC-12-573C](12-projects-orgs-and-tasks.md#mus-spec-12-573c) | A wake asked during a follow-up start is joined to it, with no second run. | [`a wake asked for while a deferred follow-up is being started joins it instead of starting a second run`](../../../packages/agent-app/tests/wake-queue-bughunt.test.ts) |

<a id="mus-spec-12-573a"></a>
#### MUS-SPEC-12-573A: Two wakes in one moment join into one waiting wake

- Precondition: A wake already ran for a task, and the minimum gap of 30 s has not passed.
- Action: Ask for two more wakes for the same task at the same moment, then let the gap pass.
- Expected result: One is waiting and the other is joined to it, with one timer. After the gap one follow-up run carries both reasons.
- Test: `packages/agent-app/tests/wake-queue-bughunt.test.ts::two simultaneous wakes inside the minimum gap coalesce into one waiting wake and one timer`
- Environment: Node test runner; real governance store in a temp folder; fake clock and fake delivery.
- Known gaps: Uses a fake clock and a fake delivery. It does not start a real agent run.
- Evidence: UNVERIFIED

<a id="mus-spec-12-573b"></a>
#### MUS-SPEC-12-573B: The minimum gap counts from when a delayed wake started

- Precondition: A wake started at 0 s, and a second one asked at 10 s that runs at 30 s.
- Action: Ask for a third wake at 31 s and move the clock forward.
- Expected result: The third wake does not run until 30 s after the second one started.
- Test: `packages/agent-app/tests/wake-queue-bughunt.test.ts::the minimum gap is measured from when a delayed wake actually started, not from when it was first requested`
- Environment: Node test runner; real governance store in a temp folder; fake clock and fake delivery.
- Known gaps: Uses a fake clock and a fake delivery.
- Evidence: UNVERIFIED

<a id="mus-spec-12-573c"></a>
#### MUS-SPEC-12-573C: A wake asked while a follow-up is starting joins that follow-up

- Precondition: A task that is running, with one deferred wake waiting for it.
- Action: The run ends and, in the same moment, another wake is asked for the task.
- Expected result: No second run starts. One follow-up run carries both reasons.
- Test: `packages/agent-app/tests/wake-queue-bughunt.test.ts::a wake asked for while a deferred follow-up is being started joins it instead of starting a second run`
- Environment: Node test runner; real governance store in a temp folder; fake clock and fake delivery.
- Known gaps: Uses a fake clock and a fake delivery.
- Evidence: UNVERIFIED
