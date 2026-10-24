# MUS-SPEC-11: Memory

Memory lets agents recall facts and decisions across chats. It is stored locally per user and per Project.

What the user can do:
- see what an agent recalled for a reply, and open the memory behind it;
- browse, search, edit and delete memories, and turn memory on or off per Project;
- reflect on a chat to save what was learned.

Boundaries:
- Memory never stores secrets; redaction (clause [19](19-security-and-redaction.md)) runs before anything is saved.
- One Project's memory is not recalled in another Project.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-11-471A](11-memory.md#mus-spec-11-471a) | A memory suggestion row is left out of the transcript rows while other notices stay. | [`memory offers stay out of the transcript (they live in the Memory inbox)`](../../../packages/agent-app/tests/activity.test.ts) |
| [MUS-SPEC-11-471B](11-memory.md#mus-spec-11-471b) | Five finished runs in one chat leave one listed suggestion in the Memory inbox, all five are recorded, and a restart does not reset the limit. | [`many turns in one chat list at most one offer per day, the rest are held, and the throttle survives a restart`](../../../packages/agent-app/tests/memory-run.test.ts) |
| [MUS-SPEC-11-467A](11-memory.md#mus-spec-11-467a) | A Personal rule and a Personal note about the user both reach a chat in a folder. | [`folder chats still get Personal directives and Personal facts the user already gave`](../../../packages/agent-app/tests/memory-run.test.ts) |
| [MUS-SPEC-11-467B](11-memory.md#mus-spec-11-467b) | A bare "continue" searches memory with the first request and recent user messages, ends with "continue", stays within 1,600 characters, and recalls the matching note. | [`recall query uses the task and recent user messages, so a bare "continue" still recalls`](../../../packages/agent-app/tests/memory-run.test.ts) |
| [MUS-SPEC-11-467C](11-memory.md#mus-spec-11-467c) | The default recall wait is 4,000 ms instead of 1,800 ms. | [`the default recall timeout is raised to about four seconds`](../../../packages/agent-app/tests/memory-run.test.ts) |

### Memory suggestions (#471)

<a id="mus-spec-11-471a"></a>
#### MUS-SPEC-11-471A: Memory suggestions stay out of the chat transcript

- Precondition: A chat timeline with a memory suggestion row and a compaction notice.
- Action: Build the transcript rows from the timeline.
- Expected result: Only the compaction notice is a row. The memory suggestion is not shown in the transcript.
- Test: `packages/agent-app/tests/activity.test.ts::memory offers stay out of the transcript (they live in the Memory inbox)`
- Environment: Node test runner; the renderer's timeline projection, no DOM.
- Known gaps: Checks the projection that builds the rows, not the rendered transcript. The Memory inbox list is covered by MUS-SPEC-11-471B.
- Evidence: UNVERIFIED

<a id="mus-spec-11-471b"></a>
#### MUS-SPEC-11-471B: Each chat lists at most one memory suggestion per day

- Precondition: A chat in a folder with memory set to ask before saving. Five different runs finish in it, each with a file edit and a real answer.
- Action: Let each run settle, then read the Memory inbox. Restart the memory domain and let a sixth run settle.
- Expected result: One suggestion is listed in the inbox and the other four are recorded as held rows that are not listed. After the restart the sixth run is also held, so the chat still has one listed suggestion that day.
- Test: `packages/agent-app/tests/memory-run.test.ts::many turns in one chat list at most one offer per day, the rest are held, and the throttle survives a restart`
- Environment: Node test runner; the memory domain on a temp database with a fake memory service; no network.
- Known gaps: Uses the local clock for "today" and does not cross midnight. It reads the stored rows and the inbox list, not the rendered Memory screen.
- Evidence: UNVERIFIED

### Recall in every chat (#467)

<a id="mus-spec-11-467a"></a>
#### MUS-SPEC-11-467A: Personal rules and notes reach chats in a folder or Project

- Precondition: A chat in a folder. Memory holds a Personal rule "Always answer in British English" and a Personal note "My name is Priya and I prefer pnpm over npm". The folder has no notes of its own.
- Action: Build the memory context for the message "Which package manager do I prefer, pnpm or npm?".
- Expected result: The context includes the Personal rule and the Personal note, so the agent in a folder or Project chat sees what the user already said about themselves.
- Test: `packages/agent-app/tests/memory-run.test.ts::folder chats still get Personal directives and Personal facts the user already gave`
- Environment: Node test runner; the memory domain on a temp database with a fake memory service; no network.
- Known gaps: Calls the memory prompt contributor, not a whole turn through the agent service. The composer's recall chip preview uses the same scopes but is not asserted here.
- Evidence: UNVERIFIED

<a id="mus-spec-11-467b"></a>
#### MUS-SPEC-11-467B: Recall looks at the task and recent messages, not only the latest one

- Precondition: A chat whose first message was "Build the invoice exporter with the Acme staging pipeline", then a reply, then "Use the CSV format". Memory holds a note "Acme staging pipeline needs the deploy token from vault".
- Action: Build the memory context for the message "continue". Then build it again after a 5,000-character user message, for a 5,000-character current message.
- Expected result: The search text holds the first request, the recent user messages and "continue" last, and the note about the deploy token is recalled. With very long messages the search text never goes over 1,600 characters and the current message keeps most of that space.
- Test: `packages/agent-app/tests/memory-run.test.ts::recall query uses the task and recent user messages, so a bare "continue" still recalls`
- Environment: Node test runner; the memory domain on a temp database with a fake memory service that records its search text; no network.
- Known gaps: Calls the memory prompt contributor, not a whole turn. It shows what text the memory service is asked about, not how well the real service ranks results.
- Evidence: UNVERIFIED

<a id="mus-spec-11-467c"></a>
#### MUS-SPEC-11-467C: Recall waits up to four seconds

- Precondition: The memory domain with its default settings.
- Action: Read the recall wait the domain uses by default.
- Expected result: It is 4,000 ms, so a slow memory service gets more time before the turn goes on without recall.
- Test: `packages/agent-app/tests/memory-run.test.ts::the default recall timeout is raised to about four seconds`
- Environment: Node test runner; no provider or network.
- Known gaps: Checks the value only, not a slow service being waited for. The abort of a request that runs out of time is covered by an existing test that sets its own short wait. It does not cover the memory context being sent again after a provider change: the only test for that passes on main, so it is not linked.
- Evidence: UNVERIFIED
