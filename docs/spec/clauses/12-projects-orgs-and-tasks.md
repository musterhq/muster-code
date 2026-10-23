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
| [MUS-SPEC-12-557A](12-projects-orgs-and-tasks.md#mus-spec-12-557a) | An emoji or a rare character is shown whole, leading spaces are skipped, and an empty name shows a question mark. | [`an org avatar shows the whole first emoji or character of the name`](../../../packages/agent-app/tests/org-avatar-emoji.tsx) |

### Org avatars

<a id="mus-spec-12-557a"></a>
#### MUS-SPEC-12-557A: An org avatar shows the whole first character of the name

- Precondition: Orgs named "🚀 Launch", "  ragnar", "𝔸lpha" and "   " (spaces only).
- Action: Render the org avatar for each name.
- Expected result: The avatar shows 🚀, R, 𝔸 and ?. An emoji is never cut in half into a broken character.
- Test: `packages/agent-app/tests/org-avatar-emoji.tsx::an org avatar shows the whole first emoji or character of the name`
- Environment: Node and react-dom/server: the real OrgAvatar component rendered to markup; no server.
- Known gaps: Renders to static markup, so colour and size are not checked.
- Evidence: UNVERIFIED

