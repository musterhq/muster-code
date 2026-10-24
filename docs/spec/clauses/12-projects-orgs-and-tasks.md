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
| [MUS-SPEC-12-574A](12-projects-orgs-and-tasks.md#mus-spec-12-574a) | A second check-out while the first runs is refused: one worktree, one chat, one comment. | [`two simultaneous check-outs of one task make one worktree, one chat and one check-out post`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574B](12-projects-orgs-and-tasks.md#mus-spec-12-574b) | The same task asked for by id and by key is checked out once. | [`a check-out by id and one by key at the same time make one worktree`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574C](12-projects-orgs-and-tasks.md#mus-spec-12-574c) | Release is refused while a hand-back is in flight. | [`a release while a hand-back is under way is refused`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574D](12-projects-orgs-and-tasks.md#mus-spec-12-574d) | A second hand-back while one runs is refused: one push, one comment. | [`two simultaneous hand-backs of one task push once and hand back once`](../../../packages/agent-app/tests/checkout-bughunt.test.ts) |
| [MUS-SPEC-12-574E](12-projects-orgs-and-tasks.md#mus-spec-12-574e) | A device name with --> or entities reads back unchanged from the marker. | [`a device name with --> or entities survives the marker`](../../../packages/agent-app/tests/lease-marker-bughunt.test.ts) |
| [MUS-SPEC-12-683A](12-projects-orgs-and-tasks.md#mus-spec-12-683a) | When the hand-back countdown runs out, the timer callback finishes only once the hand-back has gone through, however long reading the chat takes. | [`#683 plain folder: the countdown's timer callback finishes only when the hand-back is done`](../../../packages/agent-app/tests/checkout-service.test.ts) |
| [MUS-SPEC-12-462A](12-projects-orgs-and-tasks.md#mus-spec-12-462a) | The run carries a protocol that limits stopping to user-only decisions, tells the agent to poll running work and no longer says not to wait. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-462B](12-projects-orgs-and-tasks.md#mus-spec-12-462b) | The protocol and the end-of-run line tell the agent to post the handoff comment with task_comment instead of asking. | [`G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`](../../../packages/agent-app/tests/wave4-task-tools.test.ts) |
| [MUS-SPEC-12-447A](12-projects-orgs-and-tasks.md#mus-spec-12-447a) | A check-out idle for days becomes one Needs-you item with how long it has been idle and a server note saying the same; Keep, Release and Hand back each clear it and do what they say. | [`#447 a check-out idle for days becomes ONE Needs-you item with how long, one server note, and Keep, Release and Hand back each do what they say`](../../../packages/agent-app/tests/checkout-service.test.ts) |
| [MUS-SPEC-12-556A](12-projects-orgs-and-tasks.md#mus-spec-12-556a) | After two overlapping workspace reads, the newer org's snapshot is kept when the older read finishes last. | [`a slower workspace read from before an org switch does not overwrite the newer one`](../../../packages/agent-app/tests/hub-store-race.tsx) |
| [MUS-SPEC-12-556B](12-projects-orgs-and-tasks.md#mus-spec-12-556b) | After two overlapping My work reads, a mounted component still shows the newer data. | [`a slower My work read from before an org switch does not overwrite the newer one`](../../../packages/agent-app/tests/hub-store-race.tsx) |
| [MUS-SPEC-12-556C](12-projects-orgs-and-tasks.md#mus-spec-12-556c) | Opening a task and a project in another org does not reject, leaves the route unchanged and raises an error notice with the reason. | [`a failed org switch is reported and the page stays where it was`](../../../packages/agent-app/tests/org-open-failure.tsx) |
| [MUS-SPEC-12-556D](12-projects-orgs-and-tasks.md#mus-spec-12-556d) | A failed My work read shows a Retry button; clicking it reads again and clears the error. | [`My work offers Retry after a failed read, and Retry reads again`](../../../packages/agent-app/tests/my-work-retry-dom.tsx) |
| [MUS-SPEC-12-557A](12-projects-orgs-and-tasks.md#mus-spec-12-557a) | An emoji or a rare character is shown whole, leading spaces are skipped, and an empty name shows a question mark. | [`an org avatar shows the whole first emoji or character of the name`](../../../packages/agent-app/tests/org-avatar-emoji.tsx) |
| [MUS-SPEC-12-558A](12-projects-orgs-and-tasks.md#mus-spec-12-558a) | After the chosen Group has no items left, the Inbox lists the remaining items instead of an empty list. | [`the Inbox shows the remaining items when the chosen group has none left`](../../../packages/agent-app/tests/inbox-group-stale-dom.tsx) |
| [MUS-SPEC-12-558B](12-projects-orgs-and-tasks.md#mus-spec-12-558b) | A failed impact check shows its error and a Try again button, and clicking it shows the impact list. | [`archive confirmation offers Try again after a failed impact check`](../../../packages/agent-app/tests/project-confirm-retry-dom.tsx) |
| [MUS-SPEC-12-558C](12-projects-orgs-and-tasks.md#mus-spec-12-558c) | After the runtime rejects a quiet-hours value of 9999, the field shows the saved value 8. | [`a quiet-hours value the runtime rejects is replaced by the saved value`](../../../packages/agent-app/tests/checkout-settings-reject-dom.tsx) |

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

### Hand-back of a plain folder

<a id="mus-spec-12-683a"></a>
#### MUS-SPEC-12-683A: A countdown that ran out has handed the task back

- Precondition: A task checked out into a plain folder, a file added and one edited in it, a finished turn, and the 60 second countdown running. Reading the chat is slow (150 ms), as on a loaded machine.
- Action: The countdown runs out.
- Expected result: When the timer callback has finished, the task is handed back to the reviewer with the added file listed; it is never still checked out because the hand-back was still in flight.
- Test: `packages/agent-app/tests/checkout-service.test.ts::#683 plain folder: the countdown's timer callback finishes only when the hand-back is done`
- Environment: Node test runner; the checkout service with a fake server, a fake timer and a temp folder.
- Known gaps: The real timer ignores what the callback returns. Change detection by file content was already correct and is not part of this case.
- Evidence: UNVERIFIED

<a id="mus-spec-12-447a"></a>
#### MUS-SPEC-12-447A: An idle check-out asks its owner what to do

- Precondition: A task checked out on this Mac and left alone, with the clock moving from two days to eight days and then a day more.
- Action: Check the stale check-outs and read the Inbox items, then press Keep, Release or Hand back.
- Expected result: At two days there is nothing. At eight days there is exactly one Needs-you item for the check-out ("No activity for 8 days") and one note on the server task that says "Idle for 8 days"; checking again does not add another note or item. Keep clears the item (a later quiet stretch brings it back with its own note), Release clears it and puts the task back, Hand back clears it. Activity in another chat of the same worktree means no note and no item. Nothing is handed back or released by itself.
- Test: `packages/agent-app/tests/checkout-service.test.ts::#447 a check-out idle for days becomes ONE Needs-you item with how long, one server note, and Keep, Release and Hand back each do what they say`
- Environment: Node test runner; the checkout service with a fake server and a movable clock.
- Known gaps: The Inbox row buttons and the merge into the Inbox list are not driven here; they call the same Keep, Release and Hand back service methods.
- Evidence: UNVERIFIED

### Task protocol

<a id="mus-spec-12-462a"></a>
#### MUS-SPEC-12-462A: A task run waits on running work and stops only for the user

- Precondition: A Project task is assigned to an agent and a run starts.
- Action: Read the task protocol that is sent to the agent with the run.
- Expected result: Step 6 tells the agent to stop and ask only when the user alone can decide (an approval, a credential or a product choice). For a build, tests, a deploy or a long command it tells the agent to keep its turn open and poll with a tool call. The old line "Do not wait or poll" is gone.
- Test: `packages/agent-app/tests/wave4-task-tools.test.ts::G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`
- Environment: Node test runner; temp data folder; local tool host on a loopback port; no provider or network.
- Known gaps: Checks the protocol text that the run carries. It does not show a model waiting on a build.
- Evidence: UNVERIFIED

<a id="mus-spec-12-462b"></a>
#### MUS-SPEC-12-462B: The agent posts the handoff comment itself

- Precondition: A Project task run, with run comments on.
- Action: Read the task protocol and the end-of-run line sent with the run.
- Expected result: Step 4 tells the agent to post the handoff comment itself with task_comment and never to draft it and ask the user. The end-of-run line says to post it with task_comment and not to ask whether to post.
- Test: `packages/agent-app/tests/wave4-task-tools.test.ts::G40: task runs get the muster_tasks MCP server; the host refuses callers without the token`
- Environment: Node test runner; temp data folder; local tool host on a loopback port; no provider or network.
- Known gaps: Checks the wording the run carries. There was no code path that drafts and asks, so no behaviour beyond the instructions is shown.
- Evidence: UNVERIFIED

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
