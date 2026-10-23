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
| [MUS-SPEC-12-558A](12-projects-orgs-and-tasks.md#mus-spec-12-558a) | After the chosen Group has no items left, the Inbox lists the remaining items instead of an empty list. | [`the Inbox shows the remaining items when the chosen group has none left`](../../../packages/agent-app/tests/inbox-group-stale-dom.tsx) |
| [MUS-SPEC-12-558B](12-projects-orgs-and-tasks.md#mus-spec-12-558b) | A failed impact check shows its error and a Try again button, and clicking it shows the impact list. | [`archive confirmation offers Try again after a failed impact check`](../../../packages/agent-app/tests/project-confirm-retry-dom.tsx) |
| [MUS-SPEC-12-558C](12-projects-orgs-and-tasks.md#mus-spec-12-558c) | After the runtime rejects a quiet-hours value of 9999, the field shows the saved value 8. | [`a quiet-hours value the runtime rejects is replaced by the saved value`](../../../packages/agent-app/tests/checkout-settings-reject-dom.tsx) |

### Hub pages that recover from stale or failed states

<a id="mus-spec-12-558a"></a>
#### MUS-SPEC-12-558A: The Inbox shows what is left when the chosen group is empty

- Precondition: The Inbox has two items in groups Alpha and Beta, and the user has chosen the group Alpha.
- Action: The Alpha item is resolved, so only the Beta item is left, and the Inbox is drawn again.
- Expected result: The Inbox shows the Beta item. It does not stay empty behind a Group control that is hidden because only one group is left.
- Test: `packages/agent-app/tests/inbox-group-stale-dom.tsx::the Inbox shows the remaining items when the chosen group has none left`
- Environment: Node and linkedom: a DOM suite with the real InboxPage; no server.
- Known gaps: Does not click the Group menu back to Everything; only the fall-back is checked.
- Evidence: UNVERIFIED

<a id="mus-spec-12-558b"></a>
#### MUS-SPEC-12-558B: Archive and delete confirmations offer Try again when the impact check fails

- Precondition: The user opens the archive confirmation for a project, and the first impact check fails with "busy".
- Action: Click Try again.
- Expected result: The error is shown with a Try again button. After the click the impact check runs again and the impact list appears.
- Test: `packages/agent-app/tests/project-confirm-retry-dom.tsx::archive confirmation offers Try again after a failed impact check`
- Environment: Node and linkedom: a DOM suite with the real ConfirmProjectAction and a fake bridge; no server.
- Known gaps: Only the archive action is run; delete uses the same dialog code.
- Evidence: UNVERIFIED

<a id="mus-spec-12-558c"></a>
#### MUS-SPEC-12-558C: A rejected check-out setting is put back to the saved value

- Precondition: The Local checkouts card in Settings shows a quiet-hours value of 8, and the runtime rejects any value above 720.
- Action: Type 9999 in the field and leave it.
- Expected result: The runtime's error is reported and the field goes back to the saved 8. It does not keep showing 9999 as if saved.
- Test: `packages/agent-app/tests/checkout-settings-reject-dom.tsx::a quiet-hours value the runtime rejects is replaced by the saved value`
- Environment: Node and linkedom: a DOM suite with the real LocalCheckoutsCard and a fake bridge; no server.
- Known gaps: Only the quiet-hours field is run; the device-name field uses the same recovery code.
- Evidence: UNVERIFIED

