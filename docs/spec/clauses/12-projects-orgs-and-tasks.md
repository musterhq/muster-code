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
| [MUS-SPEC-12-574A](12-projects-orgs-and-tasks.md#mus-spec-12-574a) | A second check-out while the first runs is refused: one worktree, one chat, one comment. | [`two simultaneous check-outs of one task make one worktree, one chat and one check-out post`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574B](12-projects-orgs-and-tasks.md#mus-spec-12-574b) | The same task asked for by id and by key is checked out once. | [`a check-out by id and one by key at the same time make one worktree`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574C](12-projects-orgs-and-tasks.md#mus-spec-12-574c) | Release is refused while a hand-back is in flight. | [`a release while a hand-back is under way is refused`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574D](12-projects-orgs-and-tasks.md#mus-spec-12-574d) | A second hand-back while one runs is refused: one push, one comment. | [`two simultaneous hand-backs of one task push once and hand back once`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574E](12-projects-orgs-and-tasks.md#mus-spec-12-574e) | A device name with --> or entities reads back unchanged from the marker. | [`a device name with --> or entities survives the marker`](../../../packages/agent-app/tests/lease-marker-bughunt.test.ts) |

<a id="mus-spec-12-574a"></a>
#### MUS-SPEC-12-574A: Two check-outs of one task at once make one check-out

- Precondition: A task assigned to the user and a project bound to a repository.
- Action: Start the check-out twice at the same moment.
- Expected result: One start succeeds and the other is refused. There is one worktree, one chat and one check-out comment.
- Test: `packages/agent-app/tests/checkout-bughunt.test.ts::two simultaneous check-outs of one task make one worktree, one chat and one check-out post`
- Environment: Node test runner; fake Muster Server, in-memory SQLite and a fake git.
- Known gaps: The server and git are fakes. It does not click the Check out button.
- Evidence: UNVERIFIED

<a id="mus-spec-12-574b"></a>
#### MUS-SPEC-12-574B: A check-out by id and one by key at once make one check-out

- Precondition: A task with an id (t1) and a key (RAG-1).
- Action: Start a check-out by id and another by key at the same moment, then release and check out again.
- Expected result: Only one start succeeds and one worktree is made. After the release the task can be checked out again.
- Test: `packages/agent-app/tests/checkout-bughunt.test.ts::a check-out by id and one by key at the same time make one worktree`
- Environment: Node test runner; fake Muster Server, in-memory SQLite and a fake git.
- Known gaps: The server and git are fakes.
- Evidence: UNVERIFIED

<a id="mus-spec-12-574c"></a>
#### MUS-SPEC-12-574C: A release during a hand-back is refused

- Precondition: A checked-out task whose first turn is complete.
- Action: Start a hand-back and release the task before it finishes.
- Expected result: The release is refused with "being handed back". The hand-back finishes and posts one hand-back comment.
- Test: `packages/agent-app/tests/checkout-bughunt.test.ts::a release while a hand-back is under way is refused`
- Environment: Node test runner; fake Muster Server, in-memory SQLite and a fake git.
- Known gaps: The server and git are fakes.
- Evidence: UNVERIFIED

<a id="mus-spec-12-574d"></a>
#### MUS-SPEC-12-574D: Two hand-backs of one task at once push once

- Precondition: A checked-out task whose first turn is complete.
- Action: Start two hand-backs of the task at the same moment.
- Expected result: One succeeds and the other is refused. The branch is pushed once and one hand-back comment is posted.
- Test: `packages/agent-app/tests/checkout-bughunt.test.ts::two simultaneous hand-backs of one task push once and hand back once`
- Environment: Node test runner; fake Muster Server, in-memory SQLite and a fake git.
- Known gaps: The server and git are fakes.
- Evidence: UNVERIFIED

<a id="mus-spec-12-574e"></a>
#### MUS-SPEC-12-574E: A device name survives the check-out marker

- Precondition: Device names such as "Mac --> office", `a "quoted" & <b> name`, "x--&gt;y" and "&amp;quot;".
- Action: Write each into a check-out marker and read the marker back.
- Expected result: The device name that comes back is exactly the one that went in.
- Test: `packages/agent-app/tests/lease-marker-bughunt.test.ts::a device name with --> or entities survives the marker`
- Environment: Node test runner; no network.
- Known gaps: Unit test of the marker writer and reader. It does not post a real comment.
- Evidence: UNVERIFIED
