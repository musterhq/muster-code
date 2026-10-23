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
| [MUS-SPEC-12-560C](12-projects-orgs-and-tasks.md#mus-spec-12-560c) | On a Russian layout the physical C, G then I keys run New task and Go to Inbox; on a Dvorak-style Latin layout the typed letter still wins. | [`single-key shortcuts follow the physical letter on non-Latin layouts`](../../../packages/agent-app/tests/wave3-nav.test.ts) |

### Work shortcuts

<a id="mus-spec-12-560c"></a>
#### MUS-SPEC-12-560C: Single-key work shortcuts work on non-Latin keyboard layouts

- Precondition: The work screens are open and no text field has focus. The keyboard layout is Russian, where the physical C key types "с", G types "п" and I types "ш".
- Action: Press the physical C key; then the physical G key followed by the physical I key. Then press a key that types "j" while on the physical C position (a Latin layout such as Dvorak).
- Expected result: C starts a new task. G then I goes to the Inbox. On the Latin layout, the typed letter wins, so the "j" key moves to the next row and does not start a new task.
- Test: `packages/agent-app/tests/wave3-nav.test.ts::single-key shortcuts follow the physical letter on non-Latin layouts`
- Environment: Node test runner; no UI and no network.
- Known gaps: Unit test of the shortcut resolver with key event objects, not real key presses in a window. The resolver's use in the screens is not driven.
- Evidence: UNVERIFIED
