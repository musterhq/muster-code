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
| [MUS-SPEC-12-556A](12-projects-orgs-and-tasks.md#mus-spec-12-556a) | After two overlapping workspace reads, the newer org's snapshot is kept when the older read finishes last. | [`a slower workspace read from before an org switch does not overwrite the newer one`](../../../packages/agent-app/tests/hub-store-race.tsx) |
| [MUS-SPEC-12-556B](12-projects-orgs-and-tasks.md#mus-spec-12-556b) | After two overlapping My work reads, a mounted component still shows the newer data. | [`a slower My work read from before an org switch does not overwrite the newer one`](../../../packages/agent-app/tests/hub-store-race.tsx) |
| [MUS-SPEC-12-556C](12-projects-orgs-and-tasks.md#mus-spec-12-556c) | Opening a task and a project in another org does not reject, leaves the route unchanged and raises an error notice with the reason. | [`a failed org switch is reported and the page stays where it was`](../../../packages/agent-app/tests/org-open-failure.tsx) |
| [MUS-SPEC-12-556D](12-projects-orgs-and-tasks.md#mus-spec-12-556d) | A failed My work read shows a Retry button; clicking it reads again and clears the error. | [`My work offers Retry after a failed read, and Retry reads again`](../../../packages/agent-app/tests/my-work-retry-dom.tsx) |

### Switching org and reading My work

<a id="mus-spec-12-556a"></a>
#### MUS-SPEC-12-556A: A slower workspace read from before an org switch cannot bring the old org back

- Precondition: The Hub has started a workspace read for the old org, and the user switches org, which starts a second read.
- Action: The newer read finishes first, then the older read finishes.
- Expected result: The Hub keeps the newer org's workspace. The older read is dropped and does not bring the old org's projects and tasks back.
- Test: `packages/agent-app/tests/hub-store-race.tsx::a slower workspace read from before an org switch does not overwrite the newer one`
- Environment: Node, the real hub store and a fake bridge whose reads are finished by the test; no server.
- Known gaps: Drives the store, not a mounted Hub page, so what is drawn is not checked.
- Evidence: UNVERIFIED

<a id="mus-spec-12-556b"></a>
#### MUS-SPEC-12-556B: A slower My work read from before an org switch cannot overwrite the newer one

- Precondition: My work has started a read, and a second read is started right after (as happens after an org switch).
- Action: The second read finishes first, then the first read finishes with older data.
- Expected result: A component showing My work still shows the newer data. The older read is dropped.
- Test: `packages/agent-app/tests/hub-store-race.tsx::a slower My work read from before an org switch does not overwrite the newer one`
- Environment: Node, linkedom, a probe component using the real My work store, and a fake bridge whose reads are finished by the test; no server.
- Known gaps: Uses a small probe component, not the My work page itself.
- Evidence: UNVERIFIED

<a id="mus-spec-12-556c"></a>
#### MUS-SPEC-12-556C: A failed org switch is reported and the page stays where it was

- Precondition: The user opens a task or a project that belongs to another org, and switching to that org fails with "server unreachable".
- Action: Open the task, then open the project.
- Expected result: Both calls end normally with no unhandled error. The Hub does not move to the task or project. An error notice shows the reason.
- Test: `packages/agent-app/tests/org-open-failure.tsx::a failed org switch is reported and the page stays where it was`
- Environment: Node and a fake bridge that fails the org switch; no server.
- Known gaps: Checks the store and the notice list; the notice is not drawn. The handler that opens a task from a chat link is not run.
- Evidence: UNVERIFIED

<a id="mus-spec-12-556d"></a>
#### MUS-SPEC-12-556D: My work offers Retry after a failed read

- Precondition: The My work page is open and its first read fails.
- Action: The page shows "Your work could not be read". Click Retry.
- Expected result: A Retry button is on the page. Clicking it reads again, and the error goes away when the read works.
- Test: `packages/agent-app/tests/my-work-retry-dom.tsx::My work offers Retry after a failed read, and Retry reads again`
- Environment: Node and linkedom: a DOM suite with the real page and a fake bridge; no server.
- Known gaps: None known.
- Evidence: UNVERIFIED

