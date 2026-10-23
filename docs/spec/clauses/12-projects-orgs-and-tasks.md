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
| [MUS-SPEC-12-673A](12-projects-orgs-and-tasks.md#mus-spec-12-673a) | The branch is named release, not heads/release, when a tag shares the name. | [`checkout and memory name the branch when a tag shares its name`](../../../packages/agent-app/tests/branch-tag-same-name.test.ts) |
| [MUS-SPEC-12-673B](12-projects-orgs-and-tasks.md#mus-spec-12-673b) | With a detached HEAD, check-out gives the short commit id and memory records no branch. | [`a detached HEAD: checkout falls back to the short sha, memory records no branch`](../../../packages/agent-app/tests/branch-tag-same-name.test.ts) |

<a id="mus-spec-12-673a"></a>
#### MUS-SPEC-12-673A: Check-out names the branch when a tag has the same name

- Precondition: A repository on branch release with a tag also named release.
- Action: Ask check-out for the current branch name.
- Expected result: The answer is release, not heads/release.
- Test: `packages/agent-app/tests/branch-tag-same-name.test.ts::checkout and memory name the branch when a tag shares its name`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: Tests the git helper. It does not run a full check-out. The same test covers memory (MUS-SPEC-11-673A).
- Evidence: UNVERIFIED

<a id="mus-spec-12-673b"></a>
#### MUS-SPEC-12-673B: A detached HEAD gives a short commit id, and memory records no branch

- Precondition: A repository whose HEAD is detached.
- Action: Ask check-out for the branch name and read the memory evidence.
- Expected result: Check-out answers with the short commit id. Memory has a head commit and no branch.
- Test: `packages/agent-app/tests/branch-tag-same-name.test.ts::a detached HEAD: checkout falls back to the short sha, memory records no branch`
- Environment: Node test runner; git on PATH; a real repository in a temp folder.
- Known gaps: On main this file fails to load because readRepoEvidence is not exported, so the red result comes from that; the check-out half answered HEAD on main.
- Evidence: UNVERIFIED
