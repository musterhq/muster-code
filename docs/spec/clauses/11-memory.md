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
