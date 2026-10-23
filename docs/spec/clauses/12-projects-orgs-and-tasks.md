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
| [MUS-SPEC-12-572A](12-projects-orgs-and-tasks.md#mus-spec-12-572a) | A priority named like an object key is dropped, not sent. | [`creating a task ignores a priority that is an Object.prototype key`](../../../packages/agent-app/tests/protocol-bughunt.test.ts) |

<a id="mus-spec-12-572a"></a>
#### MUS-SPEC-12-572A: A task priority named like an object key is ignored

- Precondition: A workspace with one project and a fake command channel.
- Action: Create a task whose priority is constructor, toString, __proto__ or hasOwnProperty.
- Expected result: Each task is still created, and none of them carries a priority.
- Test: `packages/agent-app/tests/protocol-bughunt.test.ts::creating a task ignores a priority that is an Object.prototype key`
- Environment: Node test runner; no network.
- Known gaps: The command channel is fake. It does not use the New task form.
- Evidence: UNVERIFIED
